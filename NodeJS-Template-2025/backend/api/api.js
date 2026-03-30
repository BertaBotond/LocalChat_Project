const express = require('express');
const router = express.Router();
const database = require('../sql/database.js');
const { getRuntimeConfig, getIpRange } = require('../config/runtime.js');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { getSecureLogStatus } = require('../logging/secure-log.js');
const { runStartupSmokeTests } = require('../security/startup-smoke.js');
const {
    normalizeString,
    normalizeIdentity,
    isValidRoomName,
    isValidUsername,
    clampMessageContentByType,
    isSafeRoomId,
    isAllowedMimeType
} = require('../security/validation.js');

const maxImageSizeMb = Number(process.env.MAX_IMAGE_SIZE_MB) || 3;
const inviteAttemptLimiter = new Map();
const adminAttemptLimiter = new Map();

setInterval(() => {
    const now = Date.now();

    for (const [key, value] of inviteAttemptLimiter.entries()) {
        const blockedUntil = Number(value?.blockedUntil || 0);
        const windowStart = Number(value?.windowStart || 0);

        if (blockedUntil <= now && now - windowStart > 5 * 60 * 1000) {
            inviteAttemptLimiter.delete(key);
        }
    }

    for (const [key, value] of adminAttemptLimiter.entries()) {
        const blockedUntil = Number(value?.blockedUntil || 0);
        const windowStart = Number(value?.windowStart || 0);

        if (blockedUntil <= now && now - windowStart > 20 * 60 * 1000) {
            adminAttemptLimiter.delete(key);
        }
    }
}, 2 * 60 * 1000).unref?.();

function safeCompare(a, b) {
    const left = Buffer.from(a || '');
    const right = Buffer.from(b || '');

    if (left.length !== right.length) {
        return false;
    }

    return crypto.timingSafeEqual(left, right);
}

function verifyAdminToken(request) {
    const configuredToken = (process.env.ADMIN_TOKEN || '').trim();
    const providedToken = (
        request.headers['x-admin-token'] ||
        request.query.adminToken ||
        request.body?.adminToken ||
        ''
    )
        .toString()
        .trim();

    if (!configuredToken) {
        return {
            ok: false,
            reason: 'admin-token-not-configured'
        };
    }

    if (!providedToken) {
        return {
            ok: false,
            reason: 'missing-admin-token'
        };
    }

    return {
        ok: safeCompare(configuredToken, providedToken),
        reason: 'invalid-admin-token'
    };
}

function requireAdminAccess(request, response, next) {
    const key = (request.ip || request.socket?.remoteAddress || 'unknown').toString();
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxAttempts = 15;
    const blockMs = 10 * 60 * 1000;

    const bucket = adminAttemptLimiter.get(key) || {
        count: 0,
        windowStart: now,
        blockedUntil: 0
    };

    if (bucket.blockedUntil > now) {
        response.status(429).json({
            message: `Admin endpoint ideiglenesen blokkolva. Probald ujra ${Math.ceil((bucket.blockedUntil - now) / 1000)} mp mulva.`
        });
        return;
    }

    if (now - bucket.windowStart > windowMs) {
        bucket.count = 0;
        bucket.windowStart = now;
    }

    const auth = verifyAdminToken(request);
    if (!auth.ok) {
        bucket.count += 1;
        if (bucket.count > maxAttempts) {
            bucket.blockedUntil = now + blockMs;
        }
        adminAttemptLimiter.set(key, bucket);

        const status = auth.reason === 'admin-token-not-configured' ? 503 : 401;
        response.status(status).json({
            message:
                auth.reason === 'admin-token-not-configured'
                    ? 'ADMIN_TOKEN nincs beallitva a szerveren.'
                    : 'Ervenytelen admin token.'
        });
        return;
    }

    adminAttemptLimiter.set(key, {
        count: 0,
        windowStart: now,
        blockedUntil: 0
    });
    next();
}

