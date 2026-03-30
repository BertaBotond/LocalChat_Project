# Universal High-Performance Real-Time Arcade Engine

## 1. Executive Summary

**LocalChat Arcade Engine** is a production-ready, server-authoritative multiplayer game engine designed for LAN environments. It enables deterministic, low-latency arcade games (Agar.io, Slither.io, Racing, Flappy Bird variants) with built-in anti-cheat, lag compensation, and horizontal scaling.

### Core Design Philosophy
- **Server-Authoritative**: Client never trusted for game logic; only inputs are consumed
- **Deterministic Physics**: Fixed-point math (int32 × 0.001) ensures replay consistency
- **Bandwidth-Efficient**: Binary protocol reduces payload 4-5x vs JSON (~50 bytes/frame)
- **Lag-Tolerant**: Input buffering (3-frame window) + client prediction + interpolation
- **Scalable**: Handles 20 players/room, 8-12 concurrent rooms/server (~1GB RAM)

---

## 2. Technology Decision Matrix

| Component | Choice | Rationale | Version |
|-----------|--------|-----------|---------|
| **Runtime** | Node.js | Existing LAN chat already Node.js-based; FFI for Bun | 18.x+ |
| **Physics Engine** | Custom Deterministic 2D | Fixed-point math (no floats) ensures replay consistency | Custom |
| **Netcode Model** | Server-Authoritative | Eliminates client-side cheating; trades latency for security | — |
| **Serialization** | Binary (MessagePack-style) | 80 bytes/frame vs 400 bytes JSON | Custom |
| **Tick Rate** | 60Hz | 16.67ms per frame; balances responsiveness vs bandwidth | — |
| **Room Capacity** | 20 players max | Empirically safe for O(n²) collision detection | — |
| **Lag Buffer** | 3 frames | +50ms network jitter tolerance | — |
| **Spatial Index** | Quadtree (future) | O(log n) collision detection for >50 entities | — |

---

## 3. Architecture Layers

### Layer 1: Room Management
- `GameRoomManager`: Registry of active game instances
- Validates room capacity, game mode, player access
- Broadcasts state updates to room subscribers

### Layer 2: Abstract Game Room (`AbstractGameRoom`)
**Base class for all game modes.** Provides:
- 60Hz tick loop with deterministic frame stepping
- Input queue buffer (lag compensation)
- Entity lifecycle management (spawn, despawn, update)
- Delta-state serialization (only changed entities)
- Event emission (playerJoined, playerLeft, entitySpawned, etc.)

### Layer 3: Game Mode Implementations
**Concrete subclasses override physics and input handling:**
- `AgarRoom`: Food collection, mass-based sizing, overlap detection
- `SlitherRoom`: Segment following, tail growth, head collision
- `RacingRoom`: Vehicle dynamics (acceleration, friction, steering)
- `FlappyRoom`: Gravity platformer with obstacle generation

### Layer 4: Netcode Middleware
- `BinaryProtocol`: State update encoding/decoding (fixed-point, varint)
- Input queue processing (drain buffer each frame)
- Lag compensation interpolation (client-side smoothing)

### Layer 5: Physics Kernel (Pluggable)
- **Deterministic 2D**: Position update, velocity damping, collision detection
- **Trajectory**: Angle-based movement (sin/cos lookup table)
- **Collision**: O(n²) broad-phase (will use Quadtree for scaling)

---

## 4. Performance Constraints

### Bandwidth Budget
- **State Update**: 80 bytes/frame max
  - Header (1B) + Tick (4B) + NumEntities (1B) + 4 entities × 20B each
  - At 60Hz: 80 × 60 = 4.8 KB/sec per player
  - 20 players: ~100 KB/sec broadcast (acceptable for LAN)

- **Input**: 12 bytes/frame per player
  - Header (1B) + Tick (4B) + MoveX (1B) + MoveY (1B) + Action (1B) + Timestamp (4B)
  - 20 players: 12 × 20 × 60 = 14.4 KB/sec upstream

### Memory Budget
- Per game instance: ~2-5 MB (20 players × 200 entities × 64 bytes)
- Per server (8-12 concurrent rooms): ~20-60 MB game state
- Node.js baseline: ~100 MB, total target: <1 GB

