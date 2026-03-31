# Game Modes Reference

## Overview

Four arcade game modes are now fully implemented and production-ready. Each has unique physics, gameplay mechanics, and scoring systems.

---

## 1. Agar (Agar.io-style)

### Game Rules
- Players control circular entities that grow by consuming food
- Larger entities move slower (inverse mass scaling)
- Larger players can consume smaller players/food
- Score = total mass gained

### Physics
- **Frictionless space** with velocity dampening (0.95× per frame)
- **O(n²) collision detection**
- **Mass scaling**: Speed = base × sqrt(initialMass / currentMass)
- **Boundaries**: Wrapping (modulo 10,000)

### Scoring
- 1 point per unit mass consumed
- Unlimited mass growth

### Input
```javascript
socket.emit('arcade:input', { moveX: 1, moveY: 0 }); // -1 to +1 for direction
```

### Game Area
- Default: 10,000 × 10,000 units
- Spawn locations: Random

### Configuration
```javascript
const config = {
  gameAreaWidth: 10000,
  gameAreaHeight: 10000,
  foodSpawnInterval: 100,        // Frames between spawns
  foodPerSpawn: 5,               // Food spawned each interval
  initialMass: 50,               // Player starting mass
  foodMass: 1                    // Food pellet mass
};
```

---

## 2. Slither (Slither.io-style)

### Game Rules
- Players control snakes made of segments
- Snakes move forward continuously in current heading
- Consume food to grow (+1 segment per food)
- Head collision with another snake's body = death
- Head-to-boundary collision = respawn (after 2s)
- Score = food consumed (segments grown)

### Physics
- **Constant forward velocity** (snakeSpeed = 3.5 units/frame)
- **Segment following**: Each segment chases previous segment
- **Smooth heading transition**: Lerp to target angle (0.1 lerp factor)
- **Boundaries**: Wrapping with respawn delay

### Scoring
- 1 point per food pellet consumed
- Equal to segment count - initialSegments

### Input
```javascript
socket.emit('arcade:input', { moveX: 1, moveY: 0 }); // Direction to face
// Snake automatically moves forward, facing direction set by input
```

### Segment Tracking
- Head position updates in real-time
- Segments follow fixed path calculated per frame
- Segment spacing: 2 units (configurable)

### Configuration
```javascript
const config = {
  gameAreaWidth: 10000,
  gameAreaHeight: 10000,
  snakeSpeed: 3.5,              // Units per frame
  foodSpawnInterval: 80,        // ~1.33 seconds at 60Hz
  foodPerSpawn: 8,
  initialSegments: 3,           // Starting snake length
  segmentSpacing: 2             // Distance between segments
};
```

---

## 3. Racing (Racing/Driving Game)

### Game Rules
- Players control vehicles with realistic physics
- Drive through checkpoints for speed boosts and points
- Vehicle-to-vehicle collisions bounce apart
- Collect checkpoints for scoring
- Wrapping boundaries

### Physics
- **Acceleration**: Up to max speed over time
- **Steering**: Max turning angle (30° default)
- **Friction/damping**: 0.98× per frame
- **Collision**: Elastic bouncing between vehicles
- **Drift mode**: Reduced friction when turning + accelerating (toggle via action input)

### Scoring
- 10 points per checkpoint collected
- Checkpoint respawn: Every 2 seconds

### Input
```javascript
socket.emit('arcade:input', {
  moveX: -1,  // +1 = turn right, -1 = turn left
  moveY: 1,   // +1 = accelerate, -1 = brake/reverse
  action: 1   // > 0 for drift mode
});
```

### Gameplay Features
- **Speed boost**: 20% velocity increase on checkpoint collection
- **Terminal velocity**: Clamped at max speed
- **Elastic bouncing**: Realistic vehicle collisions
- **Drift mode**: Indicator for skill-based turning (implementation ready)

### Configuration
```javascript
const config = {
  gameAreaWidth: 10000,
  gameAreaHeight: 10000,
  vehicleMaxSpeed: 5.0,          // Top speed
  vehicleAcceleration: 0.15,     // Units/frame² per frame
  vehicleFriction: 0.98,         // Damping
  vehicleMaxSteeringAngle: 30,   // Degrees
  checkpointSpawnInterval: 120,  // Every 2 seconds
  checkpointsPerSpawn: 3
};
```

---

## 4. Flappy (Gravity-based Platformer)

### Game Rules
- Players control character with gravity-based physics
- Jump to dodge falling obstacles
- Obstacles spawn at right edge, move left
- Hit obstacle or boundary = damage
- 3 lives default; game over when all lives lost
- Score = distance traveled (1 point per 100 units)

### Physics
- **Gravity acceleration**: 0.3 units/frame² downward
- **Jump impulse**: -7.0 upward velocity on action
- **Terminal velocity**: 15 units/frame (clamped)
- **Constant forward scroll**: 2.0 units/frame baseline
- **Difficulty scaling**: Obstacle speed increases 0.1% per frame

### Scoring
- 1 point per 100 units traveled
- Obstacles spawn every 1.5 seconds
- Invincibility frames: 120 (2 seconds) after damage

### Input
```javascript
socket.emit('arcade:input', { action: 1 }); // > 0 to jump
// moveX could adjust trajectory (optional enhancement)
```

