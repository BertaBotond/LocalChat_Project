// 🎯 Kliens Oldali Fejlesztések - Kód Sablonok
// Ezek a kódsablonok könnyedén integrálhatók az index.js-be

// ============================================
// 1. MESSAGE REACTIONS (Könnyen implementálható)
// ============================================

/**
 * Üzenethez emoji-val való reagálás
 * UI: Üzenet alatt: ❤️(2) 👍(1) 🔥(5) ...
 */

const messageReactions = new Map(); // message_id -> { emoji: count }

function addMessageReaction(messageId, emoji) {
    if (!messageReactions.has(messageId)) {
        messageReactions.set(messageId, {});
    }
    
    const reactions = messageReactions.get(messageId);
    reactions[emoji] = (reactions[emoji] || 0) + 1;
    
    // Szerver-el szinkronizálás
    socket.emit('addReaction', {
        messageId,
        emoji,
        username: getCurrentUsername()
    });
    
    renderMessageReactions(messageId);
}

function renderMessageReactions(messageId) {
    const element = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!element || !messageReactions.has(messageId)) return;
    
    const reactions = messageReactions.get(messageId);
    const html = Object.entries(reactions)
        .map(([emoji, count]) => 
            `<button class="reaction-btn" data-emoji="${emoji}">
                ${emoji} <span>${count}</span>
            </button>`
        )
        .join('');
    
    let reactionsContainer = element.querySelector('.reactions');
    if (!reactionsContainer) {
        reactionsContainer = document.createElement('div');
        reactionsContainer.className = 'reactions';
        element.appendChild(reactionsContainer);
    }
    reactionsContainer.innerHTML = html;
}

// CSS hozzáadása:
/*
.reactions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
    flex-wrap: wrap;
}

.reaction-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.5rem;
    border-radius: 15px;
    border: 1px solid var(--border-color);
    background: var(--panel-accent);
    cursor: pointer;
    font-size: 0.9rem;
    transition: all 0.2s ease;
}

.reaction-btn:hover {
    background: var(--primary);
    border-color: var(--primary);
    transform: scale(1.1);
}

.reaction-btn span {
    font-size: 0.8rem;
    color: var(--text-muted);
    font-weight: 600;
}
*/

// ============================================
// 2. RICH TEXT FORMATTING (Markdown support)
// ============================================

function parseMarkdown(text) {
    return text
        // Bold
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        // Italic
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        // Code inline
        .replace(/`(.*?)`/g, '<code>$1</code>')
        // Quote
        .replace(/^> (.*)$/gm, '<blockquote>$1</blockquote>')
        // Links
        .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>')
        // Line breaks
        .replace(/\n/g, '<br>');
}

function buildMessageBodyEnhanced(message) {
    const type = (message.message_type || 'text').toLowerCase();
    const safeContent = escapeHtml(message.content || '');

    if (type === 'code') {
        return `<pre><code>${safeContent}</code></pre>`;
    }

    if (type === 'text') {
        // Markdown parsing
        return `<div>${parseMarkdown(safeContent)}</div>`;
    }

    if (type === 'emoji') {
        return `<div class="emoji-content">${safeContent}</div>`;
    }

    if (type === 'image') {
        const safePath = escapeHtml(message.file_path || '');
        const safeName = escapeHtml(message.original_name || 'kép');
        const caption = safeContent ? `<div class="mt-2">${parseMarkdown(safeContent)}</div>` : '';
        return `<div class="image-wrap"><img src="${safePath}" alt="${safeName}" loading="lazy" /></div>${caption}`;
    }

    return `<div>${parseMarkdown(safeContent)}</div>`;
}

// ============================================
// 3. MESSAGE EDIT/DELETE (Magas prioritás)
// ============================================

const messageEditWindow = 30000; // 30 másodperc

