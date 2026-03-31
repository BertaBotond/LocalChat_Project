/**
 * Arcade Game System
 * Phase 3 Frontend Implementation - Canvas rendering, input handling, Socket.IO integration
 */

const arcadeColors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F'];
const arcadeKeyState = new Set();
let arcadeTouchStart = null;

// Expose globals that will be set by main index.js
let currentGameMode = null;
let gameState = {
    currentGame: null,
    players: [],
    entities: [],
    currentTick: 0,
    isRunning: false
};
let gameRenderLoopId = null;
let lastFrameTime = Date.now();
let frameCount = 0;
let fps = 0;

function switchGameView(view) {
    const elements = {
        chatStageTabs: Array.from(document.querySelectorAll('.chat-stage-tab')),
        chatStageView: document.getElementById('chatStageView'),
        gameStageView: document.getElementById('gameStageView')
    };

    if (view === 'game' && !currentGameMode) {
        alert('Válassz ki egy játékmódot először!');
        return;
    }
    
    const chatTab = elements.chatStageTabs.find(t => t.dataset.view === 'chat');
    const gameTab = elements.chatStageTabs.find(t => t.dataset.view === 'game');
    
    if (view === 'chat') {
        chatTab?.classList.add('active');
        gameTab?.classList.remove('active');
        elements.chatStageView?.classList.add('active');
        elements.gameStageView?.classList.remove('active');
    } else {
        chatTab?.classList.remove('active');
        gameTab?.classList.add('active');
        elements.chatStageView?.classList.remove('active');
        elements.gameStageView?.classList.add('active');
    }
}

function startArcadeGame(gameMode, socket, roomId, username) {
    currentGameMode = gameMode;
    
    if (!socket) {
        alert('A socketkapcsolat nem aktív.');
        return;
    }

    const safeRoomId = Number(roomId);
    const safeUsername = String(username || '').trim();

    if (!Number.isFinite(safeRoomId) || safeRoomId <= 0) {
        alert('Érvénytelen szobaazonosító.');
        return;
    }

    if (safeUsername.length < 2) {
        alert('Adj meg legalább 2 karakteres felhasználónevet.');
        return;
    }

    socket.emit('arcade:startGame', {
        roomId: safeRoomId,
        gameMode,
        username: safeUsername
    });

    const joinPayload = {
        roomId: safeRoomId,
        gameMode,
        username: safeUsername
    };

    // The server creates rooms asynchronously; retry join briefly to avoid race conditions.
    const tryJoin = (retriesLeft) => {
        socket.emit('arcade:join', joinPayload);

        if (retriesLeft <= 0) {
            return;
        }

        setTimeout(() => {
            const joined = (gameState.players || []).some((player) => {
                return String(player?.username || '').toLowerCase() === safeUsername.toLowerCase();
            });

            if (!joined && currentGameMode === gameMode) {
                tryJoin(retriesLeft - 1);
            }
        }, 250);
    };

    tryJoin(6);

    switchGameView('game');
}

function leaveArcadeGame(socket) {
    if (!socket || !currentGameMode) {
        return;
    }

    socket.emit('arcade:leave', {
        gameMode: currentGameMode
    });

    stopArcadeGame();
    switchGameView('chat');
}

function stopArcadeGame() {
    currentGameMode = null;
    gameState = {
        currentGame: null,
        players: [],
        entities: [],
        currentTick: 0,
        isRunning: false
    };

    if (gameRenderLoopId) {
        cancelAnimationFrame(gameRenderLoopId);
        gameRenderLoopId = null;
    }

    const canvas = document.getElementById('arcadeGameCanvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.fillStyle = '#0a1520';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
    }
}

function updateGameScorePanel() {
    const gameScoresList = document.getElementById('gameScoresList');
    const gameViewPlayers = document.getElementById('gameViewPlayers');

    if (!gameScoresList || !gameState.players) {
        return;
    }

    const sorted = [...gameState.players].sort((a, b) => {
        const aScore = a.score || 0;
        const bScore = b.score || 0;
        return bScore - aScore;
    });

    gameScoresList.innerHTML = sorted
        .map((player, idx) => {
            const statText = getPlayerStatText(player);
            return `<li class="game-score-item">
                <span class="game-score-player-name">${idx + 1}. ${player.username}</span>
                <span class="game-score-player-score">${statText}</span>
            </li>`;
        })
        .join('');

    gameViewPlayers.textContent = `Játékosok: ${gameState.players.length}`;
}

