let socket;
let currentRoomId = 1;
let runtimeConfig;
let toastTimer;
let typingStopTimer;
let isTyping = false;
let healthTimer;
let currentComposeMode = 'text';
let isSocketConnected = false;
let hostFilterState = 'all';
let hostsCache = [];
const typingUsers = new Set();
let connectedUsersCache = [];
let currentRoomAccess = null;
let helpTooltipInstances = [];
const clientSpamState = {
    lastSentAt: 0,
    lastContent: '',
    repeatedCount: 0,
    blockedUntil: 0
};

const MAX_IMAGE_SIZE_BYTES = 3 * 1024 * 1024;
const COMPOSE_MODES = ['text', 'code', 'emoji', 'image'];
const CLIENT_MIN_SEND_INTERVAL_MS = 500;
const CLIENT_DUPLICATE_COOLDOWN_MS = 15000;
const CLIENT_SPAM_BLOCK_MS = 20000;

const elements = {
    serverStatus: document.getElementById('serverStatus'),
    discoveryStatus: document.getElementById('discoveryStatus'),
    logStatusInfo: document.getElementById('logStatusInfo'),
    recoveryStatusInfo: document.getElementById('recoveryStatusInfo'),
    rangeInfo: document.getElementById('rangeInfo'),
    networkInfo: document.getElementById('networkInfo'),
    clientConnectUrl: document.getElementById('clientConnectUrl'),
    copyConnectUrlBtn: document.getElementById('copyConnectUrlBtn'),
    appToast: document.getElementById('appToast'),
    statTotalMessages: document.getElementById('statTotalMessages'),
    statMessagesToday: document.getElementById('statMessagesToday'),
    statTotalRooms: document.getElementById('statTotalRooms'),
    statConnectedUsers: document.getElementById('statConnectedUsers'),
    allCount: document.getElementById('allCount'),
    onlineCount: document.getElementById('onlineCount'),
    offlineCount: document.getElementById('offlineCount'),
    unknownCount: document.getElementById('unknownCount'),
    hostFilterControls: document.getElementById('hostFilterControls'),
    hostFilterHint: document.getElementById('hostFilterHint'),
    hostsList: document.getElementById('hostsList'),
    usersList: document.getElementById('usersList'),
    usernameInput: document.getElementById('usernameInput'),
    roomSelect: document.getElementById('roomSelect'),
    favoriteRoomBtn: document.getElementById('favoriteRoomBtn'),
    newRoomInput: document.getElementById('newRoomInput'),
    createRoomBtn: document.getElementById('createRoomBtn'),
    searchInput: document.getElementById('searchInput'),
    searchBtn: document.getElementById('searchBtn'),
    clearSearchBtn: document.getElementById('clearSearchBtn'),
    typingIndicator: document.getElementById('typingIndicator'),
    smartHint: document.getElementById('smartHint'),
    messages: document.getElementById('messages'),
    messageInput: document.getElementById('messageInput'),
    messageCounter: document.getElementById('messageCounter'),
    sendGuardInfo: document.getElementById('sendGuardInfo'),
    sendBtn: document.getElementById('sendBtn'),
    rescanBtn: document.getElementById('rescanBtn'),
    imageInput: document.getElementById('imageInput'),
    imageComposer: document.getElementById('imageComposer'),
    emojiPicker: document.getElementById('emojiPicker'),
    privateRoomToggle: document.getElementById('privateRoomToggle'),
    privateMembersSelect: document.getElementById('privateMembersSelect'),
    privateMembersWrap: document.getElementById('privateMembersWrap'),
    privateFlowStateBadge: document.getElementById('privateFlowStateBadge'),
    privateFlowStateText: document.getElementById('privateFlowStateText'),
    privateJoinWrap: document.getElementById('privateJoinWrap'),
    privateInviteCodeInput: document.getElementById('privateInviteCodeInput'),
    joinPrivateRoomBtn: document.getElementById('joinPrivateRoomBtn'),
    roomOwnerToolsWrap: document.getElementById('roomOwnerToolsWrap'),
    ownerInviteCode: document.getElementById('ownerInviteCode'),
    copyOwnerInviteBtn: document.getElementById('copyOwnerInviteBtn'),
    rotateInviteBtn: document.getElementById('rotateInviteBtn'),
    ownerMembersSelect: document.getElementById('ownerMembersSelect'),
    removeMemberBtn: document.getElementById('removeMemberBtn'),
    networkBackupList: document.getElementById('networkBackupList'),
    quickLanTestBtn: document.getElementById('quickLanTestBtn'),
    quickLanTestList: document.getElementById('quickLanTestList')
};

const modeButtons = Array.from(document.querySelectorAll('.composer-mode'));
const emojiButtons = Array.from(document.querySelectorAll('.emoji-btn'));

// Theme Management
function initTheme() {
    const savedTheme = localStorage.getItem('preferredTheme') || 'dark';
    applyTheme(savedTheme);
}

function applyTheme(theme) {
    const validTheme = ['light', 'dark'].includes(theme) ? theme : 'dark';
    document.documentElement.setAttribute('data-theme', validTheme);
    localStorage.setItem('preferredTheme', validTheme);
    updateThemeButtonIcon(validTheme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
}

function updateThemeButtonIcon(theme) {
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
        themeBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
        themeBtn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    }
}

function showToast(message) {
    if (!elements.appToast) {
        return;
    }

    elements.appToast.textContent = message;
    elements.appToast.classList.add('show');

    if (toastTimer) {
        clearTimeout(toastTimer);
    }

    toastTimer = setTimeout(() => {
        elements.appToast.classList.remove('show');
    }, 1900);
}

