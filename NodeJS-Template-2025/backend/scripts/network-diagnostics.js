require('dotenv').config();

const { getRuntimeConfig, getIpRange } = require('../config/runtime.js');

function main() {
    const config = getRuntimeConfig();

    const payload = {
        timestamp: new Date().toISOString(),
        serverHost: config.serverHost,
        serverPort: config.serverPort,
        lanOnly: config.lanOnly,
        discoveryMode: config.discoveryMode,
        discoverySource: config.discoveryMode === 'agent' ? 'agent-health' : 'http-health-plus-chat-presence',
        discoveryHealthCheckPort: config.discoveryMode === 'agent' ? config.agentPort : config.serverPort,
        autoRangeEnabled: config.autoRangeEnabled,
        discoveryRange: {
            ipBase: config.ipBase,
            ipStart: config.ipStart,
            ipEnd: config.ipEnd,
            count: getIpRange(config).length
        },
        preferredInterface: config.networkDiagnostics.preferredInterface,
        connectUrls: config.networkDiagnostics.connectUrls,
        interfaces: config.networkDiagnostics.interfaces
    };

    console.log(JSON.stringify(payload, null, 2));
}

main();
