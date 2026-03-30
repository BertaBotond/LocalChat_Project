//!Module-ok importálása
require('dotenv').config();
const { initializeSecureLogging, logEvent } = require('./logging/secure-log.js');

initializeSecureLogging();

const express = require('express'); //?npm install express
const session = require('express-session'); //?npm install express-session
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const database = require('./sql/database.js');
const { getRuntimeConfig, getIpRange } = require('./config/runtime.js');
const { isLanIp } = require('./config/network.js');
const { createDiscoveryService } = require('./discovery/discovery.js');
const { runStartupSmokeTests } = require('./security/startup-smoke.js');
const {
    normalizeString,
    normalizeIdentity,
    isValidUsername,
    normalizeMessageType,
    clampMessageContentByType,
    isSafeRoomId
} = require('./security/validation.js');
const { AgarRoom } = require('./games/arcade-rooms.js');

//!Beállítások
const app = express();
const router = express.Router();
const runtimeConfig = getRuntimeConfig();
const connectedUsers = new Map();
const activeArcadeRooms = new Map();
let io;
let discoveryService;
let snapshotTimer;

const ip = runtimeConfig.serverHost;
const port = runtimeConfig.serverPort;
const maxJsonBodyMb = Number(process.env.MAX_JSON_BODY_MB) || 1;
const httpRateLimitPerMin = Number(process.env.HTTP_RATE_LIMIT_PER_MIN) || 240;
const socketMessagesPer10s = Number(process.env.SOCKET_MESSAGES_PER_10S) || 30;
const socketMinMessageIntervalMs = Number(process.env.SOCKET_MIN_MESSAGE_INTERVAL_MS) || 500;
const socketDuplicateCooldownMs = Number(process.env.SOCKET_DUPLICATE_COOLDOWN_MS) || 15000;
const socketSpamBlockMs = Number(process.env.SOCKET_SPAM_BLOCK_MS) || 30000;
const maxPortFallbackSteps = Math.max(0, Number(process.env.PORT_FALLBACK_STEPS) || 8);
const startupSmokeStrict = (process.env.STARTUP_SMOKE_STRICT || 'false').toLowerCase() === 'true';
const autoSnapshotIntervalMs = Math.max(15000, Number(process.env.AUTO_SNAPSHOT_INTERVAL_MS) || 60000);

app.use(express.json({ limit: `${maxJsonBodyMb}mb` })); //?Middleware JSON
app.set('trust proxy', 1); //?Middleware Proxy

app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'"
    );
    next();
});

const requestLimiter = new Map();

setInterval(() => {
    const now = Date.now();

    for (const [key, value] of requestLimiter.entries()) {
        const windowStart = Number(value?.windowStart || 0);
        if (now - windowStart > 2 * 60 * 1000) {
            requestLimiter.delete(key);
        }
    }
}, 60 * 1000).unref?.();

app.use((request, response, next) => {
    const key = normalizeClientIp(request.ip || request.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000;
    const bucket = requestLimiter.get(key) || { count: 0, windowStart: now };

    if (now - bucket.windowStart > windowMs) {
        bucket.count = 0;
        bucket.windowStart = now;
    }

    bucket.count += 1;
    requestLimiter.set(key, bucket);

    if (bucket.count > httpRateLimitPerMin) {
        logEvent('security-http-rate-limit', {
            clientIp: key,
            route: request.originalUrl || request.url,
            method: request.method,
            count: bucket.count
        });
        response.status(429).json({ message: 'Tul sok keres, probald ujra kesobb.' });
        return;
    }

    next();
});

//!Session beállítása:
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(
    session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: false,
            maxAge: 12 * 60 * 60 * 1000
        }
    })
);

//!Routing
//?Főoldal:
router.get('/', (request, response) => {
    response.sendFile(path.join(__dirname, '../frontend/html/index.html'));
});

router.get('/admin', (request, response) => {
    response.sendFile(path.join(__dirname, '../frontend/html/admin.html'));
});

router.get('/health', (request, response) => {
    response.status(200).json({ status: 'ok' });
});

function normalizeClientIp(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') {
        return '';
    }

    let value = rawValue;

    if (value.includes(',')) {
        value = value.split(',')[0].trim();
    }

    if (value.startsWith('::ffff:')) {
        value = value.replace('::ffff:', '');
    }

    return value;
}

