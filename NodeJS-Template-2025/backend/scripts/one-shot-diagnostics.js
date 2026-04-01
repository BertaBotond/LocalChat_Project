require('dotenv').config();

const path = require('path');
const { spawn } = require('child_process');
const { getRuntimeConfig } = require('../config/runtime.js');

const DEFAULT_TIMEOUT_MS = 25000;

function runNodeScript(scriptFile, timeoutMs = DEFAULT_TIMEOUT_MS) {
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
                script: scriptFile,
                exitCode: -1,
                error: `timeout after ${timeoutMs}ms`,
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
                script: scriptFile,
                exitCode: code,
                error: null,
                parsed,
                stdout,
                stderr
            });
        });
    });
}

async function fetchJsonWithTimeout(url, timeoutMs = 5000, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });

        const text = await response.text();
        let json = null;

        try {
            json = JSON.parse(text);
        } catch (error) {
            json = null;
        }

        return {
            ok: response.ok,
            status: response.status,
            json,
            text
        };
    } catch (error) {
        return {
            ok: false,
            status: 0,
            error: error?.message || 'network error'
        };
    } finally {
        clearTimeout(timeout);
    }
}

function normalizeBaseUrl(runtime) {
    const host = runtime.serverHost === '0.0.0.0' ? 'localhost' : runtime.serverHost;
    return `http://${host}:${runtime.serverPort}`;
}

function parseHostsStats(hostsPayload) {
    const hosts = Array.isArray(hostsPayload) ? hostsPayload : [];

    let reachableCount = 0;
    let chatConnectedCount = 0;
    let onlineCount = 0;

    for (const host of hosts) {
        const reachable =
            host?.networkReachable === true ||
            host?.reachabilityStatus === 'reachable' ||
            host?.network_status === 'reachable';
        const chatConnected =
            host?.chatConnected === true ||
            host?.chatStatus === 'connected' ||
            host?.chat_status === 'connected';
        const online = host?.status === 'online';

        if (reachable) {
            reachableCount += 1;
        }

        if (chatConnected) {
            chatConnectedCount += 1;
        }

        if (online) {
            onlineCount += 1;
        }
    }

    return {
        totalHosts: hosts.length,
        reachableCount,
        chatConnectedCount,
        onlineCount
    };
}

function buildSchoolNetworkChecklist(context) {
    const checks = [];

    const firewallIssue = context.computer?.likelyIssues?.some((item) =>
        String(item).toLowerCase().includes('windows firewall')
    );

    checks.push({
        id: 'windows-inbound-rule',
        title: 'Windows inbound szabaly a chat portra',
        status: firewallIssue ? 'fail' : 'pass',
        why: 'Ha nincs bejovo TCP szabaly a 3000-es portra, a kliensek nem erik el a szervert.',
        action:
            'Windows Defender Firewall > Advanced settings > Inbound Rules > uj TCP 3000 allow szabaly (Private/Domain).',
        evidence: {
            likelyIssues: context.computer?.likelyIssues || [],
            warning: context.computer?.warnings || []
        }
    });

    const lanReachOk = context.computer?.probes?.lanConnect?.ok === true;
    checks.push({
        id: 'ap-isolation-check',
        title: 'AP isolation / Client isolation ellenorzes',
        status: lanReachOk ? 'warn' : 'fail',
        why: 'Iskolai AP isolation eseten ugyanazon Wi-Fi kliensek nem latjak egymast.',
        action:
            'AP oldalon kapcsold ki a Client Isolation / AP Isolation opciot az adott SSID-n, vagy hasznalj kozponti kabeles szervert.',
        evidence: {
            serverLanProbe: context.computer?.probes?.lanConnect || null,
            hostStats: context.hostStats
        }
    });

    const noRemoteHosts =
        Number(context.hostStats?.totalHosts || 0) > 0 && Number(context.hostStats?.reachableCount || 0) === 0;

    checks.push({
        id: 'vlan-segmentation-check',
        title: 'VLAN szegmentalasi ellenorzes',
        status: noRemoteHosts ? 'warn' : 'pass',
        why: 'Kulon VLAN-ok kozott L3 policy nelkul nincs kliens-kliens eleres.',
        action:
            'Ellenorizd, hogy a kliens es szerver ugyanabban a VLAN-ban van-e, vagy legyen route+ACL engedely TCP 3000-re.',
        evidence: {
            hostStats: context.hostStats,
            preferredInterface: context.network?.preferredInterface || null,
            discoveryRange: context.network?.recommendedRange || null
        }
    });

    return checks;
}

