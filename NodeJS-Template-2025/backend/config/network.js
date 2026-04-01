const os = require('os');

const DEFAULT_ALLOWED_IPV4_CIDRS = [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '127.0.0.0/8',
    '100.64.0.0/10',
    '169.254.0.0/16'
];

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

function parseCidr(cidr) {
    if (typeof cidr !== 'string') {
        return null;
    }

    const [networkIp, prefixRaw] = cidr.trim().split('/');
    const prefix = Number(prefixRaw);
    const octets = getIPv4Octets(networkIp);

    if (!octets || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        return null;
    }

    return {
        networkIp,
        prefix,
        networkInt: ipv4ToInt(networkIp)
    };
}

function ipv4ToInt(ip) {
    const octets = getIPv4Octets(ip);
    if (!octets) {
        return null;
    }

    const [a, b, c, d] = octets;
    return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

function isIpInCidr(ip, cidr) {
    const ipInt = ipv4ToInt(ip);
    const parsed = parseCidr(cidr);

    if (ipInt === null || !parsed) {
        return false;
    }

    if (parsed.prefix === 0) {
        return true;
    }

    const mask = (0xffffffff << (32 - parsed.prefix)) >>> 0;
    return (ipInt & mask) === (parsed.networkInt & mask);
}

function getAllowedIpv4Cidrs() {
    const raw = (process.env.LAN_ALLOWED_IPV4_CIDRS || '').trim();
    const fromEnv = raw
        ? raw
              .split(',')
              .map((item) => item.trim())
              .filter((item) => parseCidr(item))
        : [];

    return fromEnv.length ? fromEnv : DEFAULT_ALLOWED_IPV4_CIDRS;
}

function isPrivateIPv4(ip) {
    if (!getIPv4Octets(ip)) {
        return false;
    }

    const cidrs = getAllowedIpv4Cidrs();
    return cidrs.some((cidr) => isIpInCidr(ip, cidr));
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
    const ipv4Candidates = all.filter(
        (item) => item.family === 'IPv4' && item.internal === false && isIPv4(item.address)
    );

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
            } else {
                score -= 25;
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
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }

            const nameCmp = String(left.name || '').localeCompare(String(right.name || ''), 'en', {
                sensitivity: 'base'
            });

            if (nameCmp !== 0) {
                return nameCmp;
            }

            return String(left.address || '').localeCompare(String(right.address || ''));
        });

    return scored[0] || null;
}

function getIpRangeFromBase(ipBase, ipStart, ipEnd) {
    if (typeof ipBase !== 'string') {
        return [];
    }

    const baseParts = ipBase.trim().split('.').map(Number);
    if (baseParts.length !== 3 || baseParts.some((item) => Number.isNaN(item) || item < 0 || item > 255)) {
        return [];
    }

    const safeStart = Math.max(0, Math.min(255, Number(ipStart)));
    const safeEnd = Math.max(0, Math.min(255, Number(ipEnd)));

    if (!Number.isFinite(safeStart) || !Number.isFinite(safeEnd)) {
        return [];
    }

    const rangeStart = Math.min(safeStart, safeEnd);
    const rangeEnd = Math.max(safeStart, safeEnd);
    const ips = [];

    for (let octet = rangeStart; octet <= rangeEnd; octet += 1) {
        ips.push(`${ipBase}.${octet}`);
    }

    return ips;
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
        lanAllowedIpv4Cidrs: getAllowedIpv4Cidrs(),
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
    getNetworkDiagnostics,
    getIpRangeFromBase
};
