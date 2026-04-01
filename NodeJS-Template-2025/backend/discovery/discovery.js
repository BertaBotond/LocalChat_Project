const http = require('http');

const HEALTH_PATH = '/health';
const REQUEST_TIMEOUT_MS = 700;

function checkHealth(ip, port, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const request = http.get(
            {
                host: ip,
                port,
                path: HEALTH_PATH,
                timeout: timeoutMs
            },
            (response) => {
                response.resume();
                resolve(response.statusCode >= 200 && response.statusCode < 500);
            }
        );

        request.on('timeout', () => {
            request.destroy();
            resolve(false);
        });

        request.on('error', () => {
            resolve(false);
        });
    });
}

async function runWithConcurrency(items, concurrency, workerFn) {
    const safeConcurrency = Math.max(1, Number(concurrency) || 1);
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            results[currentIndex] = await workerFn(items[currentIndex], currentIndex);
        }
    }

    const workers = Array.from({ length: Math.min(safeConcurrency, items.length) }, () => worker());
    await Promise.all(workers);

    return results;
}

function createDiscoveryService(options) {
    const {
        ips,
        discoveryMode,
        discoveryIntervalMs,
        discoveryConcurrency,
        agentPort,
        fallbackPort,
        updateStatuses,
        emitHostsUpdate,
        getConnectedIps
    } = options;

    let timerId;
    let isScanning = false;

    async function scanOnce() {
        if (isScanning) {
            return;
        }

        isScanning = true;

        try {
            const now = new Date();

            if (discoveryMode === 'fallback') {
                const connectedSet = new Set(
                    typeof getConnectedIps === 'function' ? getConnectedIps() : []
                );

                const statuses = await runWithConcurrency(ips, discoveryConcurrency, async (ip) => {
                    const reachable = await checkHealth(ip, fallbackPort || agentPort);
                    const chatConnected = connectedSet.has(ip);
                    const online = reachable || chatConnected;

                    return {
                        ip,
                        status: online ? 'online' : 'offline',
                        lastCheckedAt: now,
                        lastSeenAt: online ? now : null
                    };
                });

                await updateStatuses(statuses);
                await emitHostsUpdate();
                return;
            }

            const statuses = await runWithConcurrency(ips, discoveryConcurrency, async (ip) => {
                const online = await checkHealth(ip, agentPort);

                return {
                    ip,
                    status: online ? 'online' : 'offline',
                    lastCheckedAt: now,
                    lastSeenAt: online ? now : null
                };
            });

            await updateStatuses(statuses);
            await emitHostsUpdate();
        } finally {
            isScanning = false;
        }
    }

    function start() {
        scanOnce().catch((error) => {
            console.error('Discovery scan hiba:', error.message);
        });

        timerId = setInterval(() => {
            scanOnce().catch((error) => {
                console.error('Discovery scan hiba:', error.message);
            });
        }, discoveryIntervalMs);
    }

    function stop() {
        if (timerId) {
            clearInterval(timerId);
        }
    }

    return {
        start,
        stop,
        scanOnce
    };
}

module.exports = {
    createDiscoveryService
};