function getPlayerStatText(player) {
    if (!currentGameMode || !player) return '0';

    switch (currentGameMode) {
        case 'agar':
            return `${Math.round(player.score || 0)} tömeg`;
        case 'slither':
            return `${Math.round(player.score || 0)} szegmens`;
        case 'racing':
            return `CP: ${Math.round(player.score || 0)}`;
        case 'flappy':
            return `${Math.round(player.score || 0)} méter`;
        default:
            return String(Math.round(player.score || 0));
    }
}

function renderArcadeGame() {
    const canvas = document.getElementById('arcadeGameCanvas');
    if (!canvas || !currentGameMode) {
        return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = getGameBackgroundColor(currentGameMode);
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, canvas.width, canvas.height);

    if (!gameState.entities || gameState.entities.length === 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.font = '16px Sora';
        ctx.textAlign = 'center';
        ctx.fillText('Várakozás a játékadatokra...', canvas.width / 2, canvas.height / 2);
        drawFPS(ctx);
        return;
    }

    // Render entities based on game mode
    switch (currentGameMode) {
        case 'agar':
            renderAgarEntities(ctx, gameState.entities);
            break;
        case 'slither':
            renderSlitherEntities(ctx, gameState.entities);
            break;
        case 'racing':
            renderRacingEntities(ctx, gameState.entities);
            break;
        case 'flappy':
            renderFlappyEntities(ctx, gameState.entities);
            break;
    }

    drawFPS(ctx);
}

function getGameBackgroundColor(gameMode) {
    switch (gameMode) {
        case 'agar':
            return '#0a1520';
        case 'slither':
            return '#0f1a1a';
        case 'racing':
            return '#1a1a2e';
        case 'flappy':
            return '#1e3c72';
        default:
            return '#0a1520';
    }
}

function renderAgarEntities(ctx, entities) {
    entities.forEach(entity => {
        if (!entity || entity.x === undefined || entity.y === undefined) return;

        const radius = Math.sqrt((entity.mass || 1) / Math.PI);
        const color = entity.color || arcadeColors[Math.floor(Math.random() * arcadeColors.length)];
        
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(entity.x, entity.y, radius, 0, Math.PI * 2);
        ctx.fill();

        if (entity.isPlayer) {
            ctx.fillStyle = 'white';
            ctx.font = 'bold 12px Sora';
            ctx.textAlign = 'center';
            ctx.fillText(entity.playerName || 'Ismeretlen', entity.x, entity.y - radius - 8);
        }
    });
}

function renderSlitherEntities(ctx, entities) {
    entities.forEach(entity => {
        if (!entity || !entity.segments || entity.segments.length === 0) return;

        const color = entity.color || arcadeColors[Math.floor(Math.random() * arcadeColors.length)];
        
        entity.segments.forEach((segment, idx) => {
            const opacity = 1 - (idx / entity.segments.length) * 0.5;
            ctx.fillStyle = `rgba(${hexToRgb(color)}, ${opacity})`;
            ctx.beginPath();
            ctx.arc(segment.x, segment.y, 5, 0, Math.PI * 2);
            ctx.fill();
        });

        if (entity.segments.length > 0) {
            const head = entity.segments[0];
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(head.x, head.y, 7, 0, Math.PI * 2);
            ctx.fill();

            if (entity.isPlayer) {
                ctx.fillStyle = 'white';
                ctx.font = 'bold 12px Sora';
                ctx.textAlign = 'center';
                ctx.fillText(entity.playerName || 'Ismeretlen', head.x, head.y - 12);
            }
        }
    });
}

function renderRacingEntities(ctx, entities) {
    entities.forEach(entity => {
        if (!entity || entity.x === undefined || entity.y === undefined) return;

        const width = 30;
        const height = 15;
        const angle = entity.angle || 0;

        ctx.save();
        ctx.translate(entity.x, entity.y);
        ctx.rotate(angle);

        const color = entity.color || arcadeColors[Math.floor(Math.random() * arcadeColors.length)];
        ctx.fillStyle = color;
        ctx.fillRect(-width / 2, -height / 2, width, height);

        ctx.fillStyle = 'white';
        ctx.fillRect(width / 2 - 4, -height / 4, 4, height / 2);

        ctx.restore();

        if (entity.isPlayer) {
            ctx.fillStyle = 'white';
            ctx.font = 'bold 12px Sora';
            ctx.textAlign = 'center';
            ctx.fillText(entity.playerName || 'Ismeretlen', entity.x, entity.y - 20);
        }
    });
}

