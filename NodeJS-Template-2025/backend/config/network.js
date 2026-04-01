const os = require('os');

function isIPv4(value) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

function getIPv4Octets(ip) {
    if (!isIPv4(ip)) {
        return null;
    }

    const parts = ip.split('.').map(Number);
    if (parts.some((item) => Number.isNaN(item) || item < 0 || item > 255)) {
        return null;
    }

    return parts;
}

function isPrivateIPv4(ip) {
    const parts = getIPv4Octets(ip);
    if (!parts) {
        return false;
    }

    const [a, b] = parts;

    if (a === 10) {
        return true;
    }

    if (a === 172 && b >= 16 && b <= 31) {
        return true;
    }

    if (a === 192 && b === 168) {
        return true;
    }

    if (a === 100 && b >= 64 && b <= 127) {
        return true;
    }

    if (a === 169 && b === 254) {
        return true;
    }

    return a === 127;
}

function isLanIp(ip) {
    if (!ip || typeof ip !== 'string') {
        return false;
    }

    if (ip === '::1') {
        return true;
    }

    if (ip.startsWith('::ffff:')) {
        return isPrivateIPv4(ip.replace('::ffff:', ''));
    }

    if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) {
        return true;
    }

    return isPrivateIPv4(ip);
}

function getInterfacesSummary() {
    const interfaces = os.networkInterfaces();
    const list = [];

    for (const [name, records] of Object.entries(interfaces)) {
        for (const record of records || []) {
            const family = typeof record.family === 'string' ? record.family : String(record.family);

            list.push({
                name,
                family,
                address: record.address,
                netmask: record.netmask,
                cidr: record.cidr,
                internal: record.internal
            });
        }
    }

    return list;
}

function getPreferredLanInterface() {
    const all = getInterfacesSummary();
    const ipv4Candidates = all.filter((item) => item.family === 'IPv4' && item.internal === false && isIPv4(item.address));

    if (!ipv4Candidates.length) {
        return null;
    }

    const scored = ipv4Candidates
        .map((item) => {
            const profile = classifyInterfaceName(item.name);
            let score = 0;

            if (isPrivateIPv4(item.address)) {
                score += 100;
            }

            if (!item.address.startsWith('169.254.')) {
                score += 25;
            }

            if (profile === 'wired') {
                score += 20;
            } else if (profile === 'wifi') {
                score += 18;
            } else if (profile === 'other') {
                score += 10;
            } else if (profile === 'vpn') {
                score -= 25;
            } else if (profile === 'virtual') {
                score -= 30;
            }

            return {
                ...item,
                score
            };
        })
        .sort((left, right) => right.score - left.score);

    return scored[0] || null;
}

function getRecommendedRange(preferredInterface) {
    if (!preferredInterface || !isIPv4(preferredInterface.address)) {
        return {
            ipBase: '10.2.30',
            ipStart: 1,
            ipEnd: 16,
            source: 'fallback-default'
        };
    }

    const [a, b, c] = preferredInterface.address.split('.').map(Number);

    return {
        ipBase: `${a}.${b}.${c}`,
        ipStart: 1,
        ipEnd: 254,
        source: 'auto-interface'
    };
}

function getConnectUrls(host, port, preferredInterface) {
    const urls = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

    if (host === '::' || host === '0.0.0.0') {
        urls.push(`http://[::1]:${port}`);
    }

    if (host === '0.0.0.0' && preferredInterface?.address) {
        urls.push(`http://${preferredInterface.address}:${port}`);
    } else {
        urls.push(`http://${host}:${port}`);
    }

    const hostname = os.hostname();
    if (hostname && host === '0.0.0.0') {
        urls.push(`http://${hostname}:${port}`);
    }

    const interfaces = getInterfacesSummary();
    for (const item of interfaces) {
        if (item.internal) {
            continue;
        }

        if (item.family === 'IPv4' && isIPv4(item.address)) {
            urls.push(`http://${item.address}:${port}`);
        }

        if (item.family === 'IPv6' && item.address && !item.address.startsWith('fe80:')) {
            urls.push(`http://[${item.address}]:${port}`);
        }
    }

    return Array.from(new Set(urls));
}

function classifyInterfaceName(name = '') {
    const lower = name.toLowerCase();

    if (lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('wlan')) {
        return 'wifi';
    }

    if (lower.includes('ethernet') || lower.includes('lan') || lower.includes('en')) {
        return 'wired';
    }

    if (lower.includes('vpn') || lower.includes('tun') || lower.includes('tap')) {
        return 'vpn';
    }

    if (lower.includes('virtual') || lower.includes('vbox') || lower.includes('hyper-v')) {
        return 'virtual';
    }

    return 'other';
}

function getUniversalNetworkPlan() {
    return [
        {
            scenario: 'Same-machine offline demo',
            solution: 'Use localhost URL and disable strict LAN-only policy if needed.',
            env: 'single-device'
        },
        {
            scenario: 'Home/Office LAN',
            solution: 'Use preferred IPv4 URL and keep LAN_ONLY=true for safety.',
            env: 'lan'
        },
        {
            scenario: 'Mixed Wi-Fi and Ethernet clients',
            solution: 'Expose server on 0.0.0.0 and connect via hostname or active adapter IP.',
            env: 'mixed-adapters'
        },
        {
            scenario: 'VLAN segmented environment',
            solution: 'Use routed central host or one server per VLAN.',
            env: 'vlan'
        },
        {
            scenario: 'Restricted enterprise firewall',
            solution: 'Use approved host/port, then update SERVER_PORT and firewall rule.',
            env: 'managed-network'
        }
    ];
}

function getNetworkDiagnostics(host, port) {
    const preferredInterface = getPreferredLanInterface();
    const interfaces = getInterfacesSummary();
    const range = getRecommendedRange(preferredInterface);

    return {
        preferredInterface,
        range,
        connectUrls: getConnectUrls(host, port, preferredInterface),
        interfaces,
        adapters: interfaces.map((item) => ({
            name: item.name,
            address: item.address,
            family: item.family,
            internal: item.internal,
            profile: classifyInterfaceName(item.name)
        })),
        universalPlan: getUniversalNetworkPlan()
    };
}

module.exports = {
    isLanIp,
    getNetworkDiagnostics
};
