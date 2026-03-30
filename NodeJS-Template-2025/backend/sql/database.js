const mysql = require('mysql2/promise');
const { getNetworkDiagnostics } = require('../config/network.js');
const { logEvent, hasSecureLogFile, readRecoveryEvents } = require('../logging/secure-log.js');

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT) || 3306;
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'localchat';
const DB_CONNECT_TIMEOUT_MS = Number(process.env.DB_CONNECT_TIMEOUT_MS) || 5000;
const DB_CONNECT_RETRIES = Math.max(1, Number(process.env.DB_CONNECT_RETRIES) || 4);
const DB_RETRY_DELAY_MS = Math.max(200, Number(process.env.DB_RETRY_DELAY_MS) || 1200);
const DB_HOST_AUTO = (process.env.DB_HOST_AUTO || 'true').toLowerCase() !== 'false';
const DB_HOST_CANDIDATES = process.env.DB_HOST_CANDIDATES || '';

let pool;
let activeDbHost = DB_HOST;
let lastDbHostResolution = null;
let lastRecoveryStatus = {
    attempted: false,
    ok: false,
    reason: 'not-attempted',
    recoveredRooms: 0,
    recoveredMessages: 0,
    eventsRead: 0,
    details: ''
};

function normalizeIdentity(value) {
    return (value || '').toString().trim().toLowerCase();
}

function unique(values) {
    return Array.from(new Set(values.filter((item) => typeof item === 'string' && item.length > 0)));
}

function getDbHostCandidates() {
    const diagnostics = getNetworkDiagnostics('0.0.0.0', Number(process.env.SERVER_PORT) || 3000);
    const preferredAddress = diagnostics?.preferredInterface?.address;
    const explicit = DB_HOST_CANDIDATES.split(',').map((item) => item.trim());

    const ordered = [DB_HOST, ...explicit, '127.0.0.1', 'localhost', '::1'];

    if (preferredAddress) {
        ordered.push(preferredAddress);
    }

    return unique(ordered);
}

async function probeDbHost(host) {
    const startedAt = Date.now();

    try {
        const connection = await mysql.createConnection({
            host,
            port: DB_PORT,
            user: DB_USER,
            password: DB_PASSWORD,
            connectTimeout: DB_CONNECT_TIMEOUT_MS
        });

        await connection.query('SELECT 1');
        await connection.end();

        return {
            ok: true,
            host,
            elapsedMs: Date.now() - startedAt
        };
    } catch (error) {
        return {
            ok: false,
            host,
            elapsedMs: Date.now() - startedAt,
            error
        };
    }
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function resolveDbHost() {
    const candidates = DB_HOST_AUTO ? getDbHostCandidates() : [DB_HOST];
    const attempts = [];

    for (let round = 1; round <= DB_CONNECT_RETRIES; round += 1) {
        for (const host of candidates) {
            const attempt = await probeDbHost(host);
            attempts.push({
                host: attempt.host,
                ok: attempt.ok,
                elapsedMs: attempt.elapsedMs,
                errorCode: attempt.error?.code || null,
                errorMessage: attempt.error?.message || null,
                round
            });

            if (attempt.ok) {
                activeDbHost = host;
                lastDbHostResolution = {
                    selectedHost: host,
                    attempts
                };

                return host;
            }
        }

        if (round < DB_CONNECT_RETRIES) {
            await sleep(DB_RETRY_DELAY_MS);
        }
    }

    const fallbackError = attempts.length
        ? new Error(attempts[attempts.length - 1].errorMessage || 'DB host resolution failed')
        : new Error('Nincs DB host jelolt a kapcsolodashoz.');
    fallbackError.code = attempts.length ? attempts[attempts.length - 1].errorCode : 'NO_DB_HOST_CANDIDATE';
    fallbackError.details = {
        candidates,
        attempts
    };
    throw fallbackError;
}

async function ensureDatabaseExists(host) {
    const connection = await mysql.createConnection({
        host,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASSWORD,
        connectTimeout: DB_CONNECT_TIMEOUT_MS
    });

    try {
        const [rows] = await connection.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [
            DB_NAME
        ]);
        const existed = Array.isArray(rows) && rows.length > 0;
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
        return {
            createdNew: !existed
        };
    } finally {
        await connection.end();
    }
}