function generateInviteCode() {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function getInviteAttemptKey(request, username) {
    const ip = (request.ip || request.socket?.remoteAddress || 'unknown').toString();
    return `${ip}|${normalizeIdentity(username)}`;
}

function checkInviteAttemptLimit(request, username) {
    const key = getInviteAttemptKey(request, username);
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxAttempts = 10;
    const blockMs = 2 * 60 * 1000;

    const bucket = inviteAttemptLimiter.get(key) || {
        count: 0,
        windowStart: now,
        blockedUntil: 0
    };

    if (bucket.blockedUntil > now) {
        return {
            allowed: false,
            retryAfterSec: Math.ceil((bucket.blockedUntil - now) / 1000)
        };
    }

    if (now - bucket.windowStart > windowMs) {
        bucket.count = 0;
        bucket.windowStart = now;
    }

    bucket.count += 1;
    if (bucket.count > maxAttempts) {
        bucket.blockedUntil = now + blockMs;
        inviteAttemptLimiter.set(key, bucket);
        return {
            allowed: false,
            retryAfterSec: Math.ceil(blockMs / 1000)
        };
    }

    inviteAttemptLimiter.set(key, bucket);
    return {
        allowed: true,
        retryAfterSec: 0
    };
}

function getNetworkFallbackPlan(connectUrl) {
    return [
        {
            scenario: 'Iskolai policy tiltja a kliens-kliens kapcsolatot',
            backup: 'Inditsatok egy kozos szerver gepet (tanari vagy dedikalt gep), mindenki csak ahhoz csatlakozzon.',
            details: 'Ha nincs peer-to-peer engedely, kliens gepek egymast nem erik el, de a kozponti gep elerheto lehet.'
        },
        {
            scenario: 'Host firewall tiltja a bejovo 3000-es portot',
            backup: 'Hasznaljatok localhost-only demot ugyanazon a gepen, vagy kerjetek IT oldalon ideiglenes szabaly kivetelet.',
            details: 'App oldalon ezt nem lehet felulirni, ez operacios rendszer szintu vedelmi szabaly.'
        },
        {
            scenario: 'VLAN-ok kozott vagytok szetvalasztva',
            backup: 'Minden VLAN-ban fusson kulon chat szerver, vagy legyen egy routolt kozponti VLAN szerver.',
            details: 'VLAN szeparacio eseten layer3 routing/policy kell a ket halozat koze.'
        },
        {
            scenario: 'Proxy/NAC szabalyok szurik a forgalmat',
            backup: 'Hasznaljatok IT altal engedelyezett endpointot/portot, vagy telepitsetek belso szerverkent engedelyezett gepre.',
            details: 'NAC/proxy tiltast sem a browser, sem a Node app nem tudja megkerulni.'
        },
        {
            scenario: '1 perces gyorsteszt',
            backup: '1) Backend fut 2) LAN link kiir 3) Masik gepen megnyit 4) Ha nem megy: policy/network tilt.',
            details: `Teszt URL: ${connectUrl || 'n/a'}`
        }
    ];
}

const imageStorage = multer.diskStorage({
    destination: (request, file, callback) => {
        callback(null, path.join(__dirname, '../uploads'));
    },
    filename: (request, file, callback) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const token = crypto.randomBytes(12).toString('hex');
        callback(null, `${Date.now()}-${token}${ext}`);
    }
});

const uploadImage = multer({
    storage: imageStorage,
    limits: {
        fileSize: maxImageSizeMb * 1024 * 1024,
        files: 1
    },
    fileFilter: (request, file, callback) => {
        if (!isAllowedMimeType(file.mimetype)) {
            callback(new Error('Nem tamogatott kep formatum.')); 
            return;
        }

        callback(null, true);
    }
});

//!Endpoints:
router.get('/config', (request, response) => {
    const config = request.app.locals.runtimeConfig || getRuntimeConfig();
    const connectUrls = request.app.locals.connectUrls || config.networkDiagnostics?.connectUrls || [];
    const activeServerPort = request.app.locals.activeServerPort || config.serverPort;

    response.status(200).json({
        serverHost: config.serverHost,
        serverPort: activeServerPort,
        lanOnly: config.lanOnly,
        autoRangeEnabled: config.autoRangeEnabled,
        ipBase: config.ipBase,
        ipStart: config.ipStart,
        ipEnd: config.ipEnd,
        discoveryIntervalMs: config.discoveryIntervalMs,
        discoveryConcurrency: config.discoveryConcurrency,
        agentPort: config.agentPort,
        discoveryMode: config.discoveryMode,
        range: getIpRange(config),
        connectUrls
    });
});

