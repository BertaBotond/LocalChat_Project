require('dotenv').config();

const path = require('path');
const { spawn } = require('child_process');
const { getRuntimeConfig } = require('../config/runtime.js');

const DEFAULT_TIMEOUT_MS = 15000;

function parsePortCandidates(raw) {
    const fallback = [8080, 80, 443];
    const value = String(raw || '').trim();

    if (!value) {
        return fallback;
    }

    const parsed = value
        .split(',')
        .map((item) => Number(String(item).trim()))
        .filter((item) => Number.isInteger(item) && item > 0 && item < 65536);

    if (!parsed.length) {
        return fallback;
    }

    return Array.from(new Set(parsed));
}

function runNodeScriptJson(scriptFile, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const fullPath = path.join(__dirname, scriptFile);
        const child = spawn(process.execPath, [fullPath], {
            cwd: path.join(__dirname, '..'),
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) {
                return;
            }

            settled = true;
            child.kill();
            resolve({
                ok: false,
                timedOut: true,
                exitCode: -1,
                parsed: null,
                stdout,
                stderr
            });
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('close', (code) => {
            if (settled) {
                return;
            }

            clearTimeout(timer);
            settled = true;

            let parsed = null;
            try {
                parsed = JSON.parse(stdout);
            } catch (error) {
                parsed = null;
            }

            resolve({
                ok: code === 0,
                timedOut: false,
                exitCode: code,
                parsed,
                stdout,
                stderr
            });
        });
    });
}

function buildSignals(runtime, computerParsed, networkParsed) {
    const likelyIssues = Array.isArray(computerParsed?.likelyIssues) ? computerParsed.likelyIssues : [];
    const probes = computerParsed?.probes || {};

    const localhostOk = probes.localhostConnect?.ok === true;
    const lanProbeOk = probes.lanConnect?.ok === true;
    const bindAnyOk = probes.bindAny?.ok === true;
    const bindLocalhostOk = probes.bindLocalhost?.ok === true;

    const firewallLikely = likelyIssues.some((item) =>
        String(item).toLowerCase().includes('windows firewall')
    );

    const bindProblem = !bindAnyOk || !bindLocalhostOk;
    const lanIsolationLikely = localhostOk && !lanProbeOk && !firewallLikely;
    const lanReadinessFailed = computerParsed?.readyForLanClients === false;

    return {
        currentPort: runtime.serverPort,
        localhostOk,
        lanProbeOk,
        bindAnyOk,
        bindLocalhostOk,
        firewallLikely,
        bindProblem,
        lanIsolationLikely,
        lanReadinessFailed,
        likelyIssues,
        preferredInterface: runtime.networkDiagnostics?.preferredInterface || null,
        discoveryRange: networkParsed?.discoveryRange || null
    };
}

function choosePort(runtimePort) {
    const candidates = parsePortCandidates(process.env.STRATEGY_PORT_CANDIDATES);
    return candidates.find((item) => item !== runtimePort) || null;
}

function decideMethod(signals) {
    const reasons = [];
    const recommendations = [];
    let method = 'direct';
    let chosenPort = signals.currentPort;

    if (signals.currentPort === 3000 && (signals.firewallLikely || signals.bindProblem)) {
        const switchedPort = choosePort(signals.currentPort);
        if (switchedPort) {
            method = 'port-switch';
            chosenPort = switchedPort;
            reasons.push('A 3000-es port valoszinuleg blokkolt vagy problemas ezen a gepen/halozaton.');
            reasons.push(`Automatikus port valtas: ${signals.currentPort} -> ${switchedPort}.`);
        }
    }

    if (signals.lanIsolationLikely) {
        method = 'tunnel';
        reasons.push('A localhost kapcsolat mukodik, de a LAN probe nem: AP isolation/VLAN policy valoszinu.');
        recommendations.push('Mobile hotspot mod javasolt: szerver + kliensek ugyanarra a telefon hotspotra csatlakozzanak.');
    }

    if (signals.localhostOk && !signals.lanProbeOk) {
        recommendations.push('Browser ellenorzes: ha 127.0.0.1 megy, de LAN IP nem, Windows firewall vagy halozati policy blokkolhat.');
    }

    return {
        method,
        chosenPort,
        reasons: Array.from(new Set(reasons)),
        recommendations: Array.from(new Set(recommendations))
    };
}

function printDecision(strategy) {
    console.log('\n=== Automata futasi strategia (diagnosztika alapon) ===');
    console.log(`[INFO] Valasztott mod: ${strategy.method}`);
    console.log(`[INFO] Aktiv port: ${strategy.chosenPort}`);

    if (strategy.reasons.length) {
        console.log('[INFO] Indoklas:');
        for (const item of strategy.reasons) {
            console.log(`  - ${item}`);
        }
    }

    if (strategy.recommendations.length) {
        console.log('[WARN] Javaslatok:');
        for (const item of strategy.recommendations) {
            console.log(`  - ${item}`);
        }
    }
}

async function decidePreRunStrategy() {
    const runtime = getRuntimeConfig();

    const [computerResult, networkResult] = await Promise.all([
        runNodeScriptJson('computer-network-diagnostics.js', 25000),
        runNodeScriptJson('network-diagnostics.js', 20000)
    ]);

    const signals = buildSignals(runtime, computerResult.parsed, networkResult.parsed);
    const decision = decideMethod(signals);

    return {
        ...decision,
        signals,
        diagnostics: {
            computer: {
                ok: computerResult.ok,
                exitCode: computerResult.exitCode,
                parsed: computerResult.parsed,
                stderr: computerResult.stderr || null
            },
            network: {
                ok: networkResult.ok,
                exitCode: networkResult.exitCode,
                parsed: networkResult.parsed,
                stderr: networkResult.stderr || null
            }
        }
    };
}

module.exports = {
    decidePreRunStrategy,
    printDecision
};
