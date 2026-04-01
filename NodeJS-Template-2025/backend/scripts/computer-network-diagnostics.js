require('dotenv').config();

const os = require('os');
const net = require('net');
const dns = require('dns').promises;
const { spawnSync } = require('child_process');
const { getRuntimeConfig } = require('../config/runtime.js');

function isIPv4(address) {
    return typeof address === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
}

function toJsonSafeError(error) {
    if (!error) {
        return null;
    }

    return {
        code: error.code || 'UNKNOWN',
        message: error.message || String(error)
    };
}

function runShell(command, args, timeoutMs = 4000) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true
    });

    return {
        ok: result.status === 0,
        status: result.status,
        stdout: (result.stdout || '').trim(),
        stderr: (result.stderr || '').trim(),
        error: toJsonSafeError(result.error)
    };
}

function getPrimaryIpv4(config) {
    const preferred = config.networkDiagnostics?.preferredInterface?.address;
    if (isIPv4(preferred)) {
        return preferred;
    }

    const interfaces = os.networkInterfaces();
    for (const records of Object.values(interfaces)) {
        for (const record of records || []) {
            if (record && record.family === 'IPv4' && record.internal === false && isIPv4(record.address)) {
                return record.address;
            }
        }
    }

    return null;
}

function probeBind(host, port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        let settled = false;

        const finish = (payload) => {
            if (settled) {
                return;
            }

            settled = true;
            try {
                server.close(() => resolve(payload));
            } catch (error) {
                resolve(payload);
            }
        };

        server.once('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                resolve({
                    ok: true,
                    status: 'port-in-use',
                    detail: `${host}:${port} mar hasznalatban van (ez normalis, ha a szerver fut).`,
                    error: toJsonSafeError(error)
                });
                return;
            }

            resolve({
                ok: false,
                status: 'bind-failed',
                detail: `${host}:${port} bind sikertelen.`,
                error: toJsonSafeError(error)
            });
        });

        server.listen(port, host, () => {
            finish({
                ok: true,
                status: 'bind-ok',
                detail: `${host}:${port} bind sikeres.`
            });
        });

        setTimeout(() => {
            finish({
                ok: false,
                status: 'bind-timeout',
                detail: `${host}:${port} bind timeout.`
            });
        }, 3000).unref?.();
    });
}

function probeTcpConnect(host, port, timeoutMs = 1200) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;

        const done = (payload) => {
            if (settled) {
                return;
            }

            settled = true;
            try {
                socket.destroy();
            } catch (error) {
                // no-op
            }
            resolve(payload);
        };

        socket.setTimeout(timeoutMs);

        socket.once('connect', () => {
            done({ ok: true, status: 'connect-ok', target: `${host}:${port}` });
        });

        socket.once('timeout', () => {
            done({ ok: false, status: 'connect-timeout', target: `${host}:${port}` });
        });

        socket.once('error', (error) => {
            done({
                ok: false,
                status: 'connect-failed',
                target: `${host}:${port}`,
                error: toJsonSafeError(error)
            });
        });

        socket.connect(port, host);
    });
}

async function resolveHostname() {
    try {
        const hostname = os.hostname();
        const result = await dns.lookup(hostname, { all: true });
        return {
            ok: true,
            hostname,
            records: result
        };
    } catch (error) {
        return {
            ok: false,
            hostname: os.hostname(),
            error: toJsonSafeError(error)
        };
    }
}

function collectWindowsFirewallInfo(port) {
    if (process.platform !== 'win32') {
        return {
            supported: false,
            platform: process.platform
        };
    }

    const profileCheck = runShell('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction | ConvertTo-Json -Depth 4'
    ], 10000);

    const portRuleCheck = runShell('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow | Get-NetFirewallPortFilter | Where-Object { $_.Protocol -eq "TCP" -and ($_.LocalPort -eq "${port}" -or $_.LocalPort -eq "Any") } | Select-Object Name,LocalPort,Protocol | ConvertTo-Json -Depth 4`
    ], 15000);

    const firewallProfiles = profileCheck.stdout ? safeJsonParse(profileCheck.stdout) : null;
    const inboundAllowRules = portRuleCheck.stdout ? safeJsonParse(portRuleCheck.stdout) : null;

    return {
        supported: true,
        profiles: {
            ok: profileCheck.ok,
            data: firewallProfiles,
            stderr: profileCheck.stderr || null,
            error: profileCheck.error
        },
        inboundAllowRulesForPort: {
            ok: portRuleCheck.ok,
            data: inboundAllowRules,
            stderr: portRuleCheck.stderr || null,
            error: portRuleCheck.error
        }
    };
}

