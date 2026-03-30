const { getSecureLogStatus, readRecoveryEvents, logEvent } = require('../logging/secure-log.js');

function createCheck(name, ok, severity, details) {
    return {
        name,
        ok,
        severity,
        details
    };
}

function summarize(checks) {
    const criticalFailed = checks.some((item) => item.severity === 'critical' && !item.ok);
    const warningFailed = checks.some((item) => item.severity === 'warning' && !item.ok);

    return {
        ok: !criticalFailed,
        status: criticalFailed ? 'failed' : warningFailed ? 'warning' : 'ok'
    };
}

async function runStartupSmokeTests({ database, context = 'startup' }) {
    const startedAt = Date.now();
    const checks = [];

    const logKey = (process.env.LOG_ENCRYPTION_KEY || '').trim();
    checks.push(
        createCheck(
            'env-log-encryption-key',
            logKey.length >= 32,
            'critical',
            logKey.length >= 32
                ? 'LOG_ENCRYPTION_KEY megfelelo hosszu.'
                : 'LOG_ENCRYPTION_KEY tul rovid vagy hianyzik (min 32 karakter ajanlott).'
        )
    );

    const adminToken = (process.env.ADMIN_TOKEN || '').trim();
    checks.push(
        createCheck(
            'env-admin-token',
            adminToken.length >= 16,
            'warning',
            adminToken.length >= 16
                ? 'ADMIN_TOKEN beallitva.'
                : 'ADMIN_TOKEN nincs beallitva vagy tul rovid (admin API vedelme gyengebb).'
        )
    );

    const dbDiagnose = await database.diagnoseDatabaseConnection();
    checks.push(
        createCheck(
            'db-connectivity',
            dbDiagnose.ok,
            'critical',
            dbDiagnose.ok
                ? `DB elerheto (${dbDiagnose.details?.selectedHost || 'n/a'})`
                : `DB nem elerheto: ${dbDiagnose.details?.message || 'unknown'}`
        )
    );

    try {
        const pool = database.getPool();
        const [pingRows] = await pool.query('SELECT 1 AS ok');
        checks.push(
            createCheck(
                'db-query-ping',
                Number(pingRows?.[0]?.ok || 0) === 1,
                'critical',
                'SELECT 1 teszt lefutott.'
            )
        );

        const [tableRows] = await pool.query(
            `SELECT COUNT(*) AS count
             FROM information_schema.tables
             WHERE table_schema = ?
               AND table_name IN ('rooms', 'messages', 'host_status', 'connections_log', 'room_members')`,
            [process.env.DB_NAME || 'localchat']
        );

        const tableCount = Number(tableRows?.[0]?.count || 0);
        checks.push(
            createCheck(
                'db-required-tables',
                tableCount >= 5,
                'critical',
                `Megtalalt kritikus tablakszam: ${tableCount}/5`
            )
        );
    } catch (error) {
        checks.push(
            createCheck('db-query-ping', false, 'critical', `DB query smoke hiba: ${error.message || 'unknown'}`)
        );
    }

    const secureLogStatus = getSecureLogStatus();
    checks.push(
        createCheck(
            'secure-log-runtime',
            secureLogStatus.exists || secureLogStatus.queuedEntries >= 0,
            'warning',
            secureLogStatus.exists
                ? `Titkositott log elerheto: ${secureLogStatus.path}`
                : 'Titkositott log file meg nem letezik (letrejon az elso flush utan).'
        )
    );

    const recoveryRead = readRecoveryEvents();
    const recoveryReadable = recoveryRead.ok || recoveryRead.reason === 'missing-log-file';
    checks.push(
        createCheck(
            'secure-log-recovery-read',
            recoveryReadable,
            'warning',
            recoveryRead.ok
                ? `Recovery log olvashato (eventek: ${(recoveryRead.events || []).length}).`
                : `Recovery log status: ${recoveryRead.reason || 'unknown'}`
        )
    );

    const summary = summarize(checks);
    const report = {
        context,
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        ...summary,
        checks
    };

    logEvent('startup-smoke-report', {
        context,
        status: report.status,
        ok: report.ok,
        elapsedMs: report.elapsedMs,
        failedChecks: checks.filter((item) => !item.ok).map((item) => item.name)
    });

    return report;
}

module.exports = {
    runStartupSmokeTests
};