async function recoverStateFromSecureLogIfPossible() {
    if (!hasSecureLogFile()) {
        const message = 'Secure log recovery: log fajl nem talalhato.';
        console.warn(message);
        lastRecoveryStatus = {
            attempted: true,
            ok: false,
            reason: 'missing-log-file',
            recoveredRooms: 0,
            recoveredMessages: 0,
            eventsRead: 0,
            details: message
        };
        return lastRecoveryStatus;
    }

    const recovery = readRecoveryEvents();
    if (!recovery.ok) {
        const message = `Secure log recovery sikertelen: ${recovery.reason}${recovery.message ? ` (${recovery.message})` : ''}`;
        console.warn(message);
        lastRecoveryStatus = {
            attempted: true,
            ok: false,
            reason: recovery.reason || 'read-or-decrypt-error',
            recoveredRooms: 0,
            recoveredMessages: 0,
            eventsRead: 0,
            details: message
        };
        return lastRecoveryStatus;
    }

    const events = recovery.events || [];
    if (!events.length) {
        const message = 'Secure log recovery: nincs hasznalhato adat.';
        console.warn(message);
        lastRecoveryStatus = {
            attempted: true,
            ok: false,
            reason: 'empty-events',
            recoveredRooms: 0,
            recoveredMessages: 0,
            eventsRead: 0,
            details: message
        };
        return lastRecoveryStatus;
    }

    const roomCreatedEvents = events.filter((event) => event.type === 'room-created');
    const memberAddedEvents = events.filter((event) => event.type === 'room-members-added');
    const memberRemovedEvents = events.filter((event) => event.type === 'room-member-removed');
    const inviteRotatedEvents = events.filter((event) => event.type === 'room-invite-rotated');
    const messageSavedEvents = events.filter((event) => event.type === 'message-saved');

    const roomIdMap = new Map();
    const roomNameToId = new Map();
    let recoveredRooms = 0;
    let recoveredMessages = 0;

    const existingRooms = await getPool().query('SELECT id, name FROM rooms');
    for (const room of existingRooms[0] || []) {
        roomNameToId.set(normalizeIdentity(room.name), Number(room.id));
    }

    for (const event of roomCreatedEvents) {
        const payload = event.payload || {};
        const roomName = (payload.name || '').toString().trim();
        if (!roomName || roomName.toLowerCase() === 'general') {
            continue;
        }

        try {
            const room = await createRoom(roomName, {
                isPrivate: payload.isPrivate === true,
                ownerUsername: payload.ownerUsername || '',
                members: payload.members || [],
                inviteCode: payload.inviteCode || null
            });

            if (payload.originalRoomId) {
                roomIdMap.set(Number(payload.originalRoomId), Number(room.id));
            }

            roomNameToId.set(normalizeIdentity(room.name), Number(room.id));

            recoveredRooms += 1;
        } catch (error) {
            if (error?.code !== 'ER_DUP_ENTRY') {
                console.warn(`Secure log recovery room hiba: ${error.message}`);
            }
        }
    }

    for (const event of memberAddedEvents) {
        const payload = event.payload || {};
        const mappedRoomId = roomIdMap.get(Number(payload.originalRoomId)) || Number(payload.roomId);
        if (!mappedRoomId) {
            continue;
        }

        try {
            await addRoomMembers(mappedRoomId, payload.usernames || []);
        } catch (_error) {
            // ignore recovery add-member errors
        }
    }

    for (const event of memberRemovedEvents) {
        const payload = event.payload || {};
        const mappedRoomId = roomIdMap.get(Number(payload.originalRoomId)) || Number(payload.roomId);
        if (!mappedRoomId) {
            continue;
        }

        try {
            await removeRoomMember(mappedRoomId, payload.memberUsername || '');
        } catch (_error) {
            // ignore recovery remove-member errors
        }
    }

    for (const event of inviteRotatedEvents) {
        const payload = event.payload || {};
        const mappedRoomId = roomIdMap.get(Number(payload.originalRoomId)) || Number(payload.roomId);
        if (!mappedRoomId) {
            continue;
        }

        try {
            await rotateRoomInviteCode(mappedRoomId, payload.inviteCode || '');
        } catch (_error) {
            // ignore recovery invite errors
        }
    }

    for (const event of messageSavedEvents) {
        const payload = event.payload || {};
        const candidateByName = roomNameToId.get(normalizeIdentity(payload.roomName || ''));
        const candidateByMap = roomIdMap.get(Number(payload.originalRoomId || payload.roomId));
        const mappedRoomId = candidateByName || candidateByMap || Number(payload.roomId);
        const username = (payload.username || '').toString().trim();
        const content = (payload.content || '').toString();
        const messageType = (payload.messageType || 'text').toString();

        if (!mappedRoomId || !username || (messageType !== 'image' && content.length < 1)) {
            continue;
        }

        try {
            const [existing] = await getPool().execute(
                `SELECT id FROM messages
                 WHERE room_id = ? AND username = ? AND content = ? AND message_type = ?
                 ORDER BY id DESC
                 LIMIT 1`,
                [mappedRoomId, username, content, messageType]
            );

            if (Array.isArray(existing) && existing.length > 0) {
                continue;
            }

            const createdAt = payload.createdAt ? new Date(payload.createdAt) : null;
            const hasValidCreatedAt = createdAt && !Number.isNaN(createdAt.getTime());

            if (hasValidCreatedAt) {
                await getPool().execute(
                    `INSERT INTO messages (room_id, username, content, message_type, mime_type, file_path, original_name, ip_optional, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        mappedRoomId,
                        username,
                        content,
                        messageType,
                        payload.mimeType || null,
                        payload.filePath || null,
                        payload.originalName || null,
                        payload.ipOptional || null,
                        createdAt
                    ]
                );
            } else {
                await getPool().execute(
                    `INSERT INTO messages (room_id, username, content, message_type, mime_type, file_path, original_name, ip_optional)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        mappedRoomId,
                        username,
                        content,
                        messageType,
                        payload.mimeType || null,
                        payload.filePath || null,
                        payload.originalName || null,
                        payload.ipOptional || null
                    ]
                );
            }

            recoveredMessages += 1;
        } catch (_error) {
            // ignore individual message recovery errors
        }
    }

    const summary = `Secure log recovery kesz. Helyreallitott szobak: ${recoveredRooms}, uzenetek: ${recoveredMessages}`;
    console.log(summary);
    lastRecoveryStatus = {
        attempted: true,
        ok: recoveredRooms > 0 || recoveredMessages > 0,
        reason: recoveredRooms > 0 || recoveredMessages > 0 ? 'restored' : 'no-applicable-events',
        recoveredRooms,
        recoveredMessages,
        eventsRead: events.length,
        details: summary
    };

    return lastRecoveryStatus;
}