function isAllowedClientIp(rawValue) {
    const normalized = normalizeClientIp(rawValue);

    if (!runtimeConfig.lanOnly) {
        return true;
    }

    return isLanIp(normalized);
}

function getConnectedUsers() {
    return Array.from(connectedUsers.values());
}

function getConnectedIps() {
    return getConnectedUsers()
        .map((item) => item.clientIp)
        .filter((item) => typeof item === 'string' && item.length > 0);
}

async function emitUsersUpdate() {
    io.emit('usersUpdate', getConnectedUsers());
}

async function emitHostsUpdate() {
    const hosts = await database.getHostStatuses();
    const connectedIps = new Set(
        getConnectedUsers().map((item) => item.clientIp).filter((item) => item && item.length > 0)
    );

    io.emit(
        'hostsUpdate',
        hosts.map((host) => ({
            ...host,
            chatConnected: connectedIps.has(host.ip)
        }))
    );
}

function setupSocketServer(httpServer) {
    io = new Server(httpServer, {
        maxHttpBufferSize: 1e6,
        cors: {
            origin: false
        }
    });

    io.use((socket, next) => {
        if (!isAllowedClientIp(socket.handshake.address)) {
            next(new Error('Csak LAN kliensek kapcsolodhatnak.'));
            return;
        }

        next();
    });

    io.on('connection', (socket) => {
        const clientIp = normalizeClientIp(socket.handshake.address);
        socket.data.clientIp = clientIp;
        socket.data.messageWindow = {
            start: Date.now(),
            count: 0
        };
        socket.data.spamState = {
            lastMessageAt: 0,
            lastNormalizedContent: '',
            repeatedCount: 0,
            blockedUntil: 0
        };

        function allowSocketMessage() {
            const now = Date.now();
            const windowMs = 10000;

            if (now - socket.data.messageWindow.start > windowMs) {
                socket.data.messageWindow.start = now;
                socket.data.messageWindow.count = 0;
            }

            socket.data.messageWindow.count += 1;

            if (socket.data.messageWindow.count > socketMessagesPer10s) {
                logEvent('security-socket-rate-limit', {
                    socketId: socket.id,
                    clientIp,
                    roomId: socket.data.roomId || null,
                    count: socket.data.messageWindow.count
                });
            }

            return socket.data.messageWindow.count <= socketMessagesPer10s;
        }

        socket.on('joinRoom', async (payload) => {
            const roomId = Number(payload?.roomId);
            const username = normalizeString(payload?.username);

            if (!isSafeRoomId(roomId) || !isValidUsername(username)) {
                return;
            }

            const room = await database.getRoomByIdForUser(roomId, normalizeIdentity(username));
            if (!room) {
                socket.emit('systemNotice', {
                    level: 'warn',
                    message: 'Nincs jogosultsagod ehhez a szobahoz.'
                });
                return;
            }

            if (socket.data.roomKey) {
                socket.leave(socket.data.roomKey);
            }

            const roomKey = `room:${roomId}`;
            socket.join(roomKey);
            socket.data.roomId = roomId;
            socket.data.roomKey = roomKey;
            socket.data.username = username;

            connectedUsers.set(socket.id, {
                socketId: socket.id,
                username,
                roomId,
                clientIp
            });

            try {
                await database.logConnection({
                    socketId: socket.id,
                    username,
                    clientIp
                });
            } catch (error) {
                console.error('Connection log hiba:', error.message);
            }

            await emitUsersUpdate();
            await emitHostsUpdate();
        });

        socket.on('message', async (payload) => {
            if (!allowSocketMessage()) {
                return;
            }

            const roomId = Number(payload?.roomId || socket.data.roomId);
            const username = normalizeString(payload?.username || socket.data.username);
            const messageType = normalizeMessageType(payload?.messageType || 'text');
            const content = clampMessageContentByType(payload?.content || '', messageType);
            const normalizedIdentity = normalizeIdentity(username);

            const now = Date.now();
            const spamState = socket.data.spamState;
            if (spamState.blockedUntil > now) {
                socket.emit('systemNotice', {
                    level: 'warn',
                    message: `Spam vedelem aktiv. Probald ujra ${Math.ceil((spamState.blockedUntil - now) / 1000)} mp mulva.`
                });
                return;
            }

            if (now - spamState.lastMessageAt < socketMinMessageIntervalMs) {
                spamState.repeatedCount += 1;
            }

            if (!isSafeRoomId(roomId) || !isValidUsername(username)) {
                return;
            }

            if (messageType !== 'image' && content.length < 1) {
                return;
            }

            const room = await database.getRoomByIdForUser(roomId, normalizedIdentity);
            if (!room) {
                socket.emit('systemNotice', {
                    level: 'warn',
                    message: 'Nincs jogosultsagod ehhez a szobahoz.'
                });
                return;
            }

            const normalizedContent = normalizeString(content).toLowerCase();
            if (
                normalizedContent &&
                normalizedContent === spamState.lastNormalizedContent &&
                now - spamState.lastMessageAt < socketDuplicateCooldownMs
            ) {
                spamState.repeatedCount += 1;
            }

            if (spamState.repeatedCount >= 3) {
                spamState.blockedUntil = now + socketSpamBlockMs;
                spamState.repeatedCount = 0;
                logEvent('security-socket-spam-block', {
                    socketId: socket.id,
                    clientIp,
                    username,
                    roomId
                });
                socket.emit('systemNotice', {
                    level: 'warn',
                    message: 'Tul gyors vagy ismetlodo kuldes miatt ideiglenes blokk lept eletbe.'
                });
                return;
            }

            try {
                const message = await database.saveMessage({
                    roomId,
                    username,
                    content,
                    messageType,
                    ipOptional: clientIp || null
                });

                spamState.lastMessageAt = now;
                spamState.lastNormalizedContent = normalizedContent;

                io.to(`room:${roomId}`).emit('message', message);
            } catch (error) {
                console.error('Uzenet mentes hiba:', error.message);
            }
        });

        socket.on('typingStart', (payload) => {
            if (!allowSocketMessage()) {
                return;
            }

            const roomId = Number(payload?.roomId || socket.data.roomId);
            const username = normalizeString(payload?.username || socket.data.username);

            if (!isSafeRoomId(roomId) || !isValidUsername(username)) {
                return;
            }

            database
                .getRoomByIdForUser(roomId, normalizeIdentity(username))
                .then((room) => {
                    if (!room) {
                        return;
                    }

                    socket.to(`room:${roomId}`).emit('typingUpdate', {
                        roomId,
                        username,
                        typing: true
                    });
                })
                .catch(() => {});
        });

        socket.on('typingStop', (payload) => {
            if (!allowSocketMessage()) {
                return;
            }

            const roomId = Number(payload?.roomId || socket.data.roomId);
            const username = normalizeString(payload?.username || socket.data.username);

            if (!isSafeRoomId(roomId) || !isValidUsername(username)) {
                return;
            }

            database
                .getRoomByIdForUser(roomId, normalizeIdentity(username))
                .then((room) => {
                    if (!room) {
                        return;
                    }

                    socket.to(`room:${roomId}`).emit('typingUpdate', {
                        roomId,
                        username,
                        typing: false
                    });
                })
                .catch(() => {});
        });

        // ============================================================================
        // ARCADE GAME EVENT HANDLERS
        // ============================================================================

        socket.on('arcade:startGame', async (payload) => {
            if (!allowSocketMessage()) return;

            const roomId = Number(payload?.roomId);
            const gameMode = String(payload?.gameMode || 'agar').toLowerCase();
            const username = normalizeString(socket.data.username);

            if (!isSafeRoomId(roomId) || !isValidUsername(username)) {
                socket.emit('systemNotice', {
                    level: 'error',
                    message: 'Invalid roomId or username.'
                });
                return;
            }

            try {
                const room = await database.getRoomByIdForUser(roomId, normalizeIdentity(username));
                if (!room) {
                    socket.emit('systemNotice', {
                        level: 'error',
                        message: 'Nincs jogosultsagod ehhez a szobahoz.'
                    });
                    return;
                }

                const gameRoomKey = `arcade:${roomId}:${gameMode}`;

                // Check if game already exists
                if (activeArcadeRooms.has(gameRoomKey)) {
                    socket.emit('systemNotice', {
                        level: 'warn',
                        message: 'Jatek mar folyamatban van ebben a szoban.'
                    });
                    return;
                }

                // Create new game instance
                let gameRoom;
                if (gameMode === 'agar') {
                    gameRoom = new AgarRoom(gameRoomKey, {
                        gameAreaWidth: 10000,
                        gameAreaHeight: 10000,
                        maxPlayers: 20
                    });
                } else {
                    socket.emit('systemNotice', {
                        level: 'error',
                        message: `Ismeretlen jatek mod: ${gameMode}`
                    });
                    return;
                }

                // Store game reference
                activeArcadeRooms.set(gameRoomKey, gameRoom);

                // Setup event listeners for broadcasting
                gameRoom.on('playerJoined', (data) => {
                    io.to(`room:${roomId}`).emit('arcade:playerJoined', data);
                });

                gameRoom.on('playerLeft', (data) => {
                    io.to(`room:${roomId}`).emit('arcade:playerLeft', data);
                });

                gameRoom.on('entitySpawned', (data) => {
                    // Only broadcast significant events, not every food spawn
                    if (data.entity.isPlayer) {
                        io.to(`room:${roomId}`).emit('arcade:entitySpawned', data);
                    }
                });

                gameRoom.on('entityDespawned', (data) => {
                    if (data.playerId) {
                        io.to(`room:${roomId}`).emit('arcade:entityDespawned', data);
                    }
                });

                gameRoom.on('stopped', () => {
                    activeArcadeRooms.delete(gameRoomKey);
                    io.to(`room:${roomId}`).emit('arcade:gameStopped', {
                        gameRoomKey,
                        finalState: gameRoom.getState()
                    });
                });

                // Send initial state
                const initialState = gameRoom.getState();
                io.to(`room:${roomId}`).emit('arcade:gameStarted', initialState);

                // Broadcast state updates every frame (or sample rate)
                const broadcastInterval = setInterval(() => {
                    if (!gameRoom.isGameRunning()) {
                        clearInterval(broadcastInterval);
                        return;
                    }
                    io.to(`room:${roomId}`).emit('arcade:stateUpdate', gameRoom.getState());
                }, 1000 / 60); // 60Hz

                // Start game loop
                gameRoom.start();

                logEvent('arcade-game-created', {
                    gameRoomKey,
                    roomId,
                    gameMode,
                    creator: username
                });
            } catch (error) {
                console.error('Arcade game start error:', error);
                socket.emit('systemNotice', {
                    level: 'error',
                    message: 'Jatek inditas sikertelen.'
                });
            }
        });

        socket.on('arcade:join', async (payload) => {
            if (!allowSocketMessage()) return;

            const roomId = Number(payload?.roomId);
            const gameMode = String(payload?.gameMode || 'agar').toLowerCase();
            const username = normalizeString(socket.data.username || payload?.username);

            if (!isSafeRoomId(roomId) || !isValidUsername(username)) {
                socket.emit('systemNotice', {
                    level: 'error',
                    message: 'Invalid roomId or username.'
                });
                return;
            }

            try {
                const room = await database.getRoomByIdForUser(roomId, normalizeIdentity(username));
                if (!room) {
                    socket.emit('systemNotice', {
                        level: 'error',
                        message: 'Nincs jogosultsagod ehhez a szobahoz.'
                    });
                    return;
                }

                const gameRoomKey = `arcade:${roomId}:${gameMode}`;
                const gameRoom = activeArcadeRooms.get(gameRoomKey);

                if (!gameRoom) {
                    socket.emit('systemNotice', {
                        level: 'warn',
                        message: 'Nincsen aktiv jatek ebben a szoban.'
                    });
                    return;
                }

                // Add player to game
                const playerId = `${username}_${socket.id}`;
                const added = gameRoom.addPlayer(playerId, username);

                if (!added) {
                    socket.emit('systemNotice', {
                        level: 'warn',
                        message: 'A jatek mar megtelt vagy mar csatlakozttal.'
                    });
                    return;
                }

                // Store game reference for this socket
                socket.data.arcadeGameKey = gameRoomKey;
                socket.data.arcadePlayerId = playerId;

                io.to(`room:${roomId}`).emit('arcade:stateUpdate', gameRoom.getState());

                logEvent('arcade-player-joined', {
                    gameRoomKey,
                    playerId,
                    username
                });
            } catch (error) {
                console.error('Arcade join error:', error);
                socket.emit('systemNotice', {
                    level: 'error',
                    message: 'Catlakozas sikertelen.'
                });
            }
        });

        socket.on('arcade:input', (payload) => {
            if (!allowSocketMessage()) return;

            const gameRoomKey = socket.data.arcadeGameKey;
            const playerId = socket.data.arcadePlayerId;

            if (!gameRoomKey || !playerId) {
                return; // Player not in active game
            }

            const gameRoom = activeArcadeRooms.get(gameRoomKey);
            if (!gameRoom || !gameRoom.isGameRunning()) {
                return;
            }

            const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

            const inputFrame = {
                tick: gameRoom.getCurrentTick(),
                moveX: clamp(Number(payload?.moveX) || 0, -1, 1),
                moveY: clamp(Number(payload?.moveY) || 0, -1, 1),
                action: Number(payload?.action) || 0,
                timestamp: Date.now()
            };

            gameRoom.queueInput(playerId, inputFrame);
        });

        socket.on('disconnect', async () => {
            if (socket.data.roomId && socket.data.username) {
                socket.to(`room:${socket.data.roomId}`).emit('typingUpdate', {
                    roomId: socket.data.roomId,
                    username: socket.data.username,
                    typing: false
                });
            }

            connectedUsers.delete(socket.id);

            try {
                await database.closeConnectionLog(socket.id);
            } catch (error) {
                console.error('Connection log zaras hiba:', error.message);
            }

            await emitUsersUpdate();
            await emitHostsUpdate();
        });
    });
}