async function editMessage(messageId, newContent) {
    try {
        const response = await fetch(`/api/messages/${messageId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: newContent,
                username: getCurrentUsername()
            })
        });
        
        if (!response.ok) throw new Error('Edit failed');
        
        // Frissítés UI-ban
        const element = document.querySelector(`[data-message-id="${messageId}"]`);
        if (element) {
            element.querySelector('.message-content').innerHTML = parseMarkdown(escapeHtml(newContent));
            element.classList.add('edited'); // CSS: opacity 0.8, after "edited"
        }
        
        showToast('Üzenet szerkesztve');
    } catch (error) {
        showToast(`Szerkesztés sikertelen: ${error.message}`);
    }
}

async function deleteMessage(messageId) {
    if (!confirm('Biztosan törlöd ezt az üzenetet?')) return;
    
    try {
        const response = await fetch(`/api/messages/${messageId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: getCurrentUsername()
            })
        });
        
        if (!response.ok) throw new Error('Delete failed');
        
        const element = document.querySelector(`[data-message-id="${messageId}"]`);
        if (element) {
            element.style.opacity = '0.5';
            element.querySelector('.message-content').textContent = '[Üzenet törölve]';
        }
        
        showToast('Üzenet törölve');
    } catch (error) {
        showToast(`Törlés sikertelen: ${error.message}`);
    }
}

// Üzenet hover menu-ben:
/*
<div class="message-actions">
    <button class="action-btn" onclick="copyMessage(this)">📋</button>
    <button class="action-btn" onclick="editMessage(${id})">✏️</button>
    <button class="action-btn danger" onclick="deleteMessage(${id})">🗑️</button>
</div>
*/

// ============================================
// 4. KEYBOARD SHORTCUTS (Könnyű)
// ============================================

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        const isMeta = e.ctrlKey || e.metaKey;
        
        // Ctrl+K: Search aktiválása
        if (isMeta && e.key === 'k') {
            e.preventDefault();
            elements.searchInput.focus();
        }
        
        // Ctrl+Shift+L: Utolsó üzenet másolása
        if (isMeta && e.shiftKey && e.key === 'l') {
            e.preventDefault();
            const lastMsg = elements.messages.querySelector('.message:last-child');
            if (lastMsg) {
                navigator.clipboard.writeText(lastMsg.textContent.trim());
                showToast('Utolsó üzenet másolva');
            }
        }
        
        // Ctrl+Plus: Font nagyítás
        if (isMeta && (e.key === '+' || e.key === '=')) {
            e.preventDefault();
            adjustFontSize(1);
        }
        
        // Ctrl+Minus: Font kicsinyítés
        if (isMeta && e.key === '-') {
            e.preventDefault();
            adjustFontSize(-1);
        }
        
        // ESC: Modal bezárása
        if (e.key === 'Escape') {
            e.preventDefault();
            // Modal close logic
        }
    });
}

// ============================================
// 5. FONT SIZE ADJUSTER (Könnyű)
// ============================================

const fontSizes = [12, 14, 16, 18, 20];
const defaultFontSize = 16;
let currentFontSizeIndex = fontSizes.indexOf(defaultFontSize);

function adjustFontSize(direction) {
    currentFontSizeIndex = Math.max(0, Math.min(fontSizes.length - 1, currentFontSizeIndex + direction));
    const newSize = fontSizes[currentFontSizeIndex];
    
    document.documentElement.style.fontSize = newSize + 'px';
    localStorage.setItem('fontSize', newSize);
    
    showToast(`Betűméret: ${newSize}px`);
}

function initFontSize() {
    const saved = localStorage.getItem('fontSize');
    if (saved) {
        document.documentElement.style.fontSize = saved + 'px';
        currentFontSizeIndex = fontSizes.indexOf(parseInt(saved));
    }
}

// ============================================
// 6. NOTIFICATION SOUNDS (Könnyű)
// ============================================

const notificationSounds = {
    join: '/assets/sounds/join.mp3',
    message: '/assets/sounds/message.mp3',
    mention: '/assets/sounds/mention.mp3'
};

let soundEnabled = getPreference('soundEnabled', false);
let soundVolume = getPreference('soundVolume', 50);

function playNotificationSound(type = 'message') {
    if (!soundEnabled || !notificationSounds[type]) return;
    
    const audio = new Audio(notificationSounds[type]);
    audio.volume = soundVolume / 100;
    audio.play().catch(e => console.log('Sound play failed:', e));
}

function setSoundEnabled(enabled) {
    soundEnabled = enabled;
    savePreference('soundEnabled', enabled);
    showToast(`Hangok: ${enabled ? 'bekapcsolva' : 'kikapcsolva'}`);
}

function setSoundVolume(volume) {
    soundVolume = Math.max(0, Math.min(100, volume));
    savePreference('soundVolume', soundVolume);
}