function classifyDbError(error) {
    const code = error?.code || 'UNKNOWN_ERROR';

    if (code === 'ETIMEDOUT') {
        return {
            code,
            category: 'network-timeout',
            hint: 'A MySQL endpoint timeoutol. Ellenorizd a host/port/tuzfal beallitast.'
        };
    }

    if (code === 'ECONNREFUSED') {
        return {
            code,
            category: 'connection-refused',
            hint: 'A MySQL nem fogad kapcsolatot. Inditsd el a szolgaltatast vagy javitsd a DB_HOST/DB_PORT erteket.'
        };
    }

    if (code === 'ER_ACCESS_DENIED_ERROR') {
        return {
            code,
            category: 'auth-failed',
            hint: 'Hibas DB_USER vagy DB_PASSWORD.'
        };
    }

    return {
        code,
        category: 'unknown',
        hint: 'Altalanos DB hiba, futtasd a diag:db parancsot a reszletekert.'
    };
}

async function diagnoseDatabaseConnection() {
    const startedAt = Date.now();
    const candidates = DB_HOST_AUTO ? getDbHostCandidates() : [DB_HOST];
    const base = {
        configuredHost: DB_HOST,
        hostAuto: DB_HOST_AUTO,
        candidates,
        port: DB_PORT,
        user: DB_USER,
        database: DB_NAME,
        timeoutMs: DB_CONNECT_TIMEOUT_MS,
        retries: DB_CONNECT_RETRIES,
        retryDelayMs: DB_RETRY_DELAY_MS
    };

    try {
        const selectedHost = await resolveDbHost();

        const connection = await mysql.createConnection({
            host: selectedHost,
            port: DB_PORT,
            user: DB_USER,
            password: DB_PASSWORD,
            connectTimeout: DB_CONNECT_TIMEOUT_MS
        });

        const [rows] = await connection.query('SELECT 1 AS ok');
        await connection.end();

        return {
            ok: true,
            elapsedMs: Date.now() - startedAt,
            details: {
                ...base,
                selectedHost,
                attempts: lastDbHostResolution?.attempts || [],
                probe: rows?.[0]?.ok === 1 ? 'ok' : 'unexpected'
            }
        };
    } catch (error) {
        const classified = classifyDbError(error);

        return {
            ok: false,
            elapsedMs: Date.now() - startedAt,
            details: {
                ...base,
                selectedHost: null,
                attempts: error?.details?.attempts || lastDbHostResolution?.attempts || [],
                errorCode: classified.code,
                category: classified.category,
                message: error?.message || 'Ismeretlen hiba',
                hint: classified.hint
            }
        };
    }
}