function setBadgeState(element, text, state) {
    element.textContent = text;
    element.classList.remove('ok', 'warn', 'bad');

    if (state) {
        element.classList.add(state);
    }
}

function getCurrentUsername() {
    return elements.usernameInput.value.trim();
}

function getCurrentDraftKey() {
    return `localchat_draft_room_${currentRoomId}`;
}

function saveDraft() {
    localStorage.setItem(getCurrentDraftKey(), elements.messageInput.value || '');
}

function loadDraft() {
    const draft = localStorage.getItem(getCurrentDraftKey()) || '';
    elements.messageInput.value = draft;
    updateMessageCounter();
}

function clearDraft() {
    localStorage.removeItem(getCurrentDraftKey());
}

function updateSmartHint(message) {
    const fallback = 'Tipp: valassz szobat es add meg a neved kuldes elott.';
    const hintEl = elements.smartHint;
    if (!hintEl) {
        return;
    }

    hintEl.textContent = message || fallback;
}

function updateActionGuards() {
    const usernameOk = getCurrentUsername().length >= 2;
    const roomSelected = Number(currentRoomId) >= 1;
    const privateLocked = currentRoomAccess?.isPrivate && !currentRoomAccess?.hasAccess;
    const canSend = usernameOk && roomSelected && !privateLocked && isSocketConnected;

    elements.sendBtn.disabled = !canSend;
    elements.createRoomBtn.disabled = !usernameOk;
    elements.joinPrivateRoomBtn.disabled = !usernameOk;
    elements.favoriteRoomBtn.disabled = !roomSelected;

    if (!usernameOk) {
        elements.sendGuardInfo.textContent = 'Adj meg legalabb 2 karakteres felhasznalonevet.';
        updateSmartHint('Adj meg legalabb 2 karakteres felhasznalonevet.');
        return;
    }

    if (!isSocketConnected) {
        elements.sendGuardInfo.textContent = 'Nincs aktiv socket kapcsolat, varj a csatlakozasra.';
        updateSmartHint('A kapcsolat meg nem aktiv. Varj par masodpercet.');
        return;
    }

    if (privateLocked) {
        elements.sendGuardInfo.textContent = 'Privat szoba: csatlakozz meghivokoddal, utana kuldhetsz.';
        updateSmartHint('Ez privat szoba: csatlakozz meghivokoddal.');
        return;
    }

    elements.sendGuardInfo.textContent = 'Kuldes engedelyezve.';
    updateSmartHint('Minden rendben. Enterrel is kuldhetsz uzenetet.');
}

function getUsernameQueryParam() {
    const username = getCurrentUsername();
    if (!username) {
        return '';
    }

    return `username=${encodeURIComponent(username)}`;
}

function updatePrivateMembersVisibility() {
    const isPrivate = elements.privateRoomToggle.checked;
    const isExistingPrivateRoom = Boolean(currentRoomAccess?.isPrivate);
    elements.privateMembersWrap.hidden = !isPrivate || isExistingPrivateRoom;
    updatePrivateRoomFlowState();
}

function setPrivateFlowState(stateClass, badgeText, helpText) {
    if (!elements.privateFlowStateBadge || !elements.privateFlowStateText) {
        return;
    }

    elements.privateFlowStateBadge.className = 'private-flow-badge';
    if (stateClass) {
        elements.privateFlowStateBadge.classList.add(stateClass);
    }

    elements.privateFlowStateBadge.textContent = badgeText;
    elements.privateFlowStateText.textContent = helpText;
}

function updatePrivateRoomFlowState() {
    const isPrivateToggleOn = elements.privateRoomToggle.checked;

    if (currentRoomAccess?.isPrivate && currentRoomAccess?.isOwner) {
        setPrivateFlowState(
            'state-owner',
            'Owner mod',
            'Ez a te privat szobad. A kodot megoszthatod, uj kodot generalhatsz, es tagokat torolhetsz az owner eszkozokkel.'
        );
        return;
    }

    if (currentRoomAccess?.isPrivate && !currentRoomAccess?.hasAccess) {
        setPrivateFlowState(
            'state-join',
            'Kod szukseges',
            'Ehhez a privat szobahoz meghivokod kell. Add meg a kodot, majd kattints a Csatlakozas koddal gombra.'
        );
        return;
    }

    if (currentRoomAccess?.isPrivate && currentRoomAccess?.hasAccess) {
        setPrivateFlowState(
            'state-member',
            'Privat tag',
            'Sikeresen bent vagy a privat szobaban. Uzenetet mar kuldhetsz, a kuldes automatikusan ehhez a szobahoz megy.'
        );
        return;
    }

    if (isPrivateToggleOn) {
        setPrivateFlowState(
            'state-owner',
            'Letrehozas mod',
            'Valassz meghivott usereket, majd hozz letre uj szobat. A rendszer automatikusan meghivokodot general.'
        );
        return;
    }

    setPrivateFlowState(
        '',
        'Public mod',
        'Kapcsold be a privat opciot uj privat szoba letrehozasahoz, vagy hasznalj meghivokodot privat csatlakozashoz.'
    );
}

