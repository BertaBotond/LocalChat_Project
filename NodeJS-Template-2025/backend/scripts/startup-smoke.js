require('dotenv').config();

const database = require('../sql/database.js');
const { runStartupSmokeTests } = require('../security/startup-smoke.js');

async function main() {
    await database.initDatabase();
    const report = await runStartupSmokeTests({
        database,
        context: 'cli-smoke'
    });

    console.log(JSON.stringify(report, null, 2));

    if (!report.ok) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(
        JSON.stringify(
            {
                status: 'fatal',
                message: error?.message || 'Startup smoke futtatas sikertelen.'
            },
            null,
            2
        )
    );
    process.exit(1);
});