function inferRootCause(context) {
    const results = [];

    const dbOk = context.doctor?.database?.ok === true;
    const apiReachable = context.api?.config?.ok === true;
    const bindOk = context.computer?.probes?.bindAny?.ok === true;
    const localTcpOk = context.computer?.probes?.localhostConnect?.ok === true;
    const lanTcpOk = context.computer?.probes?.lanConnect?.ok === true;
    const firewallIssue = context.computer?.likelyIssues?.some((item) =>
        String(item).toLowerCase().includes('windows firewall')
    );

    if (!dbOk) {
        results.push({
            id: 'database-connectivity',
            confidence: 0.96,
            title: 'Adatbazis kapcsolat hiba',
            reason: 'A backend nem tud stabilan DB-hez csatlakozni, emiatt kliensek sem kapnak teljes funkcionalitast.',
            fixes: [
                'Ellenorizd a DB elerhetoseget (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`).',
                'Futtasd: `npm run diag:db`.',
                'Engedelyezd a MySQL portot (3306) helyi tuzfalban.'
            ]
        });
    }

    if (!bindOk || !localTcpOk) {
        results.push({
            id: 'local-server-bind-or-listen',
            confidence: 0.93,
            title: 'Helyi szerver bind/listen problema',
            reason: 'A szerver port bind vagy localhost TCP probe nem stabil.',
            fixes: [
                'Ellenorizd, mi foglalja a portot 3000-en.',
                'Valts portra (`SERVER_PORT`) vagy allitsd le az utkozo folyamatot.',
                'Inditsd ujra a backendet: `npm run up`.'
            ]
        });
    }

    if (firewallIssue) {
        results.push({
            id: 'windows-firewall-block',
            confidence: 0.9,
            title: 'Windows Firewall valoszinuleg blokkolja a bejovo kapcsolatot',
            reason: 'A diagnosztika firewall blokkot jelzett a chat portra.',
            fixes: [
                'Hozz letre inbound allow szabalyt TCP 3000-ra (Private/Domain).',
                'Ellenorizd `Get-NetFirewallRule` es `Get-NetFirewallPortFilter` kimenetet.',
                'Teszt: kliensrol `Test-NetConnection <server-ip> -Port 3000`.'
            ]
        });
    }

    if (apiReachable && bindOk && localTcpOk && lanTcpOk && !firewallIssue) {
        const totalHosts = Number(context.hostStats?.totalHosts || 0);
        const reachable = Number(context.hostStats?.reachableCount || 0);

        if (totalHosts > 0 && reachable === 0) {
            results.push({
                id: 'school-network-isolation-or-vlan',
                confidence: 0.78,
                title: 'Iskolai halozati izolacio (AP isolation/VLAN policy) valoszinu',
                reason:
                    'A szerver lokal probe-ok jo eredmenyt adnak, de a discovery egyetlen peer hostot sem lat elerhetoen.',
                fixes: [
                    'AP isolation / client isolation kikapcsolasa az SSID-n.',
                    'VLAN/routing/policy ellenorzes: kliens-szerver kozott TCP 3000 engedely.',
                    'Hasznalj kozponti kabeles szerver gepet, ami minden VLAN-bol elerheto.'
                ]
            });
        }
    }

    if (!results.length) {
        results.push({
            id: 'no-hard-local-fault-detected',
            confidence: 0.55,
            title: 'Nincs egyertelmu lokalis hiba',
            reason:
                'A lokalis probe-ok alapvetoen rendben vannak; valoszinu kulso halozati policy vagy kliens oldali limitacio.',
            fixes: [
                'Kliens geprol futtasd: `Test-NetConnection <server-ip> -Port 3000`.',
                'Kliens geprol nyisd meg: `http://<server-ip>:3000/api/network-diagnostics`.',
                'IT oldalon ellenoriztetni kell AP/VLAN policyt.'
            ]
        });
    }

    results.sort((a, b) => b.confidence - a.confidence);
    return {
        primary: results[0],
        ranked: results
    };
}