router.get('/network-diagnostics', (request, response) => {
    const config = request.app.locals.runtimeConfig || getRuntimeConfig();
    const connectUrls = request.app.locals.connectUrls || config.networkDiagnostics?.connectUrls || [];

    response.status(200).json({
        preferredInterface: config.networkDiagnostics?.preferredInterface || null,
        recommendedRange: config.networkDiagnostics?.range || null,
        connectUrls,
        interfaces: config.networkDiagnostics?.interfaces || [],
        adapters: config.networkDiagnostics?.adapters || [],
        universalPlan: config.networkDiagnostics?.universalPlan || []
    });
});

router.get('/log/status', (request, response) => {
    response.status(200).json({
        secureLog: getSecureLogStatus()
    });
});

router.get('/log/recovery-status', (request, response) => {
    response.status(200).json({
        recovery: database.getRecoveryStatus()
    });
});

router.get('/admin/diagnostics', requireAdminAccess, (request, response) => {
    const config = request.app.locals.runtimeConfig || getRuntimeConfig();
    const connectUrls = request.app.locals.connectUrls || config.networkDiagnostics?.connectUrls || [];
    const dbRuntime = database.getDatabaseRuntimeInfo();

    response.status(200).json({
        timestamp: new Date().toISOString(),
        runtime: {
            serverHost: config.serverHost,
            serverPort: Number(request.app.locals.activeServerPort || config.serverPort),
            lanOnly: config.lanOnly,
            discoveryMode: config.discoveryMode,
            connectUrls,
            networkDiagnostics: config.networkDiagnostics || {}
        },
        secureLog: getSecureLogStatus(),
        recovery: database.getRecoveryStatus(),
        dbRuntime,
        startupSmoke: request.app.locals.startupSmokeReport || null
    });
});

router.post('/admin/smoke-test', requireAdminAccess, async (request, response) => {
    try {
        const report = await runStartupSmokeTests({
            database,
            context: 'admin-manual'
        });

        request.app.locals.startupSmokeReport = report;
        response.status(200).json(report);
    } catch (error) {
        response.status(500).json({
            message: error?.message || 'Startup smoke futtatasa sikertelen.'
        });
    }
});

router.get('/rooms', async (request, response) => {
    const username = normalizeIdentity(request.query.username || '');

    try {
        const rooms = await database.getRooms(username);
        response.status(200).json(rooms);
    } catch (error) {
        response.status(500).json({
            message: 'Nem sikerult lekerdezni a szobakat.'
        });
    }
});

router.post('/rooms', async (request, response) => {
    const name = normalizeString(request.body?.name);
    const username = normalizeString(request.body?.username);
    const isPrivate = request.body?.isPrivate === true;
    const members = Array.isArray(request.body?.members)
        ? request.body.members.map((item) => normalizeIdentity(item)).filter((item) => item.length > 0)
        : [];

    if (!isValidRoomName(name)) {
        response.status(400).json({
            message: 'Ervenytelen szobanev. 2-60 karakter, betu/szam/space/.-_ engedelyezett.'
        });
        return;
    }

    if (isPrivate) {
        if (!isValidUsername(username)) {
            response.status(400).json({
                message: 'Privat szobahoz ervenyes letrehozo username szukseges.'
            });
            return;
        }

        const invalidMember = members.find((member) => !isValidUsername(member));
        if (invalidMember) {
            response.status(400).json({
                message: 'A meghivott userek listaja ervenytelen elemet tartalmaz.'
            });
            return;
        }

        if (!members.length) {
            response.status(400).json({
                message: 'Privat szobahoz legalabb 1 meghivott usert valassz ki.'
            });
            return;
        }
    }

    try {
        const inviteCode = isPrivate ? generateInviteCode() : null;
        const room = await database.createRoom(name, {
            isPrivate,
            ownerUsername: username,
            members,
            inviteCode
        });
        response.status(201).json({
            ...room,
            inviteCode: inviteCode || null
        });
    } catch (error) {
        if (error && error.code === 'ER_DUP_ENTRY') {
            response.status(409).json({
                message: 'Ez a szoba mar letezik.'
            });
            return;
        }

        response.status(500).json({
            message: 'Nem sikerult letrehozni a szobat.'
        });
    }
});

