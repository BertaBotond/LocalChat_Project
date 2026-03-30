require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getRuntimeConfig } = require('../config/runtime.js');

const DEFAULT_TIMEOUT_MS = 15000;

function getArgValue(flag) {
    const index = process.argv.indexOf(flag);
    if (index < 0 || index + 1 >= process.argv.length) {
        return null;
    }

    return process.argv[index + 1];
}

function hasArg(flag) {
    return process.argv.includes(flag);
}

function resolveBaseUrl() {
    const fromArg = getArgValue('--base-url');
    const fromEnv = process.env.VERIFY_BASE_URL;

    if (fromArg) {
        return fromArg;
    }

    if (fromEnv) {
        return fromEnv;
    }

    const runtime = getRuntimeConfig();
    const host = runtime.serverHost === '0.0.0.0' ? 'localhost' : runtime.serverHost;
    return `http://${host}:${runtime.serverPort}`;
}

function runNodeScript(scriptFile, options = {}) {
    const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const acceptFirstJson = options.acceptFirstJson === true;

    return new Promise((resolve) => {
        const fullPath = path.join(__dirname, scriptFile);
        const child = spawn(process.execPath, [fullPath], {
            cwd: path.join(__dirname, '..'),
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let finished = false;

        const timeout = setTimeout(() => {
            if (!finished) {
                child.kill();
                finished = true;
                resolve({
                    ok: false,
                    exitCode: -1,
                    script: scriptFile,
                    error: `Timeout after ${timeoutMs}ms`,
                    stdout,
                    stderr
                });
            }
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();

            if (!acceptFirstJson || finished) {
                return;
            }

            try {
                const parsed = JSON.parse(stdout);
                clearTimeout(timeout);
                finished = true;
                child.kill();

                resolve({
                    ok: parsed?.ok !== false,
                    exitCode: 0,
                    script: scriptFile,
                    parsed,
                    stdout,
                    stderr
                });
            } catch (_error) {
                // waiting for complete JSON payload
            }
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('close', (code) => {
            if (finished) {
                return;
            }

            clearTimeout(timeout);
            finished = true;

            let parsed = null;
            try {
                parsed = JSON.parse(stdout);
            } catch (_error) {
                parsed = null;
            }

            resolve({
                ok: code === 0,
                exitCode: code,
                script: scriptFile,
                parsed,
                stdout,
                stderr
            });
        });
    });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
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
        } catch (_error) {
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
            error: error?.message || 'Network error'
        };
    } finally {
        clearTimeout(timeout);
    }
}

function buildCheck(name, ok, details = {}, optional = false) {
    return {
        name,
        ok,
        optional,
        details,
        timestamp: new Date().toISOString()
    };
}

function readFileSafe(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (_error) {
        return null;
    }
}

function hasInlineScripts(htmlContent) {
    const inlineScriptPattern = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi;
    const matches = htmlContent.match(inlineScriptPattern) || [];
    return matches.length;
}

function hasElementId(htmlContent, id) {
    const idPattern = new RegExp(`id=["']${id}["']`, 'i');
    return idPattern.test(htmlContent);
}

async function runPreflightChecks() {
    const scripts = [
        { file: 'startup-smoke.js', timeoutMs: 45000, acceptFirstJson: true },
        { file: 'doctor.js', timeoutMs: 30000 },
        { file: 'network-diagnostics.js', timeoutMs: 30000 },
        { file: 'db-diagnostics.js', timeoutMs: 30000 }
    ];
    const checks = [];

    for (const script of scripts) {
        const result = await runNodeScript(script.file, {
            timeoutMs: script.timeoutMs,
            acceptFirstJson: script.acceptFirstJson
        });
        checks.push(
            buildCheck(`preflight:${script.file}`, result.ok, {
                exitCode: result.exitCode,
                stderr: result.stderr,
                parsed: result.parsed
            })
        );
    }

    return checks;
}

async function runUiChecks() {
    const projectRoot = path.join(__dirname, '..', '..');
    const indexPath = path.join(projectRoot, 'frontend', 'html', 'index.html');
    const adminPath = path.join(projectRoot, 'frontend', 'html', 'admin.html');

    const indexHtml = readFileSafe(indexPath);
    const adminHtml = readFileSafe(adminPath);

    const requiredIndexIds = [
        'messages',
        'sendBtn',
        'messageInput',
        'roomSelect',
        'hostsList',
        'quickLanTestBtn',
        'networkBackupList'
    ];
    const requiredAdminIds = ['adminTokenInput', 'loadDiagnosticsBtn', 'runSmokeBtn', 'adminStatus'];

    const checks = [];

    checks.push(buildCheck('ui:index:exists', Boolean(indexHtml), { path: indexPath }));
    checks.push(buildCheck('ui:admin:exists', Boolean(adminHtml), { path: adminPath }));

    if (indexHtml) {
        for (const id of requiredIndexIds) {
            checks.push(buildCheck(`ui:index:id:${id}`, hasElementId(indexHtml, id)));
        }

        checks.push(
            buildCheck('security:csp:index:inline-script', hasInlineScripts(indexHtml) === 0, {
                inlineScriptCount: hasInlineScripts(indexHtml)
            })
        );
    }

    if (adminHtml) {
        for (const id of requiredAdminIds) {
            checks.push(buildCheck(`ui:admin:id:${id}`, hasElementId(adminHtml, id)));
        }

        checks.push(
            buildCheck('security:csp:admin:inline-script', hasInlineScripts(adminHtml) === 0, {
                inlineScriptCount: hasInlineScripts(adminHtml)
            })
        );
    }

    return checks;
}

async function runApiChecks(baseUrl) {
    const checks = [];
    const adminToken = (process.env.ADMIN_TOKEN || '').trim();

    const health = await fetchWithTimeout(`${baseUrl}/api/config`);
    checks.push(buildCheck('api:reachable', health.ok, { status: health.status, error: health.error || null }));

    if (!health.ok) {
        checks.push(
            buildCheck(
                'api:skipped',
                true,
                {
                    reason: 'Server endpoint not reachable. Start backend server to run live API checks.',
                    baseUrl
                },
                true
            )
        );
        return checks;
    }

    const endpoints = [
        { name: 'api:config', method: 'GET', url: '/api/config' },
        { name: 'api:network-diagnostics', method: 'GET', url: '/api/network-diagnostics' },
        { name: 'api:log-status', method: 'GET', url: '/api/log/status' },
        { name: 'api:log-recovery', method: 'GET', url: '/api/log/recovery-status' },
        { name: 'api:rooms', method: 'GET', url: '/api/rooms' },
        { name: 'api:stats', method: 'GET', url: '/api/stats' },
        { name: 'api:hosts', method: 'GET', url: '/api/hosts' },
        { name: 'api:network-backup-plan', method: 'GET', url: '/api/network-backup-plan' },
        { name: 'api:quick-lan-test', method: 'GET', url: '/api/quick-lan-test' }
    ];

    for (const endpoint of endpoints) {
        const result = await fetchWithTimeout(`${baseUrl}${endpoint.url}`, { method: endpoint.method });
        checks.push(buildCheck(endpoint.name, result.ok, { status: result.status, error: result.error || null }));
    }

    const negativeChecks = [
        {
            name: 'api:negative:invalid-room-id',
            request: { method: 'GET', url: '/api/rooms/NaN/messages' },
            expectedStatus: 400
        },
        {
            name: 'api:negative:short-search-query',
            request: { method: 'GET', url: '/api/rooms/1/messages/search?q=a' },
            expectedStatus: 400
        },
        {
            name: 'api:negative:admin-without-token',
            request: { method: 'GET', url: '/api/admin/diagnostics' },
            expectedStatus: 401,
            acceptedStatuses: [401, 503]
        }
    ];

    for (const test of negativeChecks) {
        const result = await fetchWithTimeout(`${baseUrl}${test.request.url}`, {
            method: test.request.method
        });

        const accepted = test.acceptedStatuses || [test.expectedStatus];
        checks.push(
            buildCheck(test.name, accepted.includes(result.status), {
                status: result.status,
                expected: accepted
            })
        );
    }

    if (!adminToken) {
        checks.push(
            buildCheck(
                'api:admin:skipped',
                true,
                { reason: 'ADMIN_TOKEN missing in environment.' },
                true
            )
        );
    } else {
        const adminHeaders = {
            'x-admin-token': adminToken,
            'Content-Type': 'application/json'
        };

        const diag = await fetchWithTimeout(`${baseUrl}/api/admin/diagnostics`, {
            method: 'GET',
            headers: adminHeaders
        });
        checks.push(buildCheck('api:admin:diagnostics', diag.ok, { status: diag.status, error: diag.error || null }));

        const smoke = await fetchWithTimeout(`${baseUrl}/api/admin/smoke-test`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({})
        });
        checks.push(buildCheck('api:admin:smoke-test', smoke.ok, { status: smoke.status, error: smoke.error || null }));
    }

    return checks;
}

function summarize(allChecks) {
    const failed = allChecks.filter((item) => !item.ok && !item.optional);
    const optionalFailed = allChecks.filter((item) => !item.ok && item.optional);
    const passed = allChecks.filter((item) => item.ok);

    return {
        total: allChecks.length,
        passed: passed.length,
        failed: failed.length,
        optionalFailed: optionalFailed.length,
        ok: failed.length === 0
    };
}

async function main() {
    const strictMode = !hasArg('--no-strict');
    const baseUrl = resolveBaseUrl();

    const preflightChecks = await runPreflightChecks();
    const uiChecks = await runUiChecks();
    const apiChecks = await runApiChecks(baseUrl);

    const allChecks = [...preflightChecks, ...uiChecks, ...apiChecks];
    const summary = summarize(allChecks);

    const report = {
        timestamp: new Date().toISOString(),
        mode: strictMode ? 'strict' : 'non-strict',
        baseUrl,
        summary,
        checks: allChecks
    };

    console.log(JSON.stringify(report, null, 2));

    if (strictMode && !summary.ok) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(
        JSON.stringify(
            {
                status: 'fatal',
                message: error?.message || 'A teljes ellenorzes futtatasa sikertelen.'
            },
            null,
            2
        )
    );
    process.exit(1);
});