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

function parseTunnelProviders() {
    const raw = String(process.env.TUNNEL_PROVIDER || 'auto').trim().toLowerCase();

    if (raw === 'ngrok') {
        return ['ngrok'];
    }

    if (raw === 'localtunnel') {
        return ['localtunnel'];
    }

    return ['ngrok', 'localtunnel'];
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

function startTunnelProcess(provider, activePort) {
    const npxCommand = getNpxCommand();

    if (provider === 'ngrok') {
        const args = ['--yes', 'ngrok', 'http', String(activePort), '--log', 'stdout'];
        const region = String(process.env.NGROK_REGION || '').trim();

        if (region) {
            args.push('--region', region);
        }

        const env = { ...process.env };
        const token = String(process.env.NGROK_AUTHTOKEN || '').trim();
        if (token) {
            env.NGROK_AUTHTOKEN = token;
        }

        return spawn(npxCommand, args, {
            cwd: backendRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            env
        });
    }

    return spawn(npxCommand, ['--yes', 'localtunnel', '--port', String(activePort)], {
        cwd: backendRoot,
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function startTunnelIfNeeded(strategy, activePort) {
    if (strategy.method !== 'tunnel') {
        return;
    }

    printSection('Alagut mod (Auto)');
    printInfo('Publikus tunnel inditasa automatikusan (ngrok/localtunnel)...');

    const providers = parseTunnelProviders();
    const urlRegex = /https:\/\/[^\s]+/i;
    let activeChild = null;
    let currentProviderIndex = -1;
    let published = false;

    const attachProcess = (child, provider) => {
        const providerTag = provider.toUpperCase();

        const handleChunk = (chunk, logMethod = console.log) => {
            const text = String(chunk || '').trim();
            if (!text) {
                return;
            }

            const match = text.match(urlRegex);
            if (match && !published) {
                published = true;
                printOk(`Tunnel URL (${provider}): ${match[0]}`);
                printWarn('Ezt a publikus URL-t oszd meg a kliensekkel, ha LAN-on nem erheto el a szerver.');
            }

            logMethod(`[${providerTag}] ${text}`);
        };

        child.stdout.on('data', (chunk) => handleChunk(chunk, console.log));
        child.stderr.on('data', (chunk) => handleChunk(chunk, console.warn));

        child.on('close', (code) => {
            const fallbackAllowed = !published && currentProviderIndex < providers.length - 1;

            if (fallbackAllowed) {
                printWarn(`${provider} leallt (exit code: ${code}), fallback a kovetkezo providerre...`);
                startProvider(currentProviderIndex + 1);
                return;
            }

            printWarn(`${provider} tunnel leallt (exit code: ${code}).`);
        });
    };

    const startProvider = (index) => {
        currentProviderIndex = index;
        const provider = providers[index];

        if (!provider) {
            printError('Nem sikerult tunnel providert inditani (ngrok/localtunnel).');
            return;
        }

        printInfo(`Tunnel provider inditas: ${provider}`);
        activeChild = startTunnelProcess(provider, activePort);
        attachProcess(activeChild, provider);
    };

    startProvider(0);

    process.on('exit', () => {
        try {
            activeChild?.kill();
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