function initHelpTooltips() {
    if (!window.bootstrap?.Tooltip) {
        return;
    }

    for (const tooltip of helpTooltipInstances) {
        tooltip.dispose();
    }
    helpTooltipInstances = [];

    const tips = Array.from(document.querySelectorAll('.help-tip[data-help]'));
    for (const tip of tips) {
        const message = tip.getAttribute('data-help') || '';
        tip.setAttribute('data-bs-toggle', 'tooltip');
        tip.setAttribute('data-bs-placement', 'bottom');
        tip.setAttribute('data-bs-custom-class', 'help-bootstrap-tooltip');
        tip.setAttribute('data-bs-title', message);
        tip.setAttribute('title', message);

        const instance = new window.bootstrap.Tooltip(tip, {
            container: 'body',
            boundary: 'viewport',
            trigger: 'hover focus'
        });

        helpTooltipInstances.push(instance);
    }
}

function renderNetworkBackupPlan(planItems = []) {
    if (!Array.isArray(planItems) || !planItems.length) {
        elements.networkBackupList.innerHTML = '<li>Nincs backup terv adat.</li>';
        return;
    }

    elements.networkBackupList.innerHTML = planItems
        .map(
            (item) =>
                `<li><strong>${escapeHtml(item.scenario || 'n/a')}</strong><br>${escapeHtml(item.backup || '')}<br><small>${escapeHtml(item.details || '')}</small></li>`
        )
        .join('');
}

function renderQuickLanTest(payload) {
    const steps = Array.isArray(payload?.steps) ? payload.steps : [];
    if (!steps.length) {
        elements.quickLanTestList.innerHTML = '<li>Nincs teszt adat.</li>';
        return;
    }

    elements.quickLanTestList.innerHTML = steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('');
}

async function loadNetworkBackupPlan() {
    const payload = await fetchJson('/api/network-backup-plan');
    renderNetworkBackupPlan(payload.plan || []);
}

async function runQuickLanTest() {
    const payload = await fetchJson('/api/quick-lan-test');
    renderQuickLanTest(payload);

    if (Number(payload.discoveryOnlineHosts || 0) <= 1) {
        setBadgeState(elements.discoveryStatus, 'LAN fallback javasolt', 'warn');
    }
}

async function refreshCurrentRoomAccess() {
    const usernameQuery = getUsernameQueryParam();
    const access = await fetchJson(
        `/api/rooms/${currentRoomId}/access${usernameQuery ? `?${usernameQuery}` : ''}`
    );

    currentRoomAccess = access;

    const privateLocked = access.isPrivate && !access.hasAccess;
    elements.privateJoinWrap.hidden = !privateLocked;
    elements.roomOwnerToolsWrap.hidden = !(access.isPrivate && access.isOwner);

    if (access.isPrivate && access.isOwner) {
        elements.ownerInviteCode.value = access.inviteCode || 'n/a';
        await loadOwnerMembers();
    }

    updateActionGuards();
    updatePrivateMembersVisibility();
}

async function loadOwnerMembers() {
    if (!currentRoomAccess?.isOwner) {
        elements.ownerMembersSelect.innerHTML = '';
        return;
    }

    const usernameQuery = getUsernameQueryParam();
    const payload = await fetchJson(
        `/api/rooms/${currentRoomId}/members${usernameQuery ? `?${usernameQuery}` : ''}`
    );

    elements.ownerMembersSelect.innerHTML = (payload.members || [])
        .map((member) => {
            const isOwner =
                (payload.ownerUsername || '').toString().toLowerCase() ===
                (member.username || '').toString().toLowerCase();
            return `<option value="${escapeHtml(member.username)}" ${isOwner ? 'disabled' : ''}>${escapeHtml(
                member.username
            )}${isOwner ? ' (owner)' : ''}</option>`;
        })
        .join('');
}

async function joinPrivateRoomByCode() {
    const inviteCode = elements.privateInviteCodeInput.value.trim().toUpperCase();
    if (inviteCode.length < 4) {
        showToast('Adj meg ervenyes meghivokodot.');
        return;
    }

    await fetchJson(`/api/rooms/${currentRoomId}/join-private`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: getCurrentUsername(),
            inviteCode
        })
    });

    showToast('Sikeres csatlakozas a privat szobahoz.');
    elements.privateInviteCodeInput.value = '';
    await loadRooms(currentRoomId);
    await refreshCurrentRoomAccess();
    await loadMessages();
    joinCurrentRoom();
}

async function removeSelectedRoomMembers() {
    const selected = Array.from(elements.ownerMembersSelect.selectedOptions || []).map((option) => option.value);
    if (!selected.length) {
        showToast('Valassz legalabb 1 tagot a torleshez.');
        return;
    }

    for (const member of selected) {
        await fetchJson(
            `/api/rooms/${currentRoomId}/members/${encodeURIComponent(member)}?${getUsernameQueryParam()}`,
            {
                method: 'DELETE'
            }
        );
    }

    showToast('Kijelolt tagok torolve.');
    await loadOwnerMembers();
}