### Gameplay Features
- **Lives system**: 3 HP default
- **Invincibility frames**: 2-second protection after hit
- **Difficulty ramping**: Speed increases linearly over time
- **Obstacle types**: Pipes, spikes (configurable)
- **Screen wrapping**: Obstacles clean up after leaving screen

### Configuration
```javascript
const config = {
  gameAreaWidth: 10000,
  gameAreaHeight: 8000,          // Shorter than other modes
  playerGravity: 0.3,            // Acceleration downward
  playerJumpForce: 7.0,          // Upward impulse
  playerMaxVerticalVelocity: 15,
  initialLives: 3,
  obstacleSpawnRate: 90,         // Every 1.5 seconds
  obstacleTypes: ['pipe', 'spike'],
  difficultyScaling: 0.001        // 0.1% speed increase per frame
};
```

---

## Server-Side Game Creation

### Creating a Game Room

```javascript
// Client sends:
socket.emit('arcade:startGame', {
  roomId: 1,
  gameMode: 'agar'  // 'agar', 'slither', 'racing', 'flappy'
});
```

### Backend Factory

The server automatically instantiates the correct game mode:

```javascript
// In server.js, arcade:startGame handler:
if (gameMode === 'agar') {
  gameRoom = new AgarRoom(gameRoomKey, config);
} else if (gameMode === 'slither') {
  gameRoom = new SlitherRoom(gameRoomKey, config);
} else if (gameMode === 'racing') {
  gameRoom = new RacingRoom(gameRoomKey, config);
} else if (gameMode === 'flappy') {
  gameRoom = new FlappyRoom(gameRoomKey, config);
}
```

---

## Comparative Physics Table

| Mechanic | Agar | Slither | Racing | Flappy |
|----------|------|---------|--------|--------|
| Movement Type | Velocity-based | Heading-based auto | Vehicle physics | Gravity-based |
| Forward Control | Free (all directions) | Automatic + heading | Acceleration | Automatic |
| Turning | Immediate | Smooth lerp (0.1) | Steering angle (30°) | N/A |
| Damping | 0.95× per frame | Position-following | 0.98× per frame | Gravity only |
| Collision | Consumption | Death/respawn | Bouncing | Damage/invincible |
| Scoring | Mass gained | Food eaten | Checkpoints | Distance |
| Lives | Unlimited | Unlimited* | N/A | 3 |
| Growth | Mass | Segments | N/A | N/A |

*Slither respawns after 2-second delay; can be modified to true death

---

## Event Broadcasting

All game modes emit these Socket.IO events:

```javascript
// Lifecycle
'arcade:gameStarted'       // Game created, first state
'arcade:stateUpdate'       // 60Hz state broadcast
'arcade:gameStopped'       // Game ended, final state

// Player events
'arcade:playerJoined'      // New player added
'arcade:playerLeft'        // Player disconnected
'arcade:playerDeath'       // Player died (Slither/Flappy)

// Entity events
'arcade:entitySpawned'     // New entity created (player-owned)
'arcade:entityDespawned'   // Entity removed (collision/off-screen)
'arcade:gameOver'          // All players dead (Flappy)
```

---

## Performance Targets by Mode

| Mode | Max Entities | O(n²) Safe Limit | Latency Target | Bandwidth (bytes/frame) |
|------|--------------|------------------|----------------|--------------------------|
| Agar | 200 | 40k comparisons | <5ms | ~400 JSON, 80 binary |
| Slither | 150 | 20k comparisons | <5ms | ~350 JSON, 70 binary |
| Racing | 100 | 10k comparisons | <5ms | ~300 JSON, 60 binary |
| Flappy | 50 | 2.5k comparisons | <5ms | ~250 JSON, 50 binary |

---

## Frontend Integration Example

### Minimal Arcade Game UI

```javascript
// Join Agar game
socket.emit('arcade:startGame', { roomId: 1, gameMode: 'agar' });

// Listen for state updates
socket.on('arcade:stateUpdate', (gameState) => {
  // gameState.entities = array of all entities including food and players
  // gameState.players = array of players with scores
  
  // Render on canvas
  gameState.entities.forEach(entity => {
    if (entity.isAlive) {
      if (entity.isFood) {
        drawCircle(entity.x, entity.y, 1, entity.color);
      } else if (entity.isPlayer) {
        // Agar: draw by mass
        // Slither: draw segments
        // Racing: draw vehicle
        // Flappy: draw character
      }
    }
  });
});

// Send input on keyboard/touch
let moveX = 0, moveY = 0;
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp') moveY = -1;
  if (e.key === 'ArrowDown') moveY = 1;
  if (e.key === 'ArrowLeft') moveX = -1;
  if (e.key === 'ArrowRight') moveX = 1;
  socket.emit('arcade:input', { moveX, moveY, action: 0 });
});
```

---

## Configuration Presets

### Casual Settings
```javascript
// Slower, more forgiving gameplay
{ foodSpawnInterval: 150, snakeSpeed: 2.5, difficultyScaling: 0.0005 }
```

### Competitive Settings
```javascript
// Faster, harder obstacles
{ foodSpawnInterval: 60, snakeSpeed: 5.0, difficultyScaling: 0.002 }
```

### Sandbox Settings
```javascript
// Unlimited lives, no pressure
{ initialLives: 999, difficultyScaling: 0 }
```

---

**Version**: 1.0  
**Games**: 4 fully implemented  
**Status**: Production-ready  
**Total Lines**: ~2,200 (arcade-rooms.js) + ~1,500 (TypeScript specs)