router.get('/rooms/:id/access', async (request, response) => {
    const roomId = Number(request.params.id);
    const username = normalizeIdentity(request.query.username || '');

    if (!isSafeRoomId(roomId)) {
        response.status(400).json({
            message: 'Ervenytelen szoba azonosito.'
        });
        return;
    }

    try {
        const access = await database.getRoomAccess(roomId, username);
        if (!access) {
            response.status(404).json({
                message: 'A szoba nem letezik.'
            });
            return;
        }

        response.status(200).json({
            roomId: access.id,
            name: access.name,
            isPrivate: Number(access.is_private) === 1,
            hasAccess: access.hasAccess,
            isOwner: access.isOwner,
            isMember: access.isMember,
            inviteCode: access.isOwner ? access.invite_code || null : null
        });
    } catch (error) {
        response.status(500).json({
            message: 'Nem sikerult lekerdezni a szoba jogosultsagot.'
        });
    }
});

router.post('/rooms/:id/join-private', async (request, response) => {
    const roomId = Number(request.params.id);
    const username = normalizeString(request.body?.username);
    const inviteCode = normalizeString(request.body?.inviteCode).toUpperCase();

    if (!isSafeRoomId(roomId) || !isValidUsername(username)) {
        response.status(400).json({
            message: 'Ervenytelen roomId vagy username.'
        });
        return;
    }

    if (inviteCode.length < 4) {
        response.status(400).json({
            message: 'A meghivokod tul rovid.'
        });
        return;
    }

    const limit = checkInviteAttemptLimit(request, username);
    if (!limit.allowed) {
        response.status(429).json({
            message: `Tul sok meghivokod probalkozas. Probald ujra ${limit.retryAfterSec} mp mulva.`
        });
        return;
    }

    try {
        const result = await database.joinPrivateRoomByInvite(roomId, username, inviteCode);
        if (!result.ok) {
            response.status(403).json({
                message: result.reason === 'invalid-code' ? 'Hibas meghivokod.' : 'Nem sikerult csatlakozni a privat szobahoz.'
            });
            return;
        }

        response.status(200).json({
            ok: true
        });
    } catch (error) {
        response.status(500).json({
            message: 'Privat szobahoz csatlakozas sikertelen.'
        });
    }
});

router.get('/rooms/:id/members', async (request, response) => {
    const roomId = Number(request.params.id);
    const username = normalizeIdentity(request.query.username || '');

    if (!isSafeRoomId(roomId) || !isValidUsername(username)) {
        response.status(400).json({
            message: 'Ervenytelen roomId vagy username.'
        });
        return;
    }

    try {
        const access = await database.getRoomAccess(roomId, username);
        if (!access || Number(access.is_private) !== 1) {
            response.status(404).json({
                message: 'Privat szoba nem talalhato.'
            });
            return;
        }

        if (!access.isOwner) {
            response.status(403).json({
                message: 'Csak a szoba tulajdonosa kezelheti a tagokat.'
            });
            return;
        }

        const members = await database.getRoomMembers(roomId);
        response.status(200).json({
            ownerUsername: access.owner_username,
            members
        });
    } catch (error) {
        response.status(500).json({
            message: 'Taglista lekerdezese sikertelen.'
        });
    }
});

router.delete('/rooms/:id/members/:memberUsername', async (request, response) => {
    const roomId = Number(request.params.id);
    const ownerUsername = normalizeIdentity(request.query.username || '');
    const memberUsername = normalizeIdentity(request.params.memberUsername || '');

    if (!isSafeRoomId(roomId) || !isValidUsername(ownerUsername) || !isValidUsername(memberUsername)) {
        response.status(400).json({
            message: 'Ervenytelen parameter.'
        });
        return;
    }

    try {
        const access = await database.getRoomAccess(roomId, ownerUsername);
        if (!access || Number(access.is_private) !== 1) {
            response.status(404).json({
                message: 'Privat szoba nem talalhato.'
            });
            return;
        }

        if (!access.isOwner) {
            response.status(403).json({
                message: 'Csak a szoba tulajdonosa torolhet tagot.'
            });
            return;
        }

        if (normalizeIdentity(access.owner_username) === memberUsername) {
            response.status(400).json({
                message: 'A tulajdonos nem torolheto a sajat szobajabol.'
            });
            return;
        }

        await database.removeRoomMember(roomId, memberUsername);
        response.status(200).json({
            ok: true
        });
    } catch (error) {
        response.status(500).json({
            message: 'Tag torlese sikertelen.'
        });
    }
});

