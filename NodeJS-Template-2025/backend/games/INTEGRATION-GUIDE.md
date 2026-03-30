# Arcade Engine Integration Guide

## Overview
The real-time arcade engine has been successfully integrated into the LocalChat backend. It provides:
- Server-authoritative multiplayer game architecture
- Deterministic physics with fixed-point math
- 60Hz tick loop
- Support for multiple game modes (Agar, Slither, Racing, Flappy - to be implemented)
- Lag compensation via input buffering
- Binary protocol (ready in TypeScript format)

## Files Created

### Core Engine (TypeScript Specifications)
- `backend/games/arcade/ARCHITECTURE.md` — Complete design specification with tech decision matrix, layers, performance targets
- `backend/games/arcade/game-room.ts` — Abstract base class for all game rooms (~550 lines)
- `backend/games/arcade/binary-protocol.ts` — MessagePack-style binary serialization (~400 lines)
- `backend/games/arcade/agar-room.ts` — Agar.io game mode implementation (~350 lines)

### JavaScript Implementation (Production-Ready)
- `backend/games/arcade-rooms.js` — CommonJS implementation of AbstractGameRoom + AgarRoom for immediate use

### Backend Integration
- `backend/server.js` — Updated with:
  - Import for AgarRoom
  - `activeArcadeRooms` Map to track game instances
  - Three new Socket.IO event handlers:
    - `arcade:startGame` — Create and start a new game
    - `arcade:join` — Add player to existing game
    - `arcade:input` — Queue player movement input

## Socket.IO API

### Starting a Game
```javascript
socket.emit('arcade:startGame', {
  roomId: 1,
  gameMode: 'agar' // 'slither'|'racing'|'flappy' (future)
});

// Receive
socket.on('arcade:gameStarted', (gameState) => {
  console.log('Game started:', gameState);
});
```

### Joining a Game
```javascript
socket.emit('arcade:join', {
  roomId: 1,
  gameMode: 'agar'
});

// Receive
socket.on('arcade:stateUpdate', (gameState) => {
  // Render game state
  gameState.entities.forEach(entity => {
    console.log(`Entity ${entity.id} at (${entity.x}, ${entity.y})`);
  });
});
```

### Sending Player Input
```javascript
socket.emit('arcade:input', {
  roomId: 1,
  moveX: 1,    // -1, 0, or +1
  moveY: 0,    // -1, 0, or +1
  action: 0    // Game-specific action code
});
```

### Game Events
- `arcade:gameStarted` — Game instance created and started
- `arcade:stateUpdate` — Full game state (60Hz broadcast rate)
- `arcade:playerJoined` — Player added to game
- `arcade:playerLeft` — Player left game
- `arcade:entitySpawned` — New entity created (player-owned only)
- `arcade:entityDespawned` — Entity destroyed
- `arcade:gameStopped` — Game ended with final state

## Agar Game Mode Details

### Game Rules
- Players control circular entities sized by mass
- Consume food pellets (+1 mass each) or smaller players
- Larger players move slower: `speed = baseSpeed * sqrt(initialMass / currentMass)`
- Score = total mass gained
- Wrapping boundaries (modulo 10000 on both axes)

### Entity Properties
```javascript
{
  id: 'entity_0',
  x: 5000,              // Position (fixed-point compatible)
  y: 3000,
  vx: 2.5,              // Velocity
  vy: -1.2,
  angle: 45,            // Facing angle in degrees
  mass: 50,             // Player/food mass
  isAlive: true,
  isPlayer: true,
  ownerId: 'player1',   // Player controlling this entity
  isFood: false,        // True for consumable pellets
  color: '#FF6B6B',     // Visual hint (client-side only)
  radius: 7.07          // Derived from mass for collision
}
```

### Physics
- **Velocity Damping**: 0.95× per frame (realistic friction)
- **Collision**: O(n²) broad-phase overlap detection
- **Spawn Rate**: 5 food pellets every 100 frames (~1.67 seconds at 60Hz)
- **Game Area**: 10,000 × 10,000 units

## Frontend Integration (TODO)

