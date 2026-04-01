/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { decidePreRunStrategy, printDecision } = require('./pre-run-strategy.js');

const backendRoot = path.resolve(__dirname, '..');
const envPath = path.join(backendRoot, '.env');
const envExamplePath = path.join(backendRoot, '.env.example');
const envSharedExamplePath = path.join(backendRoot, '.env.shared.example');
const nodeModulesPath = path.join(backendRoot, 'node_modules');

function printSection(title) {
    console.log(`\n=== ${title} ===`);
}

function printInfo(message) {
    console.log(`[INFO] ${message}`);
}

function printOk(message) {
    console.log(`[OK] ${message}`);
}

function printWarn(message) {
    console.warn(`[WARN] ${message}`);
}

function printError(message) {
    console.error(`[ERROR] ${message}`);
}

function ensureEnvFile() {
    if (fs.existsSync(envPath)) {
        printOk('.env mar letezik.');
        return;
    }

    if (fs.existsSync(envSharedExamplePath)) {
        fs.copyFileSync(envSharedExamplePath, envPath);
        printWarn('.env nem volt jelen, letrehozva a .env.shared.example alapjan.');
        return;
    }

    if (!fs.existsSync(envExamplePath)) {
        throw new Error('.env hianyzik, es .env.example/.env.shared.example sem talalhato.');
    }

    fs.copyFileSync(envExamplePath, envPath);
    printWarn('.env nem volt jelen, letrehozva a .env.example alapjan.');
}

function getNpmCommand() {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function getNpxCommand() {
    return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function runNpmInstall() {
    printSection('Fuggosegek telepitese');

    const hasNodeModules = fs.existsSync(nodeModulesPath);
    if (hasNodeModules) {
        printOk('node_modules mar letezik, telepites kihagyva.');
        return;
    }

    printInfo('node_modules hianyzik, npm install futtatasa...');

    const result = spawnSync(getNpmCommand(), ['install'], {
        cwd: backendRoot,
        stdio: 'inherit'
    });

    if (result.status !== 0) {
        throw new Error('Az npm install sikertelen volt. Ellenorizd az internetkapcsolatot es az npm beallitast.');
    }

    printOk('npm install sikeres.');
}

async function runDoctorCheck() {
    printSection('Rendszerellenorzes');

    const { getRuntimeConfig } = require('../config/runtime.js');
    const { diagnoseDatabaseConnection } = require('../sql/database.js');

    const runtime = getRuntimeConfig();
    const db = await diagnoseDatabaseConnection();

    const urls = runtime.networkDiagnostics?.connectUrls || [];
    printInfo('Kliens csatlakozasi URL-ek:');
    for (const url of urls) {
        console.log(`  - ${url}`);
    }

    if (db.ok) {
        printOk('Adatbazis kapcsolat rendben.');
        return;
    }

    const details = db.details || {};
    const errorCode = details.errorCode || 'UNKNOWN_ERROR';
    const category = details.category || 'unknown';
    const hint = details.hint || 'Nincs javitasi tipp.';

    printError('A szerver nem indithato, mert az adatbazis kapcsolat nem mukodik.');
    printError(`Hiba kod: ${errorCode}`);
    printError(`Hiba kategoria: ${category}`);
    printError(`Ok: ${details.message || 'Ismeretlen hiba'}`);
    printError(`Javaslat: ${hint}`);

    const attempts = Array.isArray(details.attempts) ? details.attempts : [];
    if (attempts.length > 0) {
        printInfo('Probalkozasok:');
        for (const attempt of attempts) {
            console.log(
                `  - host=${attempt.host} | ok=${attempt.ok} | code=${attempt.errorCode || 'none'} | round=${attempt.round || 1} | elapsedMs=${attempt.elapsedMs}`
            );
        }
    }

    throw new Error('Az inditas megszakadt a DB hiba miatt.');
}

async function startServer() {
    printSection('Szerver inditas');
    printInfo('A szerver indul, varj par masodpercet...');

    const { startServer } = require('../server.js');
    return startServer();
}

function startTunnelIfNeeded(strategy, activePort) {
    if (strategy.method !== 'tunnel') {
        return;
    }

    printSection('Alagut mod (LocalTunnel)');
    printInfo('Publikus tunnel inditasa automatikusan...');

    const child = spawn(getNpxCommand(), ['--yes', 'localtunnel', '--port', String(activePort)], {
        cwd: backendRoot,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let published = false;
    const urlRegex = /https:\/\/[^\s]+/i;

    const handleChunk = (chunk, logMethod = console.log) => {
        const text = String(chunk || '').trim();
        if (!text) {
            return;
        }

        const match = text.match(urlRegex);
        if (match && !published) {
            published = true;
            printOk(`Tunnel URL: ${match[0]}`);
            printWarn('Ezt a publikus URL-t oszd meg a kliensekkel, ha LAN-on nem erheto el a szerver.');
        }

        logMethod(`[TUNNEL] ${text}`);
    };

    child.stdout.on('data', (chunk) => handleChunk(chunk, console.log));
    child.stderr.on('data', (chunk) => handleChunk(chunk, console.warn));

    child.on('close', (code) => {
        printWarn(`LocalTunnel leallt (exit code: ${code}).`);
    });

    process.on('exit', () => {
        try {
            child.kill();
        } catch (error) {
            // no-op
        }
    });
}

async function main() {
    printSection('LocalChat backend one-command inditas');
    printInfo(`Node verzio: ${process.version}`);

    ensureEnvFile();
    runNpmInstall();

    const strategy = await decidePreRunStrategy();
    printDecision(strategy);

    if (Number(strategy.chosenPort) > 0) {
        process.env.SERVER_PORT = String(strategy.chosenPort);
        printInfo(`SERVER_PORT automatikusan beallitva: ${process.env.SERVER_PORT}`);
    }

    await runDoctorCheck();
    const serverRuntime = await startServer();
    startTunnelIfNeeded(strategy, serverRuntime?.activePort || Number(process.env.SERVER_PORT) || 3000);
}

main().catch((error) => {
    printSection('Sikertelen inditas');
    printError(error?.message || 'Ismeretlen hiba tortent.');
    printInfo('Reszletes ellenorzeshez futtasd: npm run doctor');
    process.exit(1);
});