async function ensureSchemaExists(dbPool) {
    await dbPool.query(`
        CREATE TABLE IF NOT EXISTS rooms (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,
            name VARCHAR(100) NOT NULL,
            is_private TINYINT(1) NOT NULL DEFAULT 0,
            owner_username VARCHAR(50) NULL,
            invite_code VARCHAR(32) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_rooms_name (name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await ensureColumnExists(dbPool, 'rooms', 'is_private', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumnExists(dbPool, 'rooms', 'owner_username', 'VARCHAR(50) NULL');
    await ensureColumnExists(dbPool, 'rooms', 'invite_code', 'VARCHAR(32) NULL');

    await dbPool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            room_id INT UNSIGNED NOT NULL,
            username VARCHAR(50) NOT NULL,
            content TEXT NOT NULL,
            message_type ENUM('text', 'code', 'emoji', 'image') NOT NULL DEFAULT 'text',
            mime_type VARCHAR(120) NULL,
            file_path VARCHAR(255) NULL,
            original_name VARCHAR(255) NULL,
            ip_optional VARCHAR(45) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_messages_room_created (room_id, created_at),
            CONSTRAINT fk_messages_room FOREIGN KEY (room_id)
                REFERENCES rooms (id)
                ON DELETE CASCADE
                ON UPDATE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await ensureColumnExists(dbPool, 'messages', 'message_type', "ENUM('text', 'code', 'emoji', 'image') NOT NULL DEFAULT 'text'");
    await ensureColumnExists(dbPool, 'messages', 'mime_type', 'VARCHAR(120) NULL');
    await ensureColumnExists(dbPool, 'messages', 'file_path', 'VARCHAR(255) NULL');
    await ensureColumnExists(dbPool, 'messages', 'original_name', 'VARCHAR(255) NULL');

    await dbPool.query(`
        CREATE TABLE IF NOT EXISTS host_status (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            ip VARCHAR(45) NOT NULL,
            status ENUM('online', 'offline', 'unknown') NOT NULL DEFAULT 'unknown',
            last_seen_at TIMESTAMP NULL,
            last_checked_at TIMESTAMP NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_host_status_ip (ip)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await dbPool.query(`
        CREATE TABLE IF NOT EXISTS connections_log (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            socket_id VARCHAR(120) NOT NULL,
            username VARCHAR(50) NOT NULL,
            client_ip VARCHAR(45) NULL,
            connected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            disconnected_at TIMESTAMP NULL,
            PRIMARY KEY (id),
            KEY idx_connections_connected_at (connected_at),
            KEY idx_connections_socket_id (socket_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await dbPool.query(`
        CREATE TABLE IF NOT EXISTS room_members (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            room_id INT UNSIGNED NOT NULL,
            username VARCHAR(50) NOT NULL,
            added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uq_room_member (room_id, username),
            KEY idx_room_members_room (room_id),
            KEY idx_room_members_username (username),
            CONSTRAINT fk_room_members_room FOREIGN KEY (room_id)
                REFERENCES rooms (id)
                ON DELETE CASCADE
                ON UPDATE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await dbPool.query("INSERT IGNORE INTO rooms (id, name, is_private) VALUES (1, 'general', 0)");
}

async function ensureColumnExists(dbPool, tableName, columnName, definition) {
    const [rows] = await dbPool.execute(
        `SELECT COUNT(*) AS count
         FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
        [DB_NAME, tableName, columnName]
    );

    if (Number(rows[0]?.count || 0) > 0) {
        return;
    }

    await dbPool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
}

function createPool(host) {
    return mysql.createPool({
        host,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
        connectTimeout: DB_CONNECT_TIMEOUT_MS,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });
}

async function initDatabase() {
    if (pool) {
        return pool;
    }

    try {
        const selectedHost = await resolveDbHost();
        const dbInit = await ensureDatabaseExists(selectedHost);
        pool = createPool(selectedHost);
        logEvent('db-connected', {
            selectedHost,
            database: DB_NAME,
            createdNew: dbInit.createdNew
        });

        if (dbInit.createdNew) {
            logEvent('db-created-new', {
                database: DB_NAME
            });
        }
    } catch (error) {
        const classified = classifyDbError(error);
        const enriched = new Error(
            `${classified.hint} (code: ${classified.code}, configuredHost: ${DB_HOST}, selectedHost: ${activeDbHost}, port: ${DB_PORT})`
        );
        enriched.cause = error;
        enriched.details = error?.details;
        throw enriched;
    }

    await ensureSchemaExists(pool);

    const selectedHost = activeDbHost;
    if (selectedHost) {
        const connection = await mysql.createConnection({
            host: selectedHost,
            port: DB_PORT,
            user: DB_USER,
            password: DB_PASSWORD,
            connectTimeout: DB_CONNECT_TIMEOUT_MS
        });

        try {
            const [rows] = await connection.query('SELECT COUNT(*) AS count FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [DB_NAME]);
            const exists = Number(rows?.[0]?.count || 0) > 0;
            if (exists) {
                const [tables] = await pool.query('SELECT COUNT(*) AS count FROM rooms');
                const hasOnlyDefault = Number(tables?.[0]?.count || 0) <= 1;

                if (hasOnlyDefault) {
                    await recoverStateFromSecureLogIfPossible();
                } else {
                    lastRecoveryStatus = {
                        attempted: false,
                        ok: false,
                        reason: 'skipped-existing-data',
                        recoveredRooms: 0,
                        recoveredMessages: 0,
                        eventsRead: 0,
                        details: 'Recovery skipped because database already has data.'
                    };
                }
            }
        } finally {
            await connection.end();
        }
    }

    return pool;
}

function getDatabaseRuntimeInfo() {
    return {
        configuredHost: DB_HOST,
        activeHost: activeDbHost,
        hostAuto: DB_HOST_AUTO,
        candidates: DB_HOST_AUTO ? getDbHostCandidates() : [DB_HOST],
        lastResolution: lastDbHostResolution,
        recovery: lastRecoveryStatus
    };
}

function getRecoveryStatus() {
    return { ...lastRecoveryStatus };
}

function getPool() {
    if (!pool) {
        throw new Error('Az adatbazis pool meg nincs inicializalva. Hivd meg eloszor az initDatabase fuggvenyt.');
    }

    return pool;
}

//!SQL Queries
async function selectall() {
    const query = 'SELECT * FROM rooms ORDER BY id ASC;';
    const [rows] = await getPool().execute(query);
    return rows;
}

async function getRooms(usernameOptional = null) {
    const username = normalizeIdentity(usernameOptional);

    if (!username) {
        const [rows] = await getPool().query(
            `SELECT id, name, created_at, is_private, owner_username
             FROM rooms
             WHERE is_private = 0
             ORDER BY created_at ASC, id ASC`
        );
        return rows;
    }

    const [rows] = await getPool().execute(
        `SELECT r.id, r.name, r.created_at, r.is_private, r.owner_username
         FROM rooms r
         LEFT JOIN room_members rm
            ON rm.room_id = r.id AND rm.username = ?
         WHERE r.is_private = 0 OR rm.id IS NOT NULL
         ORDER BY r.created_at ASC, r.id ASC`,
        [username]
    );

    return rows;
}

async function getRoomAccess(roomId, usernameOptional = null) {
    const username = normalizeIdentity(usernameOptional);
    const room = await getRoomById(roomId);

    if (!room) {
        return null;
    }

    if (Number(room.is_private) !== 1) {
        return {
            ...room,
            hasAccess: true,
            isOwner: false,
            isMember: false
        };
    }

    if (!username) {
        return {
            ...room,
            hasAccess: false,
            isOwner: false,
            isMember: false
        };
    }

    const [memberRows] = await getPool().execute(
        'SELECT id FROM room_members WHERE room_id = ? AND username = ? LIMIT 1',
        [roomId, username]
    );

    const isOwner = normalizeIdentity(room.owner_username) === username;
    const isMember = memberRows.length > 0;

    return {
        ...room,
        hasAccess: isOwner || isMember,
        isOwner,
        isMember
    };
}

async function addRoomMembers(roomId, usernames) {
    const normalized = Array.from(
        new Set(
            (usernames || [])
                .map((item) => normalizeIdentity(item))
                .filter((item) => item.length >= 2)
        )
    );

    if (!normalized.length) {
        return;
    }

    const values = normalized.map((username) => [roomId, username]);
    await getPool().query('INSERT IGNORE INTO room_members (room_id, username) VALUES ?', [values]);
    logEvent('room-members-added', {
        roomId,
        originalRoomId: roomId,
        usernames: normalized
    });
}

async function createRoom(name, options = {}) {
    const isPrivate = options.isPrivate === true;
    const ownerUsername = normalizeIdentity(options.ownerUsername || null) || null;
    const members = Array.isArray(options.members) ? options.members : [];
    const inviteCode = normalizeIdentity(options.inviteCode || '').toUpperCase() || null;

    const [result] = await getPool().execute(
        'INSERT INTO rooms (name, is_private, owner_username, invite_code) VALUES (?, ?, ?, ?)',
        [name, isPrivate ? 1 : 0, ownerUsername, isPrivate ? inviteCode : null]
    );

    if (isPrivate) {
        await addRoomMembers(result.insertId, [ownerUsername, ...members]);
    }

    const [rows] = await getPool().execute(
        'SELECT id, name, created_at, is_private, owner_username, invite_code FROM rooms WHERE id = ?',
        [result.insertId]
    );

    logEvent('room-created', {
        originalRoomId: result.insertId,
        name,
        isPrivate,
        ownerUsername,
        inviteCode,
        members: [ownerUsername, ...members].filter((item) => !!item)
    });

    return rows[0];
}

async function getMessagesByRoom(roomId, limit = 50) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const [rows] = await getPool().execute(
        `SELECT id, room_id, username, content, message_type, mime_type, file_path, original_name, ip_optional, created_at
         FROM messages
         WHERE room_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [roomId, safeLimit]
    );

    return rows.reverse();
}

async function searchMessagesByRoom(roomId, searchQuery, limit = 50) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const normalized = `%${searchQuery.trim()}%`;

    const [rows] = await getPool().execute(
        `SELECT id, room_id, username, content, message_type, mime_type, file_path, original_name, ip_optional, created_at
         FROM messages
         WHERE room_id = ? AND content LIKE ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [roomId, normalized, safeLimit]
    );

    return rows.reverse();
}

async function saveMessage({
    roomId,
    username,
    content,
    messageType = 'text',
    mimeType = null,
    filePath = null,
    originalName = null,
    ipOptional = null
}) {
    const [result] = await getPool().execute(
        `INSERT INTO messages (room_id, username, content, message_type, mime_type, file_path, original_name, ip_optional)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [roomId, username, content, messageType, mimeType, filePath, originalName, ipOptional]
    );

    const [rows] = await getPool().execute(
        `SELECT id, room_id, username, content, message_type, mime_type, file_path, original_name, ip_optional, created_at
         FROM messages
         WHERE id = ?`,
        [result.insertId]
    );

    logEvent('message-saved', {
        roomId,
        originalRoomId: roomId,
        roomName: (await getRoomById(roomId))?.name || null,
        username,
        content,
        messageType,
        mimeType,
        filePath,
        originalName,
        ipOptional,
        createdAt: rows[0]?.created_at || null
    });

    return rows[0];
}

async function ensureHosts(ips) {
    if (!Array.isArray(ips) || ips.length === 0) {
        return;
    }

    const values = ips.map((ip) => [ip, 'unknown']);
    await getPool().query('INSERT IGNORE INTO host_status (ip, status) VALUES ?', [values]);
}

async function updateHostStatuses(statuses) {
    if (!Array.isArray(statuses) || statuses.length === 0) {
        return;
    }

    const query = `
        INSERT INTO host_status (ip, status, last_seen_at, last_checked_at)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            status = VALUES(status),
            last_checked_at = VALUES(last_checked_at),
            last_seen_at = CASE
                WHEN VALUES(status) = 'online' THEN VALUES(last_seen_at)
                ELSE host_status.last_seen_at
            END
    `;

    const connection = await getPool().getConnection();

    try {
        await connection.beginTransaction();

        for (const item of statuses) {
            const lastSeenAt = item.status === 'online' ? item.lastSeenAt : null;
            await connection.execute(query, [item.ip, item.status, lastSeenAt, item.lastCheckedAt]);
        }

        await connection.commit();
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rollbackError) {
            console.error('Rollback error:', rollbackError.message);
        }
        throw error;
    } finally {
        try {
            connection.release();
        } catch (releaseError) {
            console.error('Connection release error:', releaseError.message);
        }
    }
}

async function getHostStatuses() {
    const [rows] = await getPool().query(
        `SELECT id, ip, status, last_seen_at, last_checked_at
         FROM host_status
         ORDER BY INET_ATON(ip) ASC, ip ASC`
    );

    return rows;
}

async function getStatsSummary() {
    const [roomsRows] = await getPool().query('SELECT COUNT(*) AS totalRooms FROM rooms');
    const [messagesRows] = await getPool().query('SELECT COUNT(*) AS totalMessages FROM messages');
    const [todayRows] = await getPool().query(
        'SELECT COUNT(*) AS messagesToday FROM messages WHERE DATE(created_at) = CURRENT_DATE()'
    );
    const [onlineRows] = await getPool().query(
        "SELECT COUNT(*) AS hostsOnline FROM host_status WHERE status = 'online'"
    );

    return {
        totalRooms: Number(roomsRows[0]?.totalRooms || 0),
        totalMessages: Number(messagesRows[0]?.totalMessages || 0),
        messagesToday: Number(todayRows[0]?.messagesToday || 0),
        hostsOnline: Number(onlineRows[0]?.hostsOnline || 0)
    };
}

async function getRoomById(roomId) {
    const [rows] = await getPool().execute(
        'SELECT id, name, created_at, is_private, owner_username, invite_code FROM rooms WHERE id = ?',
        [roomId]
    );
    return rows[0] || null;
}

async function getRoomByIdForUser(roomId, usernameOptional = null) {
    const username = normalizeIdentity(usernameOptional);

    if (!username) {
        const [rows] = await getPool().execute(
            `SELECT id, name, created_at, is_private, owner_username, invite_code
             FROM rooms
             WHERE id = ? AND is_private = 0`,
            [roomId]
        );
        return rows[0] || null;
    }

    const [rows] = await getPool().execute(
        `SELECT r.id, r.name, r.created_at, r.is_private, r.owner_username, r.invite_code
         FROM rooms r
         LEFT JOIN room_members rm
            ON rm.room_id = r.id AND rm.username = ?
         WHERE r.id = ? AND (r.is_private = 0 OR rm.id IS NOT NULL)
         LIMIT 1`,
        [username, roomId]
    );

    return rows[0] || null;
}

async function joinPrivateRoomByInvite(roomId, usernameOptional, inviteCodeOptional) {
    const username = normalizeIdentity(usernameOptional);
    const inviteCode = normalizeIdentity(inviteCodeOptional).toUpperCase();

    if (!username || !inviteCode) {
        return { ok: false, reason: 'invalid-input' };
    }

    const room = await getRoomById(roomId);
    if (!room || Number(room.is_private) !== 1) {
        return { ok: false, reason: 'room-not-found' };
    }

    if ((room.invite_code || '').toUpperCase() !== inviteCode) {
        return { ok: false, reason: 'invalid-code' };
    }

    await addRoomMembers(roomId, [username]);
    return { ok: true };
}

async function getRoomMembers(roomId) {
    const [rows] = await getPool().execute(
        `SELECT username, added_at
         FROM room_members
         WHERE room_id = ?
         ORDER BY username ASC`,
        [roomId]
    );

    return rows;
}

async function removeRoomMember(roomId, memberUsernameOptional) {
    const memberUsername = normalizeIdentity(memberUsernameOptional);

    if (!memberUsername) {
        return 0;
    }

    const [result] = await getPool().execute(
        'DELETE FROM room_members WHERE room_id = ? AND username = ? LIMIT 1',
        [roomId, memberUsername]
    );

    if (Number(result.affectedRows || 0) > 0) {
        logEvent('room-member-removed', {
            roomId,
            originalRoomId: roomId,
            memberUsername
        });
    }

    return Number(result.affectedRows || 0);
}

async function rotateRoomInviteCode(roomId, inviteCodeOptional) {
    const inviteCode = normalizeIdentity(inviteCodeOptional).toUpperCase();

    if (!inviteCode) {
        return 0;
    }

    const [result] = await getPool().execute(
        'UPDATE rooms SET invite_code = ? WHERE id = ? AND is_private = 1',
        [inviteCode, roomId]
    );

    if (Number(result.affectedRows || 0) > 0) {
        logEvent('room-invite-rotated', {
            roomId,
            originalRoomId: roomId,
            inviteCode
        });
    }

    return Number(result.affectedRows || 0);
}

async function logConnection({ socketId, username, clientIp }) {
    const [result] = await getPool().execute(
        'INSERT INTO connections_log (socket_id, username, client_ip) VALUES (?, ?, ?)',
        [socketId, username, clientIp || null]
    );
    return result.insertId;
}

async function closeConnectionLog(socketId) {
    await getPool().execute(
        `UPDATE connections_log
         SET disconnected_at = CURRENT_TIMESTAMP
         WHERE socket_id = ? AND disconnected_at IS NULL`,
        [socketId]
    );
}

//!Export
module.exports = {
    initDatabase,
    diagnoseDatabaseConnection,
    getDatabaseRuntimeInfo,
    getRecoveryStatus,
    getPool,
    selectall,
    getRooms,
    getRoomAccess,
    getRoomById,
    getRoomByIdForUser,
    joinPrivateRoomByInvite,
    getRoomMembers,
    removeRoomMember,
    rotateRoomInviteCode,
    createRoom,
    getMessagesByRoom,
    searchMessagesByRoom,
    saveMessage,
    ensureHosts,
    updateHostStatuses,
    getHostStatuses,
    getStatsSummary,
    logConnection,
    closeConnectionLog
};
