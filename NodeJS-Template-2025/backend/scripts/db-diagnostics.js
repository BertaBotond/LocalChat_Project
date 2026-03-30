require('dotenv').config();

const { diagnoseDatabaseConnection } = require('../sql/database.js');

async function main() {
    const result = await diagnoseDatabaseConnection();

    if (result.ok) {
        console.log(JSON.stringify({ status: 'ok', ...result }, null, 2));
        process.exit(0);
        return;
    }

    console.log(JSON.stringify({ status: 'error', ...result }, null, 2));
    process.exit(1);
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