function renderFlappyEntities(ctx, entities) {
    entities.forEach(entity => {
        if (!entity) return;

        if (entity.isPlayer) {
            ctx.fillStyle = entity.color || '#FFD700';
            ctx.fillRect(entity.x - 8, entity.y - 8, 16, 16);

            ctx.fillStyle = 'white';
            ctx.fillRect(entity.x - 5, entity.y - 5, 3, 3);
            ctx.fillRect(entity.x + 2, entity.y - 5, 3, 3);

            ctx.fillStyle = 'white';
            ctx.font = 'bold 12px Sora';
            ctx.textAlign = 'center';
            ctx.fillText(entity.playerName || 'Ismeretlen', entity.x, entity.y - 20);
        } else if (entity.type === 'obstacle') {
            ctx.fillStyle = '#2ecc71';
            ctx.fillRect(entity.x, entity.y, entity.width || 40, entity.height || 150);
        }
    });
}

function drawFPS(ctx) {
    const now = Date.now();
    frameCount++;

    if (now - lastFrameTime >= 1000) {
        fps = frameCount;
        frameCount = 0;
        lastFrameTime = now;
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`FPS: ${fps} | Tick: ${gameState.currentTick}`, 8, 20);
}

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return '0,0,0';
    return `${parseInt(result[1], 16)},${parseInt(result[2], 16)},${parseInt(result[3], 16)}`;
}

function handleArcadeKeyDown(e) {
    if (!currentGameMode) return;

    arcadeKeyState.add(e.key.toLowerCase());

    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(e.key.toLowerCase())) {
        e.preventDefault();
    }
}

function handleArcadeKeyUp(e) {
    if (!currentGameMode) return;
    arcadeKeyState.delete(e.key.toLowerCase());
}

function sendArcadeInput(socket) {
    if (!socket || !currentGameMode) return;

    let moveX = 0;
    let moveY = 0;
    let action = 0;

    if (arcadeKeyState.has('arrowleft')) moveX = -1;
    if (arcadeKeyState.has('arrowright')) moveX = 1;
    if (arcadeKeyState.has('arrowup')) moveY = -1;
    if (arcadeKeyState.has('arrowdown')) moveY = 1;

    if (arcadeKeyState.has(' ')) action = 1;
    if (arcadeKeyState.has('shift')) action |= 2;

    socket.emit('arcade:input', {
        gameMode: currentGameMode,
        moveX,
        moveY,
        action
    });
}

function handleArcadeTouchStart(e) {
    if (!currentGameMode) return;
    const touch = e.touches[0];
    arcadeTouchStart = { x: touch.clientX, y: touch.clientY };
}

function handleArcadeTouchMove(e) {
    if (!currentGameMode || !arcadeTouchStart) return;
    e.preventDefault();
}

function handleArcadeTouchEnd(e, socket) {
    if (!currentGameMode || !arcadeTouchStart || !socket) return;

    const touch = e.changedTouches[0];
    const dx = touch.clientX - arcadeTouchStart.x;
    const dy = touch.clientY - arcadeTouchStart.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 20) {
        socket.emit('arcade:input', {
            gameMode: currentGameMode,
            moveX: 0,
            moveY: 0,
            action: 1
        });
    } else if (distance > 50) {
        const angle = Math.atan2(dy, dx);
        let moveX = 0;
        let moveY = 0;

        if (Math.abs(angle) < Math.PI / 4) {
            moveX = 1;
        } else if (Math.abs(angle) > (3 * Math.PI) / 4) {
            moveX = -1;
        } else if (angle > 0) {
            moveY = 1;
        } else {
            moveY = -1;
        }

        socket.emit('arcade:input', {
            gameMode: currentGameMode,
            moveX,
            moveY,
            action: 0
        });
    }

    arcadeTouchStart = null;
}

function startArcadeGameRenderLoop() {
    function loop() {
        renderArcadeGame();
        updateGameScorePanel();

        if (gameState.isRunning) {
            gameRenderLoopId = requestAnimationFrame(loop);
        }
    }

    if (gameRenderLoopId) cancelAnimationFrame(gameRenderLoopId);
    gameRenderLoopId = requestAnimationFrame(loop);
}