// HTML: Sound control gomb
/*
<button id="soundToggleBtn" onclick="toggleSound()">🔊</button>
<input type="range" min="0" max="100" value="${soundVolume}" 
       onchange="setSoundVolume(this.value)">
*/

// ============================================
// 7. MESSAGE THREADING (Magas prioritás)
// ============================================

let replyTarget = null;

function setReplyTarget(messageId, username, content) {
    replyTarget = { messageId, username, content };
    
    const preview = document.createElement('div');
    preview.className = 'reply-preview';
    preview.innerHTML = `
        <div class="reply-preview-header">
            <span>Válasz ${escapeHtml(username)}-nak:</span>
            <button onclick="clearReply()">✕</button>
        </div>
        <div class="reply-preview-content">
            ${escapeHtml(content.substring(0, 100))}...
        </div>
    `;
    
    elements.messageInput.parentElement.insertBefore(preview, elements.messageInput);
}

function clearReply() {
    replyTarget = null;
    const preview = document.querySelector('.reply-preview');
    if (preview) preview.remove();
}

async function sendReplyMessage() {
    const content = elements.messageInput.value.trim();
    if (!content) return;
    
    const payload = {
        roomId: currentRoomId,
        username: elements.usernameInput.value.trim(),
        content,
        messageType: currentComposeMode,
        replyTo: replyTarget?.messageId || null
    };
    
    socket.emit('message', payload);
    elements.messageInput.value = '';
    clearReply();
}

// CSS:
/*
.reply-preview {
    padding: 0.75rem;
    background: var(--panel-accent);
    border-left: 3px solid var(--primary);
    border-radius: 4px;
    margin-bottom: 0.5rem;
}

.reply-preview-header {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 0.3rem;
}

.reply-preview-content {
    font-size: 0.85rem;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
*/

// ============================================
// 8. AUTO-RECONNECT VISUAL FEEDBACK
// ============================================

let reconnectAttempt = 0;
const maxReconnectAttempts = 5;

function showReconnectStatus(connected) {
    const statusEl = elements.serverStatus;
    
    if (connected) {
        setBadgeState(statusEl, 'Szerver: kapcsolódva', 'ok');
        reconnectAttempt = 0;
    } else {
        reconnectAttempt++;
        if (reconnectAttempt <= maxReconnectAttempts) {
            const percent = Math.round((reconnectAttempt / maxReconnectAttempts) * 100);
            setBadgeState(statusEl, `Újracsatlakozás: ${percent}%`, 'warn');
        } else {
            setBadgeState(statusEl, 'Szerver: nem elérhető', 'bad');
            showToast('❌ Max reconnect attempts reached');
        }
    }
}

// Socket event-ek:
socket.on('connect', () => {
    showReconnectStatus(true);
});

socket.on('disconnect', () => {
    showReconnectStatus(false);
});

// ============================================
// 9. ADVANCED MESSAGE SEARCH
// ============================================

function advancedSearch() {
    const query = elements.searchInput.value.trim();
    
    // Parse filters: @user #room type:image from:2024-01-01
    const filters = {
        username: null,
        room: null,
        type: null,
        from: null,
        to: null,
        text: ''
    };
    
    const parts = query.split(' ');
    const textParts = [];
    
    for (const part of parts) {
        if (part.startsWith('@')) {
            filters.username = part.substring(1);
        } else if (part.startsWith('#')) {
            filters.room = part.substring(1);
        } else if (part.startsWith('type:')) {
            filters.type = part.substring(5);
        } else if (part.startsWith('from:')) {
            filters.from = part.substring(5);
        } else if (part.startsWith('to:')) {
            filters.to = part.substring(3);
        } else {
            textParts.push(part);
        }
    }
    
    filters.text = textParts.join(' ');
    
    return fetch(`/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: currentRoomId, ...filters })
    }).then(r => r.json());
}

// ============================================
// Bootstrap integrálása
// ============================================

async function bootstrap() {
    initTheme();
    initFontSize();
    setupKeyboardShortcuts();
    
    // Fennmaradó bootstrap kód...
}

// ============================================
// Export / Importálás más fájlokba
// ============================================

// Szimpla másolás-beillesztés az index.js elejére vagy végére
// Vagy moduláris: 
//   <script src="features/reactions.js"></script>
//   <script src="features/formatting.js"></script>
//   stb.