async function main() {
    const runtime = getRuntimeConfig();
    const baseUrl = normalizeBaseUrl(runtime);

    const [doctorResult, networkResult, computerResult, dbResult] = await Promise.all([
        runNodeScript('doctor.js', 30000),
        runNodeScript('network-diagnostics.js', 30000),
        runNodeScript('computer-network-diagnostics.js', 45000),
        runNodeScript('db-diagnostics.js', 30000)
    ]);

    const apiConfig = await fetchJsonWithTimeout(`${baseUrl}/api/config`, 5000);
    const apiNetworkDiag = await fetchJsonWithTimeout(`${baseUrl}/api/network-diagnostics`, 5000);
    const apiHosts = await fetchJsonWithTimeout(`${baseUrl}/api/hosts`, 7000);
    const apiQuickLan = await fetchJsonWithTimeout(`${baseUrl}/api/quick-lan-test`, 7000);

    const hostStats = parseHostsStats(apiHosts.json);

    const context = {
        doctor: doctorResult.parsed,
        network: networkResult.parsed,
        computer: computerResult.parsed,
        db: dbResult.parsed,
        api: {
            config: apiConfig,
            networkDiagnostics: apiNetworkDiag,
            hosts: apiHosts,
            quickLanTest: apiQuickLan
        },
        hostStats
    };

    const inferred = inferRootCause(context);
    const schoolNetworkChecklist = buildSchoolNetworkChecklist(context);

    const report = {
        timestamp: new Date().toISOString(),
        status: 'ok',
        baseUrl,
        summary: {
            apiReachable: apiConfig.ok,
            dbReady: doctorResult.parsed?.database?.ok === true,
            lanReadyLocalProbe: computerResult.parsed?.readyForLanClients === true,
            hostStats
        },
        likelyRootCause: inferred.primary,
        rankedRootCauses: inferred.ranked,
        schoolNetworkChecklist,
        checks: {
            doctor: {
                ok: doctorResult.ok,
                exitCode: doctorResult.exitCode,
                parsed: doctorResult.parsed,
                stderr: doctorResult.stderr || null,
                error: doctorResult.error || null
            },
            network: {
                ok: networkResult.ok,
                exitCode: networkResult.exitCode,
                parsed: networkResult.parsed,
                stderr: networkResult.stderr || null,
                error: networkResult.error || null
            },
            computer: {
                ok: computerResult.ok,
                exitCode: computerResult.exitCode,
                parsed: computerResult.parsed,
                stderr: computerResult.stderr || null,
                error: computerResult.error || null
            },
            db: {
                ok: dbResult.ok,
                exitCode: dbResult.exitCode,
                parsed: dbResult.parsed,
                stderr: dbResult.stderr || null,
                error: dbResult.error || null
            },
            api: {
                config: apiConfig,
                networkDiagnostics: apiNetworkDiag,
                hosts: {
                    ok: apiHosts.ok,
                    status: apiHosts.status,
                    error: apiHosts.error || null,
                    stats: hostStats
                },
                quickLanTest: {
                    ok: apiQuickLan.ok,
                    status: apiQuickLan.status,
                    error: apiQuickLan.error || null,
                    summary:
                        Array.isArray(apiQuickLan.json?.results) && apiQuickLan.json.results.length
                            ? {
                                  total: apiQuickLan.json.results.length,
                                  failures: apiQuickLan.json.results.filter((item) => item.ok === false).length
                              }
                            : null
                }
            }
        }
    };

    if (!report.summary.apiReachable || !report.summary.dbReady) {
        report.status = 'degraded';
    }

    if (report.likelyRootCause?.id !== 'no-hard-local-fault-detected') {
        report.status = report.status === 'ok' ? 'warning' : report.status;
    }

    console.log(JSON.stringify(report, null, 2));

    if (report.status === 'degraded') {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(
        JSON.stringify(
            {
                status: 'fatal',
                message: error?.message || 'Ismeretlen hiba a one-shot diagnosztikaban.'
            },
            null,
            2
        )
    );
    process.exit(1);
});