### CPU Budget
- **Per tick**: O(n²) collision detection (n=entities, per room)
  - 20 players × 10 entities each = 200 entities = ~40k comparisons
  - At 60Hz: 2.4M comparisons/sec (acceptable)
- **Per second**: 8-12 room ticks × 60Hz + message broadcasting
  - Profiling target: <20% single-core CPU utilization

### Latency Budget
- Server tick: 5ms (with 11.67ms headroom)
- Network RTT: 5-10ms (LAN typical)
- Client prediction buffer: 50ms (3 frames)
- Total perceived latency: ~20ms (imperceptible to human reaction)

---

## 5. Optimization Tactics

### Binary Serialization
```
State Update:
[0xAA]     Header magic byte
[4 bytes]  Tick number (u32)
[1 byte]   Num entities
[N × bytes] Entity snapshots:
  [2]  ID (u16)
  [4]  X fixed-point (int32 × 0.001)
  [4]  Y fixed-point (int32 × 0.001)
  [1]  Vx clamped (-100 to 100 → int8)
  [1]  Vy clamped
  [1]  Angle (0-360° → uint8 quantized to 1.4°)
  [1]  Flags (alive, isPlayer, isFood)
  [2]  Score (u16)
  = 20 bytes per entity
```

### Input Queue Buffering
- Client sends input every frame (even if no change)
- Server queues last 3 frames of input
- Process queue each tick → smooth gameplay despite jitter
- Garbage-collect old frames after server processes them

### Client Prediction
- Client applies own input immediately (optimistic)
- Renders predicted position + velocity trend
- Server correction arrives ~20ms later
- Lerp over 2 frames to smooth correction (imperceptible)

### Fixed-Point Math
- All coordinates stored as `int32` (range: ±2.1B units)
- Scale: 1000x real value (0.001 precision)
- Addition/subtraction native; multiplication/division need rounding: `Math.round(a * b / 1000)`
- Eliminates floating-point precision errors across 60 GHz of ticks

---

## 6. File Structure

```
backend/games/arcade/
├── ARCHITECTURE.md           # This file
├── game-room.ts              # AbstractGameRoom base class
├── binary-protocol.ts        # MessagePack-style encoder/decoder
├── room-manager.ts           # GameRoomManager singleton
├── game-modes/
│   ├── agar-room.ts          # Agar.io game mode
│   ├── slither-room.ts       # Slither.io game mode
│   ├── racing-room.ts        # Racing game mode
│   └── flappy-room.ts        # Flappy Bird variant
├── physics/
│   ├── deterministic-2d.ts   # Fixed-point physics engine
│   └── collision-detector.ts # O(n²) and O(log n) implementations
└── tests/
    ├── determinism.test.ts   # Verify replay consistency
    ├── bandwidth.test.ts     # Measure bytes/frame
    └── load-test.test.ts     # 20 players × 8 rooms
```

---

## 7. Roadmap

### Phase 1: Foundation (Week 1-2)
- ✅ Implement `AbstractGameRoom` base class
- ✅ Implement `BinaryProtocol` serializer
- ✅ Implement `AgarRoom` concrete game mode
- ✅ Integrate Socket.IO event handlers (`arcade:startGame`, `arcade:input`, `arcade:join`)
- ✅ Frontend canvas renderer stub
- **Testing**: Determinism check (same inputs → same output replay)

### Phase 2: Additional Game Modes (Week 3)
- Implement `SlitherRoom` (segment following physics)
- Implement `RacingRoom` (vehicle dynamics)
- Implement `FlappyRoom` (gravity platformer)
- Validate physics plugins work with base layer

### Phase 3: Netcode Hardening (Week 4)
- Client prediction + interpolation
- Lag compensation validation (server rubber-banding)
- Input rate limiting (prevent spam)
- Spectator mode (lower-bandwidth viewer protocol)

### Phase 4: Production Features (Week 5+)
- Replay buffer system (circular recording)
- Leaderboard integration (Redis Sorted Sets)
- Admin monitoring panel (`/admin` with tick rates, bandwidth metrics)
- Load balancing (room distribution across servers)
- Quadtree spatial partitioning (O(log n) collision)

---

## 8. Critical Success Factors

### Determinism Requirement
**Problem**: Floating-point arithmetic is non-deterministic across platforms.
**Solution**: Use fixed-point math (int32 × 1000) exclusively.
**Validation**: Record inputs, replay on different machine, compare entity positions byte-for-byte.

