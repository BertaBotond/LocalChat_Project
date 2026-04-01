const { getNetworkDiagnostics } = require('./network.js');

function getNumberEnv(name, defaultValue) {
    const value = Number(process.env[name]);

    if (Number.isFinite(value)) {
        return value;
    }

    return defaultValue;
}

function getBooleanEnv(name, defaultValue) {
    const raw = process.env[name];

    if (raw === undefined) {
        return defaultValue;
    }

    return raw.toLowerCase() !== 'false';
}

function getRuntimeConfig() {
    const serverHost = process.env.SERVER_HOST || '0.0.0.0';
    const serverPort = getNumberEnv('SERVER_PORT', 3000);
    const diagnostics = getNetworkDiagnostics(serverHost, serverPort);

    const autoRangeEnabled = getBooleanEnv('DISCOVERY_AUTO_RANGE', true);
    const hasManualRange =
        typeof process.env.IP_BASE === 'string' &&
        process.env.IP_BASE.length > 0 &&
        process.env.IP_START !== undefined &&
        process.env.IP_END !== undefined;

        const ipBase = autoRangeEnabled
                ? diagnostics.range.ipBase
                : hasManualRange
                    ? process.env.IP_BASE
                    : '10.2.30';
        const ipStart = autoRangeEnabled
                ? diagnostics.range.ipStart
                : hasManualRange
                    ? getNumberEnv('IP_START', 1)
                    : 1;
        const ipEnd = autoRangeEnabled
                ? diagnostics.range.ipEnd
                : hasManualRange
                    ? getNumberEnv('IP_END', 16)
                    : 16;
    const discoveryIntervalMs = getNumberEnv('DISCOVERY_INTERVAL_MS', 5000);
    const discoveryConcurrency = getNumberEnv('DISCOVERY_CONCURRENCY', 8);
    const agentPort = getNumberEnv('AGENT_PORT', 4123);
    const discoveryMode = (process.env.DISCOVERY_MODE || 'fallback').toLowerCase();
    const lanOnly = getBooleanEnv('LAN_ONLY', true);

    return {
        serverHost,
        serverPort,
        autoRangeEnabled,
        ipBase,
        ipStart,
        ipEnd,
        discoveryIntervalMs,
        discoveryConcurrency,
        agentPort,
        discoveryMode: discoveryMode === 'agent' ? 'agent' : 'fallback',
        lanOnly,
        networkDiagnostics: diagnostics
    };
}

function getIpRange(config = getRuntimeConfig()) {
    const ips = [];

    for (let octet = config.ipStart; octet <= config.ipEnd; octet += 1) {
        ips.push(`${config.ipBase}.${octet}`);
    }

    return ips;
}

module.exports = {
    getRuntimeConfig,
    getIpRange
};