router.post('/rooms/:id/rotate-invite', async (request, response) => {
    const roomId = Number(request.params.id);
    const ownerUsername = normalizeIdentity(request.body?.username || '');

    if (!isSafeRoomId(roomId) || !isValidUsername(ownerUsername)) {
        response.status(400).json({
            message: 'Ervenytelen roomId vagy username.'
        });
        return;
    }

    try {
        const access = await database.getRoomAccess(roomId, ownerUsername);
        if (!access || Number(access.is_private) !== 1) {
            response.status(404).json({
                message: 'Privat szoba nem talalhato.'
            });
            return;
        }

        if (!access.isOwner) {
            response.status(403).json({
                message: 'Csak a tulajdonos forgathat meghivokodot.'
            });
            return;
        }

        const inviteCode = generateInviteCode();
        await database.rotateRoomInviteCode(roomId, inviteCode);
        response.status(200).json({
            inviteCode
        });
    } catch (error) {
        response.status(500).json({
            message: 'Meghivokod frissitese sikertelen.'
        });
    }
});

router.get('/rooms/:id/messages', async (request, response) => {
    const roomId = Number(request.params.id);
    const limit = Number(request.query.limit || 50);
    const username = normalizeIdentity(request.query.username || '');

    if (!isSafeRoomId(roomId)) {
        response.status(400).json({
            message: 'Ervenytelen szoba azonosito.'
        });
        return;
    }

    try {
        const room = await database.getRoomByIdForUser(roomId, username);
        if (!room) {
            response.status(403).json({
                message: 'Nincs jogosultsagod ehhez a szobahoz.'
            });
            return;
        }

        const messages = await database.getMessagesByRoom(roomId, limit);
        response.status(200).json(messages);
    } catch (error) {
        response.status(500).json({
            message: 'Nem sikerult lekerdezni az uzeneteket.'
        });
    }
});

router.post('/rooms/:id/images', (request, response) => {
    uploadImage.single('image')(request, response, async (uploadError) => {
        if (uploadError) {
            response.status(400).json({
                message: uploadError.message || 'A kep feltoltes sikertelen.'
            });
            return;
        }

        const roomId = Number(request.params.id);
        const username = normalizeString(request.body?.username);
        const normalizedUsername = normalizeIdentity(username);
        const caption = normalizeString(request.body?.caption || '').slice(0, 180);

        if (!isSafeRoomId(roomId) || !isValidUsername(username)) {
            response.status(400).json({
                message: 'Ervenytelen roomId vagy username.'
            });
            return;
        }

        if (!request.file) {
            response.status(400).json({
                message: 'Hianyzik a kepfajl.'
            });
            return;
        }

        const room = await database.getRoomByIdForUser(roomId, normalizedUsername);
        if (!room) {
            response.status(403).json({
                message: 'Nincs jogosultsagod ehhez a szobahoz.'
            });
            return;
        }

        try {
            const message = await database.saveMessage({
                roomId,
                username,
                content: caption,
                messageType: 'image',
                mimeType: request.file.mimetype,
                filePath: `/uploads/${request.file.filename}`,
                originalName: request.file.originalname,
                ipOptional: request.ip || request.socket.remoteAddress || null
            });

            const broadcast = request.app.locals.broadcastRoomMessage;
            if (typeof broadcast === 'function') {
                broadcast(roomId, message);
            }

            response.status(201).json(message);
        } catch (error) {
            response.status(500).json({
                message: 'A kepuzenet mentes sikertelen.'
            });
        }
    });
});

