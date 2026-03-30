const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const logDir = path.join(__dirname, '../logs');
const logFilePath = path.join(logDir, 'secure-server.log.enc');
const flushIntervalMs = Math.max(1000, Number(process.env.SECURE_LOG_FLUSH_MS) || 2500);
const batchMaxSize = Math.max(5, Number(process.env.SECURE_LOG_BATCH_SIZE) || 25);
const maxRecoveryEvents = Math.max(50, Number(process.env.SECURE_LOG_RECOVERY_LIMIT) || 1200);
const rotateMaxBytes = Math.max(256 * 1024, Number(process.env.SECURE_LOG_ROTATE_MAX_BYTES) || 5 * 1024 * 1024);
const rotateFiles = Math.max(2, Number(process.env.SECURE_LOG_ROTATE_FILES) || 5);

let buffer = [];
let flushTimer = null;
let writeQueue = Promise.resolve();
let installed = false;
let originals = null;
let lastFlushAt = null;
let lastError = null;

function getKeyMaterial() {
    const fromEnv = (process.env.LOG_ENCRYPTION_KEY || '').trim();

    if (fromEnv.length >= 32) {
        return crypto.createHash('sha256').update(fromEnv).digest();
    }

    const fallbackSeed = [
        process.env.DB_NAME || 'localchat',
        process.env.DB_USER || 'root',
        process.env.DB_HOST || '127.0.0.1',
        process.env.SERVER_PORT || '3000'
    ].join('|');

    return crypto.createHash('sha256').update(fallbackSeed).digest();
}

function ensureLogDir() {
    fs.mkdirSync(logDir, { recursive: true });
}

function getRotatedPaths() {
    const paths = [logFilePath];

    for (let index = 1; index <= rotateFiles; index += 1) {
        paths.push(`${logFilePath}.${index}`);
    }

    return paths;
}

function rotateIfNeeded() {
    if (!fs.existsSync(logFilePath)) {
        return;
    }

    const stats = fs.statSync(logFilePath);
    if (stats.size < rotateMaxBytes) {
        return;
    }

    for (let index = rotateFiles; index >= 1; index -= 1) {
        const source = index === 1 ? logFilePath : `${logFilePath}.${index - 1}`;
        const target = `${logFilePath}.${index}`;

        if (fs.existsSync(target) && index === rotateFiles) {
            fs.unlinkSync(target);
        }

        if (fs.existsSync(source)) {
            fs.renameSync(source, target);
        }
    }
}

function encryptPayload(payload) {
    const key = getKeyMaterial();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: encrypted.toString('base64')
    };
}

function decryptPayload(record) {
    const key = getKeyMaterial();
    const iv = Buffer.from(record.iv, 'base64');
    const tag = Buffer.from(record.tag, 'base64');
    const encrypted = Buffer.from(record.data, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
}

function queueWrite(line) {
    writeQueue = writeQueue
        .then(async () => {
            ensureLogDir();
            rotateIfNeeded();
            await fs.promises.appendFile(logFilePath, line + '\n', 'utf8');
            lastFlushAt = new Date().toISOString();
            lastError = null;
        })
        .catch((error) => {
            lastError = error?.message || 'secure-log-write-error';
            // swallow write errors to keep app responsive
        });

    return writeQueue;
}

function flushNow() {
    if (!buffer.length) {
        return Promise.resolve();
    }

    const batch = buffer.splice(0, batchMaxSize);
    const payload = {
        timestamp: new Date().toISOString(),
        host: os.hostname(),
        batch
    };

    const encrypted = encryptPayload(payload);
    return queueWrite(JSON.stringify(encrypted));
}

function scheduleFlush() {
    if (flushTimer) {
        return;
    }

    flushTimer = setInterval(() => {
        flushNow();
    }, flushIntervalMs);

    if (typeof flushTimer.unref === 'function') {
        flushTimer.unref();
    }
}

function truncate(value, maxLength = 1200) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text) {
        return '';
    }

    return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated>` : text;
}

function logEvent(type, payload = {}) {
    try {
        buffer.push({
            ts: Date.now(),
            type,
            payload
        });

        if (buffer.length >= batchMaxSize) {
            flushNow();
        }
    } catch (_error) {
        // noop
    }
}

function installConsoleCapture() {
    if (installed) {
        return;
    }

    originals = {
        log: console.log,
        warn: console.warn,
        error: console.error
    };

    for (const level of ['log', 'warn', 'error']) {
        console[level] = (...args) => {
            originals[level](...args);

            try {
                const message = args.map((item) => truncate(item)).join(' ');
                logEvent('console', { level, message });
            } catch (_error) {
                // noop
            }
        };
    }

    scheduleFlush();
    installed = true;
}

function flushSync() {
    try {
        if (!buffer.length) {
            return;
        }

        ensureLogDir();
        const payload = {
            timestamp: new Date().toISOString(),
            host: os.hostname(),
            batch: buffer.splice(0, buffer.length)
        };

        const encrypted = encryptPayload(payload);
        rotateIfNeeded();
        fs.appendFileSync(logFilePath, JSON.stringify(encrypted) + '\n', 'utf8');
        lastFlushAt = new Date().toISOString();
        lastError = null;
    } catch (_error) {
        // noop
    }
}

function initializeSecureLogging() {
    installConsoleCapture();

    process.on('beforeExit', flushSync);
    process.on('SIGINT', () => {
        flushSync();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        flushSync();
        process.exit(0);
    });
}

function hasSecureLogFile() {
    return fs.existsSync(logFilePath);
}

function getSecureLogStatus() {
    return {
        path: logFilePath,
        exists: hasSecureLogFile(),
        queuedEntries: buffer.length,
        flushIntervalMs,
        batchMaxSize,
        rotateMaxBytes,
        rotateFiles,
        maxRecoveryEvents,
        lastFlushAt,
        lastError
    };
}

function readRecoveryEvents() {
    const files = getRotatedPaths().filter((filePath) => fs.existsSync(filePath));

    if (!files.length) {
        return { ok: false, reason: 'missing-log-file', events: [] };
    }

    try {
        const events = [];

        for (const filePath of files.reverse()) {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.length > 0);

            for (const line of lines) {
                try {
                    const encrypted = JSON.parse(line);
                    const payload = decryptPayload(encrypted);
                    const batch = Array.isArray(payload.batch) ? payload.batch : [];

                    for (const event of batch) {
                        events.push(event);
                    }
                } catch (_error) {
                    // ignore malformed lines
                }
            }
        }

        return {
            ok: true,
            reason: 'ok',
            events: events.slice(-maxRecoveryEvents)
        };
    } catch (error) {
        return {
            ok: false,
            reason: 'read-or-decrypt-error',
            message: error?.message || 'unknown',
            events: []
        };
    }
}

module.exports = {
    initializeSecureLogging,
    logEvent,
    flushNow,
    flushSync,
    hasSecureLogFile,
    getSecureLogStatus,
    readRecoveryEvents,
    logFilePath
};