function buildConnectUrlsForPort(activePort) {
    const localhostUrl = `http://localhost:${activePort}`;
    const preferredIp = runtimeConfig.networkDiagnostics?.preferredInterface?.address;
    const lanUrl = preferredIp ? `http://${preferredIp}:${activePort}` : `http://${ip}:${activePort}`;

    return Array.from(new Set([localhostUrl, lanUrl]));
}

function listenWithPortFallback(httpServer) {
    return new Promise((resolve, reject) => {
        let offset = 0;

        const tryListen = () => {
            const candidatePort = port + offset;

            const handleError = (error) => {
                httpServer.off('listening', handleListening);

                if (error?.code === 'EADDRINUSE' && offset < maxPortFallbackSteps) {
                    offset += 1;
                    logEvent('port-fallback', {
                        requestedPort: port,
                        nextPort: port + offset,
                        reason: error.code
                    });
                    tryListen();
                    return;
                }

                reject(error);
            };

            const handleListening = () => {
                httpServer.off('error', handleError);
                resolve({
                    activePort: candidatePort,
                    usedFallback: candidatePort !== port
                });
            };

            httpServer.once('error', handleError);
            httpServer.once('listening', handleListening);
            httpServer.listen(candidatePort, ip);
        };

        tryListen();
    });
}