function safeJsonParse(value) {
    try {
        return JSON.parse(value);
    } catch (error) {
        return value;
    }
}

function collectSocketListeners(port) {
    if (process.platform !== 'win32') {
        return { supported: false, platform: process.platform };
    }

    const listenerCheck = runShell('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Depth 4`
    ]);

    return {
        supported: true,
        ok: listenerCheck.ok,
        data: listenerCheck.stdout ? safeJsonParse(listenerCheck.stdout) : null,
        stderr: listenerCheck.stderr || null,
        error: listenerCheck.error
    };
}

function evaluateLikelyIssues(report) {
    const issues = [];
    const warnings = [];

    if (!report.probes.bindAny.ok) {
        issues.push('A szerver port nem bindolhato 0.0.0.0 cimre.');
    }

    if (report.runtime.lanOnly && !report.runtime.preferredIPv4) {
        issues.push('LAN_ONLY=true, de nincs hasznalhato kulso IPv4 interfesz.');
    }

    if (!report.probes.localhostConnect.ok) {
        issues.push('A localhost TCP kapcsolat a szerver portra sikertelen.');
    }

    if (report.firewall?.supported && report.firewall?.profiles?.ok) {
        const profiles = Array.isArray(report.firewall.profiles.data)
            ? report.firewall.profiles.data
            : report.firewall.profiles.data
                ? [report.firewall.profiles.data]
                : [];

        const activeBlock = profiles.some((profile) => profile.Enabled && profile.DefaultInboundAction === 'Block');
        const hasAllowRule = Array.isArray(report.firewall.inboundAllowRulesForPort.data)
            ? report.firewall.inboundAllowRulesForPort.data.length > 0
            : Boolean(report.firewall.inboundAllowRulesForPort.data);

        if (activeBlock && !hasAllowRule) {
            issues.push(`A Windows Firewall blokkolhatja a bejovo TCP ${report.runtime.serverPort} portot.`);
        }
    }

    if (report.firewall?.supported && !report.firewall?.inboundAllowRulesForPort?.ok) {
        warnings.push('A firewall szabaly-lekerdezes nem sikerult vagy timeoutolt; ellenorizd kezzel a bejovo port szabalyokat.');
    }

    return { issues, warnings };
}

async function main() {
    const runtime = getRuntimeConfig();
    const preferredIPv4 = getPrimaryIpv4(runtime);

    const [bindAny, bindLocalhost, localhostConnect, lanConnect, hostnameResolution] = await Promise.all([
        probeBind('0.0.0.0', runtime.serverPort),
        probeBind('127.0.0.1', runtime.serverPort),
        probeTcpConnect('127.0.0.1', runtime.serverPort),
        preferredIPv4 ? probeTcpConnect(preferredIPv4, runtime.serverPort) : Promise.resolve(null),
        resolveHostname()
    ]);

    const firewall = collectWindowsFirewallInfo(runtime.serverPort);
    const listeners = collectSocketListeners(runtime.serverPort);

    const report = {
        timestamp: new Date().toISOString(),
        platform: {
            os: process.platform,
            release: os.release(),
            hostname: os.hostname(),
            nodeVersion: process.version
        },
        runtime: {
            serverHost: runtime.serverHost,
            serverPort: runtime.serverPort,
            lanOnly: runtime.lanOnly,
            discoveryMode: runtime.discoveryMode,
            preferredIPv4,
            connectUrls: runtime.networkDiagnostics?.connectUrls || [],
            lanAllowedIpv4Cidrs: runtime.networkDiagnostics?.lanAllowedIpv4Cidrs || []
        },
        probes: {
            bindAny,
            bindLocalhost,
            localhostConnect,
            lanConnect,
            hostnameResolution
        },
        firewall,
        listeners,
        likelyIssues: [],
        warnings: []
    };

    const evaluation = evaluateLikelyIssues(report);
    report.likelyIssues = evaluation.issues;
    report.warnings = evaluation.warnings;

    const ready =
        report.probes.bindAny.ok &&
        report.probes.bindLocalhost.ok &&
        report.probes.localhostConnect.ok;

    report.readyForLanClients = ready && report.likelyIssues.length === 0;

    console.log(JSON.stringify(report, null, 2));

    if (!report.readyForLanClients) {
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
