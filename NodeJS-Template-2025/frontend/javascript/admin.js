const elements = {
    adminTokenInput: document.getElementById('adminTokenInput'),
    loadDiagnosticsBtn: document.getElementById('loadDiagnosticsBtn'),
    runSmokeBtn: document.getElementById('runSmokeBtn'),
    adminStatus: document.getElementById('adminStatus'),
    secureLogList: document.getElementById('secureLogList'),
    recoveryList: document.getElementById('recoveryList'),
    smokeSummaryList: document.getElementById('smokeSummaryList'),
    smokeChecks: document.getElementById('smokeChecks'),
    runtimeList: document.getElementById('runtimeList'),
    connectUrlsList: document.getElementById('connectUrlsList')
};

function setStatus(message, isError = false) {
    elements.adminStatus.textContent = `Státusz: ${message}`;
    elements.adminStatus.style.color = isError ? '#fecaca' : '#b0cadc';
}

function getToken() {
    return (elements.adminTokenInput.value || '').trim();
}

function saveToken(token) {
    localStorage.setItem('localchat_admin_token', token);
}

function restoreToken() {
    elements.adminTokenInput.value = localStorage.getItem('localchat_admin_token') || '';
}

async function fetchAdminJson(url, options = {}) {
    const token = getToken();
    if (!token) {
        throw new Error('Adj meg admin tokent.');
    }

    saveToken(token);

    const response = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'x-admin-token': token,
            ...(options.headers || {})
        }
    });

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || `HTTP ${response.status}`);
    }

    return response.json();
}

function renderKvList(element, map) {
    const entries = Object.entries(map || {});
    if (!entries.length) {
        element.innerHTML = '<li>Nincs adat.</li>';
        return;
    }

    element.innerHTML = entries
        .map(([key, value]) => `<li><strong>${key}</strong>: ${String(value)}</li>`)
        .join('');
}

function renderChecks(checks = []) {
    if (!checks.length) {
        elements.smokeChecks.innerHTML = '<p class="mb-0">Nincs check adat.</p>';
        return;
    }

    elements.smokeChecks.innerHTML = checks
        .map(
            (item) =>
                `<article class="check-item ${item.ok ? 'ok' : 'bad'}"><div><strong>${item.name}</strong></div><small>${item.details || ''}</small></article>`
        )
        .join('');
}

function renderDiagnostics(payload) {
    const secureLog = payload.secureLog || {};
    const recovery = payload.recovery || {};
    const runtime = payload.runtime || {};
    const smoke = payload.startupSmoke || {};

    renderKvList(elements.secureLogList, {
        path: secureLog.path || 'n/a',
        exists: secureLog.exists,
        queuedEntries: secureLog.queuedEntries,
        flushIntervalMs: secureLog.flushIntervalMs,
        batchMaxSize: secureLog.batchMaxSize,
        rotateMaxBytes: secureLog.rotateMaxBytes,
        rotateFiles: secureLog.rotateFiles,
        lastFlushAt: secureLog.lastFlushAt || 'n/a',
        lastError: secureLog.lastError || 'none'
    });

    renderKvList(elements.recoveryList, {
        attempted: recovery.attempted,
        ok: recovery.ok,
        reason: recovery.reason || 'n/a',
        recoveredRooms: recovery.recoveredRooms || 0,
        recoveredMessages: recovery.recoveredMessages || 0,
        eventsRead: recovery.eventsRead || 0,
        details: recovery.details || 'n/a'
    });

    renderKvList(elements.runtimeList, {
        serverHost: runtime.serverHost || 'n/a',
        serverPort: runtime.serverPort || 'n/a',
        lanOnly: runtime.lanOnly,
        discoveryMode: runtime.discoveryMode,
        preferredInterface: runtime.networkDiagnostics?.preferredInterface?.name || 'n/a',
        preferredAddress: runtime.networkDiagnostics?.preferredInterface?.address || 'n/a'
    });

    const connectUrls = Array.isArray(runtime.connectUrls) ? runtime.connectUrls : [];
    elements.connectUrlsList.innerHTML = connectUrls.length
        ? connectUrls.map((url) => `<li>${url}</li>`).join('')
        : '<li>Nincs URL adat.</li>';

    renderKvList(elements.smokeSummaryList, {
        context: smoke.context || 'n/a',
        status: smoke.status || 'n/a',
        ok: smoke.ok,
        elapsedMs: smoke.elapsedMs || 'n/a',
        timestamp: smoke.timestamp || 'n/a'
    });

    renderChecks(smoke.checks || []);
}

async function loadDiagnostics() {
    setStatus('diagnosztika frissítése...');
    const payload = await fetchAdminJson('/api/admin/diagnostics');
    renderDiagnostics(payload);
    setStatus('diagnosztika frissítve');
}

async function runSmoke() {
    setStatus('startup smoke futtatása...');
    const payload = await fetchAdminJson('/api/admin/smoke-test', {
        method: 'POST',
        body: JSON.stringify({})
    });

    renderKvList(elements.smokeSummaryList, {
        context: payload.context || 'n/a',
        status: payload.status || 'n/a',
        ok: payload.ok,
        elapsedMs: payload.elapsedMs || 'n/a',
        timestamp: payload.timestamp || 'n/a'
    });
    renderChecks(payload.checks || []);
    setStatus('smoke teszt lefutott');
}

function bindEvents() {
    elements.loadDiagnosticsBtn.addEventListener('click', () => {
        loadDiagnostics().catch((error) => {
            setStatus(error.message || 'Diagnosztika hiba.', true);
        });
    });

    elements.runSmokeBtn.addEventListener('click', () => {
        runSmoke()
            .then(() => loadDiagnostics())
            .catch((error) => {
                setStatus(error.message || 'Smoke teszt hiba.', true);
            });
    });

    elements.adminTokenInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            loadDiagnostics().catch((error) => {
                setStatus(error.message || 'Diagnosztika hiba.', true);
            });
        }
    });
}

function bootstrap() {
    restoreToken();
    bindEvents();
}

bootstrap();