async function rotateInviteCode() {
    const payload = await fetchJson(`/api/rooms/${currentRoomId}/rotate-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: getCurrentUsername()
        })
    });

    elements.ownerInviteCode.value = payload.inviteCode || '';
    showToast('Uj meghivokod generalva.');
}

function renderPrivateMemberOptions(users = connectedUsersCache) {
    const current = getCurrentUsername().toLowerCase();
    const unique = new Map();

    for (const user of users) {
        const username = (user?.username || '').toString().trim();
        const normalized = username.toLowerCase();

        if (!username || normalized === current || unique.has(normalized)) {
            continue;
        }

        unique.set(normalized, username);
    }

    const options = Array.from(unique.values())
        .sort((a, b) => a.localeCompare(b, 'hu'))
        .map((username) => `<option value="${escapeHtml(username)}">${escapeHtml(username)}</option>`)
        .join('');

    elements.privateMembersSelect.innerHTML = options;
}

function getFavoriteRoomId() {
    return Number(localStorage.getItem('localchat_favorite_room') || '0');
}

function setFavoriteRoomButtonState() {
    const isFavorite = Number(currentRoomId) === getFavoriteRoomId();
    elements.favoriteRoomBtn.textContent = isFavorite ? '★ Kedvenc' : '☆ Kedvenc';
}

function renderTypingIndicator() {
    if (!typingUsers.size) {
        elements.typingIndicator.innerHTML = '&nbsp;';
        return;
    }

    const names = Array.from(typingUsers).slice(0, 3);
    const suffix = typingUsers.size > 3 ? ' es tovabbiak' : '';
    elements.typingIndicator.textContent = `${names.join(', ')} gepel${typingUsers.size > 1 ? 'nek' : ''}${suffix}...`;
}

function emitTypingStop() {
    if (!isTyping || !socket) {
        return;
    }

    isTyping = false;
    socket.emit('typingStop', {
        roomId: currentRoomId,
        username: getCurrentUsername()
    });
}

function emitTypingStart() {
    if (isTyping || !socket) {
        return;
    }

    isTyping = true;
    socket.emit('typingStart', {
        roomId: currentRoomId,
        username: getCurrentUsername()
    });
}

function scheduleTypingStop() {
    if (typingStopTimer) {
        clearTimeout(typingStopTimer);
    }

    typingStopTimer = setTimeout(() => {
        emitTypingStop();
    }, 900);
}

function updateClientConnectInfo(connectUrls = []) {
    const preferred = connectUrls.find((url) => !url.includes('localhost')) || connectUrls[0] || '';
    elements.clientConnectUrl.textContent = preferred || window.location.origin;
}

function updateMessageCounter() {
    const value = elements.messageInput.value || '';
    elements.messageCounter.textContent = `${value.length}/2000`;
}

async function loadSecureLogStatus() {
    const payload = await fetchJson('/api/log/status');
    const secureLog = payload?.secureLog || {};

    if (secureLog.exists) {
        elements.logStatusInfo.textContent = `Titkositott log: aktiv (queue: ${Number(secureLog.queuedEntries || 0)})`;
        return;
    }

    elements.logStatusInfo.textContent = 'Titkositott log: file meg nem jott letre';
}

async function loadRecoveryStatus() {
    const payload = await fetchJson('/api/log/recovery-status');
    const recovery = payload?.recovery || {};

    if (!recovery.attempted) {
        elements.recoveryStatusInfo.textContent = 'Recovery: nem futott (letezo DB vagy meg nem indult)';
        return;
    }

    if (recovery.ok) {
        elements.recoveryStatusInfo.textContent = `Recovery: sikeres (szobak: ${recovery.recoveredRooms || 0}, uzenetek: ${recovery.recoveredMessages || 0})`;
        return;
    }

    elements.recoveryStatusInfo.textContent = `Recovery: sikertelen (${recovery.reason || 'ismeretlen'})`;
}

function setComposeMode(mode) {
    if (!COMPOSE_MODES.includes(mode)) {
        return;
    }

    currentComposeMode = mode;

    for (const button of modeButtons) {
        button.classList.toggle('active', button.dataset.mode === mode);
    }

    elements.emojiPicker.hidden = mode !== 'emoji';
    elements.imageComposer.hidden = mode !== 'image';

    if (mode === 'code') {
        elements.messageInput.placeholder = 'Illessz be kodreszletet...';
    } else if (mode === 'emoji') {
        elements.messageInput.placeholder = 'Emoji vagy rovid reakcio...';
    } else if (mode === 'image') {
        elements.messageInput.placeholder = 'Kep leiras (opcionalis)...';
    } else {
        elements.messageInput.placeholder = 'Ird be az uzeneted...';
    }
}

function escapeHtml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function buildMessageBody(message) {
    const type = (message.message_type || 'text').toLowerCase();
    const safeContent = escapeHtml(message.content || '');

    if (type === 'code') {
        return `<pre><code>${safeContent}</code></pre>`;
    }

    if (type === 'emoji') {
        return `<div class="emoji-content">${safeContent}</div>`;
    }

    if (type === 'image') {
        const safePath = escapeHtml(message.file_path || '');
        const safeName = escapeHtml(message.original_name || 'kep');
        const caption = safeContent ? `<div class="mt-2">${safeContent}</div>` : '';
        return `<div class="image-wrap"><img src="${safePath}" alt="${safeName}" loading="lazy" /></div>${caption}`;
    }

    return `<div>${safeContent}</div>`;
}

function buildMessageActions(message) {
    const type = (message.message_type || 'text').toLowerCase();

    if (type === 'image') {
        return `<div class="message-actions"><button class="copy-btn" data-copy-url="${escapeHtml(message.file_path || '')}">URL masolasa</button></div>`;
    }

    return `<div class="message-actions"><button class="copy-btn" data-copy-text="${escapeHtml(message.content || '')}">Masolas</button></div>`;
}

function stateBadge(status) {
    const safeStatus = ['online', 'offline', 'unknown'].includes(status) ? status : 'unknown';
    return `<button class="badge-state state-${safeStatus}" type="button" data-host-status="${safeStatus}">${safeStatus}</button>`;
}

function normalizeHostStatus(value) {
    if (['online', 'offline', 'unknown'].includes(value)) {
        return value;
    }

    return 'unknown';
}

function setHostFilter(filter) {
    const normalized = ['all', 'online', 'offline', 'unknown'].includes(filter) ? filter : 'all';
    hostFilterState = normalized;

    const filterButtons = Array.from(elements.hostFilterControls?.querySelectorAll('.host-filter-chip') || []);
    for (const button of filterButtons) {
        button.classList.toggle('active', button.dataset.filter === hostFilterState);
    }

    renderHosts(hostsCache);
}

function renderHosts(hosts = hostsCache) {
    hostsCache = Array.isArray(hosts) ? hosts : [];

    if (!hostsCache.length) {
        elements.hostsList.innerHTML = '<li>Nincs host adat.</li>';
        elements.allCount.textContent = '0';
        elements.onlineCount.textContent = '0';
        elements.offlineCount.textContent = '0';
        elements.unknownCount.textContent = '0';
        elements.hostFilterHint.textContent = 'Mutatott hostok: 0 / 0';
        return;
    }

    const stats = {
        online: 0,
        offline: 0,
        unknown: 0
    };

    for (const host of hostsCache) {
        const status = normalizeHostStatus(host?.status);
        if (stats[status] !== undefined) {
            stats[status] += 1;
        }
    }

    elements.allCount.textContent = String(hostsCache.length);
    elements.onlineCount.textContent = String(stats.online);
    elements.offlineCount.textContent = String(stats.offline);
    elements.unknownCount.textContent = String(stats.unknown);

    const filteredHosts =
        hostFilterState === 'all'
            ? hostsCache
            : hostsCache.filter((host) => normalizeHostStatus(host?.status) === hostFilterState);

    elements.hostFilterHint.textContent = `Mutatott hostok: ${filteredHosts.length} / ${hostsCache.length}`;

    if (!filteredHosts.length) {
        elements.hostsList.innerHTML = '<li>Nincs host ebben a szuroben.</li>';
        return;
    }

    elements.hostsList.innerHTML = filteredHosts
        .map(
            (host) =>
                `<li><span>${escapeHtml(host.ip)} ${
                    host.chatConnected ? '<small>(chat)</small>' : ''
                }</span>${stateBadge(host.status)}</li>`
        )
        .join('');
}

function renderUsers(users) {
    connectedUsersCache = Array.isArray(users) ? users : [];
    renderPrivateMemberOptions(connectedUsersCache);

    if (!users.length) {
        elements.usersList.innerHTML = '<li>Nincs aktiv chat kapcsolat.</li>';
        return;
    }

    elements.usersList.innerHTML = users
        .map(
            (user) =>
                `<li><span>${escapeHtml(user.username)}</span><small>${escapeHtml(
                    user.clientIp || 'ismeretlen ip'
                )}</small></li>`
        )
        .join('');

    elements.statConnectedUsers.textContent = String(users.length);
}

function renderMessages(messages) {
    if (!messages.length) {
        elements.messages.innerHTML = '<p class="mb-0">Meg nincs uzenet ebben a szobaban.</p>';
        return;
    }

    const ownUsername = getCurrentUsername().toLowerCase();

    elements.messages.innerHTML = messages
        .map((message) => {
            const timestamp = new Date(message.created_at).toLocaleTimeString('hu-HU', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });

            const isOwnMessage = message.username.toLowerCase() === ownUsername;
            const ownClass = isOwnMessage ? ' me' : '';

            return `<article class="chat-message${ownClass}" data-message-id="${message.id}"><div><strong>${escapeHtml(
                message.username
            )}</strong><time>${timestamp}</time></div>${buildMessageBody(message)}${buildMessageActions(message)}</article>`;
        })
        .join('');

    elements.messages.scrollTop = elements.messages.scrollHeight;
}

async function fetchJson(url, options) {
    const response = await fetch(url, options);

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || `HTTP ${response.status}`);
    }

    return response.json();
}

async function loadConfig() {
    runtimeConfig = await fetchJson('/api/config');
    elements.rangeInfo.textContent = `${runtimeConfig.ipBase}.${runtimeConfig.ipStart} - ${runtimeConfig.ipBase}.${runtimeConfig.ipEnd} (${runtimeConfig.discoveryMode})`;
    setBadgeState(elements.discoveryStatus, 'Discovery fut', 'ok');

    const connectInfo = Array.isArray(runtimeConfig.connectUrls)
        ? runtimeConfig.connectUrls.join(' | ')
        : 'n/a';

    elements.networkInfo.textContent = `LAN-only: ${runtimeConfig.lanOnly ? 'igen' : 'nem'} | Csatlakozas: ${connectInfo}`;
    updateClientConnectInfo(runtimeConfig.connectUrls || []);
}

async function loadDiagnostics() {
    const diagnostics = await fetchJson('/api/network-diagnostics');

    if (!diagnostics.preferredInterface) {
        return;
    }

    const iface = diagnostics.preferredInterface;
    elements.networkInfo.textContent = `Interface: ${iface.name} (${iface.address}) | Csatlakozas: ${diagnostics.connectUrls.join(' | ')}`;
}

async function loadRooms(preferredRoomId = null) {
    const usernameQuery = getUsernameQueryParam();
    const rooms = await fetchJson(`/api/rooms${usernameQuery ? `?${usernameQuery}` : ''}`);
    elements.roomSelect.innerHTML = rooms
        .map((room) => {
            const lock = Number(room.is_private) === 1 ? ' [privat]' : '';
            return `<option value="${room.id}">${escapeHtml(room.name)}${lock}</option>`;
        })
        .join('');

    if (rooms.length > 0) {
        const favoriteRoomId = getFavoriteRoomId();
        const favoriteMatch = rooms.find((room) => Number(room.id) === favoriteRoomId);
        const matched = preferredRoomId
            ? rooms.find((room) => Number(room.id) === Number(preferredRoomId))
            : favoriteMatch || null;
        currentRoomId = Number(matched ? matched.id : rooms[0].id);
        elements.roomSelect.value = String(currentRoomId);
        setFavoriteRoomButtonState();
    }
}

async function loadMessages() {
    if (currentRoomAccess?.isPrivate && !currentRoomAccess?.hasAccess) {
        elements.messages.innerHTML = '<p class="mb-0">Privat szoba. Add meg a meghivokodot a belepeshez.</p>';
        return;
    }

    const usernameQuery = getUsernameQueryParam();
    const query = usernameQuery ? `limit=80&${usernameQuery}` : 'limit=80';
    const messages = await fetchJson(`/api/rooms/${currentRoomId}/messages?${query}`);
    renderMessages(messages);
    loadDraft();
}

async function loadHosts() {
    const hosts = await fetchJson('/api/hosts');
    renderHosts(hosts);
}

async function loadStats() {
    const stats = await fetchJson('/api/stats');
    elements.statTotalMessages.textContent = String(stats.totalMessages || 0);
    elements.statMessagesToday.textContent = String(stats.messagesToday || 0);
    elements.statTotalRooms.textContent = String(stats.totalRooms || 0);
    elements.statConnectedUsers.textContent = String(stats.connectedUsers || 0);
}

async function uploadImageMessage() {
    const image = elements.imageInput.files?.[0];

    if (!image) {
        showToast('Valassz kepet a feltolteshez');
        return;
    }

    if (image.size > MAX_IMAGE_SIZE_BYTES) {
        showToast('A kep túl nagy (max 3 MB)');
        return;
    }

    const formData = new FormData();
    formData.append('image', image);
    formData.append('username', getCurrentUsername());
    formData.append('caption', elements.messageInput.value.trim());

    const response = await fetch(`/api/rooms/${currentRoomId}/images`, {
        method: 'POST',
        body: formData
    });

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || `HTTP ${response.status}`);
    }

    elements.imageInput.value = '';
    elements.messageInput.value = '';
    showToast('Kep elkuldve');
}

async function searchMessages() {
    const query = elements.searchInput.value.trim();

    if (query.length < 2) {
        showToast('A kereses legalabb 2 karakter legyen');
        return;
    }

    const usernameQuery = getUsernameQueryParam();
    const userSuffix = usernameQuery ? `&${usernameQuery}` : '';
    const messages = await fetchJson(
        `/api/rooms/${currentRoomId}/messages/search?q=${encodeURIComponent(query)}&limit=120${userSuffix}`
    );
    renderMessages(messages);
    showToast(`Keresesi talalatok: ${messages.length}`);
}

function passClientSpamCheck(rawContent) {
    const now = Date.now();

    if (clientSpamState.blockedUntil > now) {
        const seconds = Math.ceil((clientSpamState.blockedUntil - now) / 1000);
        showToast(`Tul gyors kuldes. Probald ujra ${seconds} mp mulva.`);
        return false;
    }

    const content = (rawContent || '').trim().toLowerCase();

    if (now - clientSpamState.lastSentAt < CLIENT_MIN_SEND_INTERVAL_MS) {
        clientSpamState.repeatedCount += 1;
    }

    if (
        content &&
        content === clientSpamState.lastContent &&
        now - clientSpamState.lastSentAt < CLIENT_DUPLICATE_COOLDOWN_MS
    ) {
        clientSpamState.repeatedCount += 1;
    }

    if (clientSpamState.repeatedCount >= 3) {
        clientSpamState.blockedUntil = now + CLIENT_SPAM_BLOCK_MS;
        clientSpamState.repeatedCount = 0;
        showToast('Spam vedelem: ideiglenesen blokkolva lett a kuldes.');
        return false;
    }

    clientSpamState.lastSentAt = now;
    clientSpamState.lastContent = content;
    return true;
}

function startHealthMonitoring() {
    if (healthTimer) {
        clearInterval(healthTimer);
    }

    healthTimer = setInterval(async () => {
        try {
            const started = performance.now();
            await fetch('/health', { cache: 'no-store' });
            const latency = Math.round(performance.now() - started);

            if (latency <= 140) {
                setBadgeState(elements.serverStatus, `Szerver: stabil (${latency}ms)`, 'ok');
            } else {
                setBadgeState(elements.serverStatus, `Szerver: lassabb (${latency}ms)`, 'warn');
            }
        } catch (error) {
            setBadgeState(elements.serverStatus, 'Szerver: nem elerheto', 'bad');
        }
    }, 15000);
}

function joinCurrentRoom() {
    const username = elements.usernameInput.value.trim();

    if (username.length < 2) {
        showToast('Adj meg legalabb 2 karakteres felhasznalonevet.');
        updateActionGuards();
        return false;
    }

    if (currentRoomAccess?.isPrivate && !currentRoomAccess?.hasAccess) {
        showToast('Ehhez a privat szobahoz meghivokod szukseges.');
        updateActionGuards();
        return false;
    }

    socket.emit('joinRoom', {
        roomId: currentRoomId,
        username
    });

    typingUsers.clear();
    renderTypingIndicator();
    updateActionGuards();

    return true;
}

function setupSocket() {
    socket = io();

    socket.on('connect', () => {
        isSocketConnected = true;
        setBadgeState(elements.serverStatus, 'Szerver: kapcsolodva', 'ok');
        joinCurrentRoom();
        startHealthMonitoring();
        updateActionGuards();
    });

    socket.on('disconnect', () => {
        isSocketConnected = false;
        setBadgeState(elements.serverStatus, 'Szerver: kapcsolat megszakadt', 'bad');
        updateSmartHint('A kapcsolat megszakadt, varj az ujracsatlakozasra.');
        updateActionGuards();
    });

    socket.on('message', (message) => {
        const existing = elements.messages.querySelector('[data-message-id="' + message.id + '"]');

        if (existing) {
            return;
        }

        const timestamp = new Date(message.created_at).toLocaleTimeString('hu-HU', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        const wrapper = document.createElement('article');
        const isOwnMessage = message.username.toLowerCase() === getCurrentUsername().toLowerCase();
        wrapper.className = `chat-message${isOwnMessage ? ' me' : ''}`;
        wrapper.dataset.messageId = String(message.id);
        wrapper.innerHTML = `<div><strong>${escapeHtml(message.username)}</strong><time>${timestamp}</time></div>${buildMessageBody(
            message
        )}${buildMessageActions(message)}`;

        elements.messages.appendChild(wrapper);
        elements.messages.scrollTop = elements.messages.scrollHeight;
        loadStats().catch(() => {});
    });

    socket.on('hostsUpdate', (hosts) => {
        renderHosts(hosts);
    });

    socket.on('usersUpdate', (users) => {
        renderUsers(users);
    });

    socket.on('typingUpdate', (payload) => {
        if (Number(payload?.roomId) !== Number(currentRoomId)) {
            return;
        }

        const username = (payload?.username || '').toString().trim();
        if (!username || username === getCurrentUsername()) {
            return;
        }

        if (payload.typing) {
            typingUsers.add(username);
        } else {
            typingUsers.delete(username);
        }

        renderTypingIndicator();
    });

    socket.on('systemNotice', (payload) => {
        const message = (payload?.message || '').toString().trim();
        if (!message) {
            return;
        }

        showToast(message);
    });
}

async function createRoom() {
    const name = elements.newRoomInput.value.trim();

    if (name.length < 2) {
        return;
    }

    const isPrivate = elements.privateRoomToggle.checked;
    const selectedMembers = Array.from(elements.privateMembersSelect.selectedOptions || []).map(
        (option) => option.value
    );

    if (isPrivate && selectedMembers.length < 1) {
        showToast('Privat szobahoz valassz ki legalabb 1 usert.');
        return;
    }

    const room = await fetchJson('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name,
            isPrivate,
            username: getCurrentUsername(),
            members: selectedMembers
        })
    });

    elements.newRoomInput.value = '';
    elements.privateRoomToggle.checked = false;
    elements.privateMembersSelect.selectedIndex = -1;
    updatePrivateMembersVisibility();
    await loadRooms(room.id);
    joinCurrentRoom();
    await loadMessages();
    await loadStats();

    if (isPrivate && room.inviteCode) {
        showToast(`Privat szoba letrehozva. Meghivokod: ${room.inviteCode}`);
    } else {
        showToast('Szoba letrehozva');
    }

    updateActionGuards();
}

async function sendMessage() {
    const joined = joinCurrentRoom();
    if (!joined) {
        return;
    }

    if (currentComposeMode === 'image') {
        if (!passClientSpamCheck(elements.messageInput.value || '__image__')) {
            return;
        }

        await uploadImageMessage();
        await loadStats();
        emitTypingStop();
        return;
    }

    const content = elements.messageInput.value.trim();

    if (!content) {
        return;
    }

    if (!passClientSpamCheck(content)) {
        return;
    }

    socket.emit('message', {
        roomId: currentRoomId,
        username: elements.usernameInput.value.trim(),
        content,
        messageType: currentComposeMode
    });

    elements.messageInput.value = '';
    clearDraft();
    emitTypingStop();
    updateActionGuards();
}

function bindEvents() {
    // Theme toggle button
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            toggleTheme();
        });
    }

    for (const button of modeButtons) {
        button.addEventListener('click', () => {
            setComposeMode(button.dataset.mode || 'text');
        });
    }

    for (const button of emojiButtons) {
        button.addEventListener('click', () => {
            const emoji = button.dataset.emoji || '';
            elements.messageInput.value = emoji;
            setComposeMode('emoji');
            elements.messageInput.focus();
        });
    }

    elements.favoriteRoomBtn.addEventListener('click', () => {
        const favoriteId = getFavoriteRoomId();

        if (favoriteId === Number(currentRoomId)) {
            localStorage.removeItem('localchat_favorite_room');
            showToast('Kedvenc szoba torolve');
        } else {
            localStorage.setItem('localchat_favorite_room', String(currentRoomId));
            showToast('Kedvenc szoba mentve');
        }

        setFavoriteRoomButtonState();
    });

    elements.copyConnectUrlBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(elements.clientConnectUrl.textContent.trim());
            showToast('Kliens URL masolva');
        } catch (error) {
            showToast('Masolas nem sikerult');
        }
    });

    elements.usernameInput.addEventListener('blur', () => {
        const value = getCurrentUsername();
        if (value.length >= 2) {
            localStorage.setItem('localchat_username', value);
            joinCurrentRoom();
            renderPrivateMemberOptions();
            loadRooms(currentRoomId)
                .then(() => refreshCurrentRoomAccess())
                .then(() => loadMessages())
                .catch(() => {
                    showToast('A szobalista frissitese nem sikerult.');
                });
        }

        updateActionGuards();
    });

    elements.usernameInput.addEventListener('input', () => {
        updateActionGuards();
    });

    elements.roomSelect.addEventListener('change', async (event) => {
        try {
            currentRoomId = Number(event.target.value);
            await refreshCurrentRoomAccess();
            joinCurrentRoom();
            await loadMessages();
            setFavoriteRoomButtonState();
            showToast(`Szoba valtas: ${elements.roomSelect.options[elements.roomSelect.selectedIndex]?.text || 'ismeretlen'}`);
        } catch (error) {
            showToast(error.message || 'Szoba valtas sikertelen.');
            await loadRooms();
            await loadMessages();
        }

        updateActionGuards();
    });

    elements.searchBtn.addEventListener('click', async () => {
        try {
            await searchMessages();
        } catch (error) {
            alert(error.message);
        }
    });

    elements.clearSearchBtn.addEventListener('click', async () => {
        elements.searchInput.value = '';
        await loadMessages();
        showToast('Keresesi szuro torolve');
    });

    elements.messages.addEventListener('click', async (event) => {
        const button = event.target.closest('.copy-btn');
        if (!button) {
            return;
        }

        const text = button.dataset.copyText || button.dataset.copyUrl || '';
        if (!text) {
            return;
        }

        try {
            await navigator.clipboard.writeText(text);
            showToast('Uzenet tartalom masolva');
        } catch (error) {
            showToast('Masolas nem sikerult');
        }
    });

    elements.createRoomBtn.addEventListener('click', async () => {
        try {
            await createRoom();
        } catch (error) {
            alert(error.message);
        }
    });

    elements.sendBtn.addEventListener('click', async () => {
        await sendMessage();
    });

    elements.messageInput.addEventListener('keydown', async (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            await sendMessage();
            return;
        }

        emitTypingStart();
        scheduleTypingStop();
    });

    elements.messageInput.addEventListener('input', () => {
        updateMessageCounter();

        if (currentComposeMode === 'image') {
            return;
        }

        if (elements.messageInput.value.trim().length === 0) {
            emitTypingStop();
            return;
        }

        emitTypingStart();
        scheduleTypingStop();
        saveDraft();
        updateActionGuards();
    });

    elements.rescanBtn.addEventListener('click', async () => {
        setBadgeState(elements.discoveryStatus, 'Discovery: rescan...', 'warn');

        try {
            const hosts = await fetchJson('/api/hosts/rescan', { method: 'POST' });
            renderHosts(hosts);
            setBadgeState(elements.discoveryStatus, 'Discovery fut', 'ok');
            showToast('Rescan kesz');
        } catch (error) {
            setBadgeState(elements.discoveryStatus, 'Discovery hiba', 'bad');
            alert(error.message);
        }
    });

    elements.hostFilterControls?.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const button = target.closest('.host-filter-chip');
        if (!button) {
            return;
        }

        setHostFilter(button.dataset.filter || 'all');
    });

    elements.hostsList?.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const statusButton = target.closest('.badge-state');
        if (!statusButton) {
            return;
        }

        setHostFilter(statusButton.dataset.hostStatus || 'all');
    });

    elements.privateRoomToggle.addEventListener('change', () => {
        updatePrivateMembersVisibility();
        updateActionGuards();
    });

    elements.joinPrivateRoomBtn.addEventListener('click', async () => {
        try {
            await joinPrivateRoomByCode();
        } catch (error) {
            showToast(error.message || 'Privat csatlakozas sikertelen.');
        }
    });

    elements.removeMemberBtn.addEventListener('click', async () => {
        try {
            await removeSelectedRoomMembers();
        } catch (error) {
            showToast(error.message || 'Tag torles sikertelen.');
        }
    });

    elements.rotateInviteBtn.addEventListener('click', async () => {
        try {
            await rotateInviteCode();
        } catch (error) {
            showToast(error.message || 'Meghivokod forgatas sikertelen.');
        }
    });

    elements.copyOwnerInviteBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(elements.ownerInviteCode.value || '');
            showToast('Meghivokod masolva.');
        } catch (error) {
            showToast('Masolas nem sikerult.');
        }
    });

    elements.quickLanTestBtn.addEventListener('click', async () => {
        try {
            await runQuickLanTest();
            showToast('LAN gyorsteszt frissitve.');
        } catch (error) {
            showToast('LAN gyorsteszt sikertelen.');
        }
    });
}

async function bootstrap() {
    // Initialize theme first
    initTheme();

    const savedUsername = localStorage.getItem('localchat_username');
    elements.usernameInput.value = savedUsername || `user-${Math.floor(Math.random() * 1000)}`;

    try {
        await loadConfig();
        await loadDiagnostics();
        await loadRooms();
        await refreshCurrentRoomAccess();
        await loadMessages();
        await loadHosts();
        await loadStats();
        await loadNetworkBackupPlan();
        await runQuickLanTest();
        await loadSecureLogStatus();
        await loadRecoveryStatus();
    } catch (error) {
        setBadgeState(elements.serverStatus, 'Inicializalasi hiba', 'bad');
        console.error(error);
    }

    setupSocket();
    bindEvents();
    initHelpTooltips();
    setComposeMode('text');
    setHostFilter('all');
    loadDraft();
    updatePrivateMembersVisibility();
    updateMessageCounter();
    updateActionGuards();

    setInterval(() => {
        loadSecureLogStatus().catch(() => {});
    }, 15000);
}

bootstrap();