### Server Authoritarianism
**Problem**: Client can forge entities, modify speed, teleport.
**Solution**: Server validates every input before applying.
- Check acceleration is within speed limit
- Check position delta matches velocity
- Detect impossible movements (teleporting >100 units/frame)
- **Action**: Reject invalid input, emit corrective update to client (rubber-band)

### Lag Compensation Balance
**Problem**: High-ping clients experience 150-200ms latency; input feels sluggish.
**Solution**: Client prediction buffer (optimistic update) + server correction.
- Client: Apply input immediately, render predicted position
- Server: Validates input 50-100ms later, sends correction
- Client: Interpolate to server position over 2 frames (imperceptible)

### Network Efficiency
**Problem**: Naive JSON encoding = 400 bytes/frame; at 60Hz for 20 players = 480 MB/hour.
**Solution**: Binary protocol = 80 bytes/frame; 4.8 MB/hour per room.
**Validation**: Bandwidth test (actual bytes vs theoretical)

### Collision Accuracy
**Problem**: O(n²) collision checks = 40k comparisons per frame for 200 entities.
**Solution**: Implement Quadtree spatial partitioning for future scaling.
- Current: O(n²) acceptable for <200 entities
- Future: Quadtree O(n log n) for >500 entities
- Validation: Load test with 8 concurrent rooms, monitor CPU %

---

## 9. Integration Points

### Socket.IO Events (Server)

```javascript
socket.on('arcade:startGame', async (payload) => {
  // payload: { roomId, gameMode ('agar'|'slither'|'racing'|'flappy') }
  // Create new game instance, start tick loop
});

socket.on('arcade:join', async (payload) => {
  // payload: { roomId, username }
  // Add player to existing game instance
});

socket.on('arcade:input', (payload) => {
  // payload: { roomId, moveX, moveY, action, timestamp }
  // Queue input for lag compensation processing
});

// Broadcast (server → all clients in room)
io.to(`room:${roomId}`).emit('arcade:stateUpdate', encodedStateBuffer);
```

### Frontend Integration

```javascript
// Decode state update
const stateUpdate = BinaryProtocol.decodeStateUpdate(encodedBuffer);
// Render entities to canvas
renderGameState(stateUpdate);
// Capture input, send to server
window.addEventListener('keydown', (e) => {
  const {moveX, moveY} = parseInput(e.key);
  socket.emit('arcade:input', { roomId, moveX, moveY, action: 0 });
});
```

---

## 10. Known Challenges & Mitigations

| Challenge | Mitigation | Status |
|-----------|-----------|--------|
| Floating-point non-determinism | Fixed-point math (int32 × 1000) | ✅ Designed |
| Client-side cheating | Server validates every move | ✅ Designed |
| Lag-induced input delay | Client prediction + interpolation | ✅ Designed |
| Bandwidth explosion | Binary protocol (80 bytes/frame) | ✅ Designed |
| O(n²) collision scaling | Quadtree spatial index (future) | 🟡 Planned |
| Tick loop precision | setInterval 60Hz (native) | ⚠️ Platform-dependent |
| Network jitter | Input queue buffer (3 frames) | ✅ Designed |
| Room state divergence | Full state broadcast every 10 ticks | ✅ Designed |

---

## 11. Quick Start (Implementation Order)

1. **Create** `game-room.ts` — Base class for all game modes
2. **Create** `binary-protocol.ts` — Serialization layer
3. **Create** `agar-room.ts` — First concrete game mode
4. **Update** `server.js` — Add Socket.IO event handlers
5. **Create** `room-manager.ts` — Game instance registry
6. **Test** determinism — Record/replay test suite
7. **Benchmark** — Bandwidth, CPU, memory under load

---

## 12. Performance Targets

- **Tick latency**: <5ms (Goal: <2ms)
- **Network RTT**: <20ms (LAN typical: 5-10ms)
- **Perceived latency**: <50ms (imperceptible)
- **Bandwidth**: <100 KB/sec per room (20 players)
- **CPU utilization**: <20% single core
- **Memory per room**: <5 MB
- **Max players per room**: 20
- **Max concurrent rooms**: 8-12 per server

---

**Version**: 1.0  
**Last Updated**: Q1 2026  
**Author**: LocalChat Arcade Engine Team