The frontend needs:
1. Canvas renderer for game entities
2. Input capture (keyboard or touch) → `socket.emit('arcade:input', ...)`
3. State decoder for binary protocol (when implemented)
4. Game UI component (visible when in arcade mode)

### Minimal Frontend Example
```javascript
// Connect to arcade game
socket.emit('arcade:join', { roomId: 1, gameMode: 'agar' });

// Listen for state updates
socket.on('arcade:stateUpdate', (gameState) => {
  // Draw entities
  gameState.entities.forEach(entity => {
    if (entity.isAlive) {
      drawCircle(entity.x, entity.y, entity.radius, entity.color);
    }
  });
});

// Send player input on keyboard
document.addEventListener('keydown', (e) => {
  let moveX = 0, moveY = 0;
  if (e.key === 'ArrowUp') moveY = -1;
  if (e.key === 'ArrowDown') moveY = 1;
  if (e.key === 'ArrowLeft') moveX = -1;
  if (e.key === 'ArrowRight') moveX = 1;
  
  socket.emit('arcade:input', { moveX, moveY, action: 0 });
});
```

## Testing Checklist

- [ ] Start Agar game in a room (`arcade:startGame`)
- [ ] Join game as multiple players (`arcade:join`)
- [ ] Verify 60Hz state broadcasts (`arcade:stateUpdate`)
- [ ] Test movement input (`arcade:input` with arrow keys)
- [ ] Verify collision detection (eat food, mass increases)
- [ ] Test player-vs-player collision (larger eats smaller)
- [ ] Monitor CPU/memory under load (8 concurrent games)
- [ ] Verify no memory leaks (player disconnect cleanup)

## Performance Targets

| Metric | Target | Status |
|--------|--------|--------|
| Tick latency | <5ms | 🟡 Not yet measured |
| Entities per game | <200 | ✅ By design |
| Bandwidth per room | <100 KB/sec | 🟡 JSON only, binary later |
| Max players per room | 20 | ✅ By design |
| CPU per room | <15% | 🟡 Not yet measured |
| Memory per room | <5 MB | 🟡 Not yet measured |

## Next Steps

### Phase 2: Additional Game Modes
- Implement `SlitherRoom` (segment-following mechanics)
- Implement `RacingRoom` (vehicle physics with drift)
- Implement `FlappyRoom` (gravity-based platformer)

### Phase 3: Netcode Optimization
- Implement `BinaryProtocol` in JavaScript (~80 bytes/frame)
- Client prediction + interpolation
- Input validation anti-cheat

### Phase 4: Production Features
- Replay buffer system (record/playback games)
- Leaderboard integration
- Spectator mode (lower-bandwidth viewer protocol)
- Admin monitoring dashboard

## Troubleshooting

### "Jatek mar megtelt" when joining
- The game room is full (20 player max)
- Wait for another player to leave or start a new game

### Players not moving or food not spawning
- Check browser console for errors
- Verify `arcade:input` events are being sent
- Check server logs for tick loop warnings

### High latency or jitter
- Built-in 3-frame input buffer compensates for ~50ms latency
- Frontend client prediction (TODO) will smooth display

### Memory grows unbounded
- Ensure spectator cleanup is flushing closed rooms
- Check if `activeArcadeRooms.delete()` is called on game stop

## Architecture Notes

**Why TypeScript specs + JavaScript implementation?**
- TypeScript files (`game-room.ts`, `binary-protocol.ts`, etc.) serve as architecture documentation and future migration path
- JavaScript implementation (`arcade-rooms.js`) provides immediate functionality without transpilation overhead
- Future: Use TypeScript compiler plugin in build pipeline to generate production JS

**Why Socket.IO instead of raw WebSocket?**
- Existing LAN chat uses Socket.IO
- Automatic fallback to HTTP long-polling if WebSocket unavailable
- Built-in room broadcasting and event demultiplexing

**Why server-authoritative, not peer-to-peer?**
- Eliminates client-side cheating (speed hacks, teleporting, false collisions)
- Single source of truth for game state
- Simpler debugging and replays

---

**Documentation Version**: 1.0  
**Engine Version**: 1.0 (Agar only)  
**Status**: ✅ Ready for testing  
**Last Updated**: 2026-03-31