router.get('/rooms/:id/messages/search', async (request, response) => {
    const roomId = Number(request.params.id);
    const query = clampMessageContentByType(request.query.q || '', 'text');
    const limit = Number(request.query.limit || 50);
    const username = normalizeIdentity(request.query.username || '');

    if (!isSafeRoomId(roomId)) {
        response.status(400).json({
            message: 'Ervenytelen szoba azonosito.'
        });
        return;
    }

    if (query.length < 2) {
        response.status(400).json({
            message: 'A keresesi kifejezes legalabb 2 karakter legyen.'
        });
        return;
    }

    try {
        const room = await database.getRoomByIdForUser(roomId, username);
        if (!room) {
            response.status(403).json({
                message: 'Nincs jogosultsagod ehhez a szobahoz.'
            });
            return;
        }

        const messages = await database.searchMessagesByRoom(roomId, query, limit);
        response.status(200).json(messages);
    } catch (error) {
        response.status(500).json({
            message: 'Nem sikerult lefuttatni az uzenetkeresest.'
        });
    }
});

router.get('/stats', async (request, response) => {
    try {
        const stats = await database.getStatsSummary();
        const getConnectedUsers = request.app.locals.getConnectedUsers;
        const connectedUsers = typeof getConnectedUsers === 'function' ? getConnectedUsers() : [];

        response.status(200).json({
            ...stats,
            connectedUsers: connectedUsers.length
        });
    } catch (error) {
        response.status(500).json({
            message: 'Nem sikerult lekerdezni a statisztikakat.'
        });
    }
});

router.get('/hosts', async (request, response) => {
    try {
        const hosts = await database.getHostStatuses();
        const getConnectedUsers = request.app.locals.getConnectedUsers;
        const connectedUsers = typeof getConnectedUsers === 'function' ? getConnectedUsers() : [];
        const connectedIps = new Set(
            connectedUsers.map((item) => item.clientIp).filter((item) => typeof item === 'string')
        );

        const payload = hosts.map((host) => ({
            ...host,
            chatConnected: connectedIps.has(host.ip)
        }));

        response.status(200).json(payload);
    } catch (error) {
        response.status(500).json({
            message: 'Nem sikerult lekerdezni a host statuszokat.'
        });
    }
});

router.post('/hosts/rescan', async (request, response) => {
    try {
        const runDiscoveryOnce = request.app.locals.runDiscoveryOnce;

        if (typeof runDiscoveryOnce !== 'function') {
            response.status(503).json({
                message: 'A discovery szolgaltatas nem erheto el.'
            });
            return;
        }

        await runDiscoveryOnce();
        const hosts = await database.getHostStatuses();
        const getConnectedUsers = request.app.locals.getConnectedUsers;
        const connectedUsers = typeof getConnectedUsers === 'function' ? getConnectedUsers() : [];
        const connectedIps = new Set(
            connectedUsers.map((item) => item.clientIp).filter((item) => typeof item === 'string')
        );

        const payload = hosts.map((host) => ({
            ...host,
            chatConnected: connectedIps.has(host.ip)
        }));

        response.status(200).json(payload);
    } catch (error) {
        response.status(500).json({
            message: 'A manualis discovery futtatas sikertelen.'
        });
    }
});

router.get('/network-backup-plan', async (request, response) => {
    const config = request.app.locals.runtimeConfig || getRuntimeConfig();
    const connectUrls = request.app.locals.connectUrls || config.networkDiagnostics?.connectUrls || [];
    const connectUrl = connectUrls.find((url) => !url.includes('localhost')) || connectUrls[0] || null;

    response.status(200).json({
        connectUrl,
        plan: getNetworkFallbackPlan(connectUrl)
    });
});

router.get('/quick-lan-test', async (request, response) => {
    const config = request.app.locals.runtimeConfig || getRuntimeConfig();
    const connectUrls = request.app.locals.connectUrls || config.networkDiagnostics?.connectUrls || [];
    const preferredLanUrl = connectUrls.find((url) => !url.includes('localhost')) || connectUrls[0] || null;

    const hosts = await database.getHostStatuses().catch(() => []);
    const reachable = hosts.filter((host) => host.status === 'online').length;

    response.status(200).json({
        title: '1 perces LAN gyorsteszt',
        steps: [
            '1) Szerver gepen backend fut',
            `2) LAN link: ${preferredLanUrl || 'n/a'}`,
            '3) Masik gepen bongeszoben nyisd meg',
            '4) Ha nem nyilik meg, akkor policy/network tilt, nem app hiba'
        ],
        hints: getNetworkFallbackPlan(preferredLanUrl),
        discoveryOnlineHosts: reachable
    });
});

module.exports = router;
