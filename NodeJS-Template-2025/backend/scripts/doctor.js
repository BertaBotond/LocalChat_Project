require('dotenv').config();

const { getRuntimeConfig } = require('../config/runtime.js');
const { diagnoseDatabaseConnection } = require('../sql/database.js');

async function main() {
    const runtime = getRuntimeConfig();
    const db = await diagnoseDatabaseConnection();

    const report = {
        timestamp: new Date().toISOString(),
        nodeVersion: process.version,
        runtime: {
            serverHost: runtime.serverHost,
            serverPort: runtime.serverPort,
            lanOnly: runtime.lanOnly,
            discoveryMode: runtime.discoveryMode,
            autoRangeEnabled: runtime.autoRangeEnabled,
            ipBase: runtime.ipBase,
            ipStart: runtime.ipStart,
            ipEnd: runtime.ipEnd,
            preferredInterface: runtime.networkDiagnostics?.preferredInterface || null,
            connectUrls: runtime.networkDiagnostics?.connectUrls || []
        },
        database: db,
        ready: db.ok
    };

    console.log(JSON.stringify(report, null, 2));

    if (!report.ready) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(
        JSON.stringify(
            {
                status: 'fatal',
                message: error?.message || 'Ismeretlen hiba'
            },
            null,
            2
        )
    );
    process.exit(1);
});