//!API endpoints
app.use((request, response, next) => {
    if (!isAllowedClientIp(request.ip || request.socket.remoteAddress)) {
        response.status(403).json({ message: 'Csak LAN kliensek kapcsolodhatnak.' });
        return;
    }

    next();
});

app.use('/', router);
const endpoints = require('./api/api.js');
app.use('/api', endpoints);
app.use(
    '/uploads',
    express.static(path.join(__dirname, './uploads'), {
        dotfiles: 'deny',
        etag: true,
        index: false,
        maxAge: '2h'
    })
);

//!Szerver futtatása
app.use(express.static(path.join(__dirname, '../frontend'))); //?frontend mappa tartalmának betöltése az oldal működéséhez

async function startServer() {
    try {
        logEvent('server-starting', {
            host: ip,
            port,
            lanOnly: runtimeConfig.lanOnly
        });

        await database.initDatabase();
        const startupSmokeReport = await runStartupSmokeTests({
            database,
            context: 'server-startup'
        });
        app.locals.startupSmokeReport = startupSmokeReport;

        if (!startupSmokeReport.ok) {
            console.warn(`Startup smoke status: ${startupSmokeReport.status}`);

            for (const check of startupSmokeReport.checks.filter((item) => !item.ok)) {
                console.warn(`- ${check.name}: ${check.details}`);
            }

            if (startupSmokeStrict) {
                throw new Error('Startup smoke hibak miatt inditas megszakitva (STARTUP_SMOKE_STRICT=true).');
            }
        }

        console.log('Adatbazis inicializalva: localchat');
        const dbRuntime = database.getDatabaseRuntimeInfo();
        const adminToken = (process.env.ADMIN_TOKEN || '').trim();
        const logEncryptionKey = (process.env.LOG_ENCRYPTION_KEY || '').trim();
        console.log(
            `DB host: configured=${dbRuntime.configuredHost}, active=${dbRuntime.activeHost}, auto=${dbRuntime.hostAuto}`
        );
        console.log(`Admin URL: /admin`);
        console.log(`Admin token: ${adminToken || 'NINCS beallitva (.env -> ADMIN_TOKEN)'}`);
        console.log(
            `LOG_ENCRYPTION_KEY: ${logEncryptionKey ? logEncryptionKey : 'NINCS beallitva (.env -> LOG_ENCRYPTION_KEY)'}`
        );

        const ipRange = getIpRange(runtimeConfig);
        await database.ensureHosts(ipRange);

        const httpServer = http.createServer(app);
        setupSocketServer(httpServer);

        discoveryService = createDiscoveryService({
            ips: ipRange,
            discoveryMode: runtimeConfig.discoveryMode,
            discoveryIntervalMs: runtimeConfig.discoveryIntervalMs,
            discoveryConcurrency: runtimeConfig.discoveryConcurrency,
            agentPort: runtimeConfig.agentPort,
            updateStatuses: database.updateHostStatuses,
            emitHostsUpdate,
            getConnectedIps
        });

        app.locals.getConnectedUsers = getConnectedUsers;
        app.locals.runDiscoveryOnce = discoveryService.scanOnce;
        app.locals.runtimeConfig = runtimeConfig;
        app.locals.broadcastRoomMessage = (roomId, message) => {
            io.to(`room:${roomId}`).emit('message', message);
        };
        discoveryService.start();

        if (snapshotTimer) {
            clearInterval(snapshotTimer);
        }

        snapshotTimer = setInterval(async () => {
            try {
                const stats = await database.getStatsSummary();
                logEvent('auto-state-snapshot', {
                    totalRooms: stats.totalRooms,
                    totalMessages: stats.totalMessages,
                    messagesToday: stats.messagesToday,
                    hostsOnline: stats.hostsOnline
                });
            } catch (error) {
                logEvent('auto-state-snapshot-error', {
                    message: error?.message || 'unknown'
                });
            }
        }, autoSnapshotIntervalMs);

        snapshotTimer.unref?.();

        const { activePort, usedFallback } = await listenWithPortFallback(httpServer);

        const connectUrls = buildConnectUrlsForPort(activePort);
        if (usedFallback) {
            console.warn(`Az alap port (${port}) foglalt volt, fallback port hasznalva: ${activePort}`);
            logEvent('port-fallback-active', {
                requestedPort: port,
                activePort
            });
        }

        app.locals.activeServerPort = activePort;
        app.locals.connectUrls = connectUrls;

        for (const url of connectUrls) {
                console.log(`Szerver elerhetoseg: ${url}`);
        }
        console.log(`Discovery mod: ${runtimeConfig.discoveryMode}`);
        console.log(
            `Diagnosztika interfesz: ${runtimeConfig.networkDiagnostics.preferredInterface?.name || 'n/a'} (${runtimeConfig.networkDiagnostics.preferredInterface?.address || 'n/a'})`
        );
        logEvent('server-started', {
            activePort,
            connectUrls,
            discoveryMode: runtimeConfig.discoveryMode
        });
    } catch (error) {
        console.error('A szerver nem indult el, mert az adatbazis inicializalasa sikertelen.');
        console.error(error.message);
        logEvent('server-start-failed', {
            message: error?.message || 'unknown',
            code: error?.code || null
        });
        if (error.details?.attempts) {
            console.error('DB host probalkozasok:');
            for (const attempt of error.details.attempts) {
                console.error(
                    `- host=${attempt.host}, ok=${attempt.ok}, code=${attempt.errorCode || 'none'}, elapsedMs=${attempt.elapsedMs}`
                );
            }
        }
        console.error('Futtasd a reszletes diagnosztikat: npm run diag:db');
        process.exit(1);
    }
}

if (require.main === module) {
    startServer();
}

module.exports = {
    startServer
};

//?Szerver futtatása terminalból: npm run dev
//?Szerver leállítása (MacBook és Windows): Control + C
//?Terminal ablak tartalmának törlése (MacBook): Command + K
