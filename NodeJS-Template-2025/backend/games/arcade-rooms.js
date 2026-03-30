/**
 * Arcade Room Manager - JavaScript implementation for real-time multiplayer games
 * Bridges TypeScript architecture to CommonJS Node.js
 */

class AbstractGameRoom {
  constructor(roomId, gameType, config = {}) {
    this.roomId = roomId;
    this.gameType = gameType;
    this.config = {
      maxPlayers: 20,
      tickRate: 60,
      inputBufferSize: 3,
      ...config
    };

    this.players = new Map();
    this.entities = new Map();
    this.inputQueue = new Map();
    this.currentTick = 0;
    this.isRunning = false;
    this.tickIntervalHandle = null;
    this.entityIdCounter = 0;
    this.lastDeltaTick = 0;
    this.eventListeners = new Map();
  }

  on(eventName, callback) {
    if (!this.eventListeners.has(eventName)) {
      this.eventListeners.set(eventName, []);
    }
    this.eventListeners.get(eventName).push(callback);
  }

  emit(eventName, data) {
    const callbacks = this.eventListeners.get(eventName) || [];
    callbacks.forEach(cb => {
      try {
        cb(data);
      } catch (err) {
        console.error(`Event error: ${eventName}`, err);
      }
    });
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.currentTick = 0;
    this.emit('started');

    const tickInterval = 1000 / (this.config.tickRate || 60);
    this.tickIntervalHandle = setInterval(() => this.tickCycle(), tickInterval);
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.tickIntervalHandle) {
      clearInterval(this.tickIntervalHandle);
      this.tickIntervalHandle = null;
    }
    this.emit('stopped');
  }

  async tickCycle() {
    try {
      this.processInputQueue();
      await this.tick();
      this.currentTick++;
    } catch (error) {
      console.error(`Tick error in room ${this.roomId}:`, error);
      this.emit('tickError', error);
    }
  }

  async tick() {
    // Override in subclass
  }

  onPlayerInput(playerId, inputFrame) {
    // Override in subclass
  }

  addPlayer(playerId, username) {
    if (this.players.size >= (this.config.maxPlayers || 20)) {
      return false;
    }
    if (this.players.has(playerId)) {
      return false;
    }

    const player = {
      id: playerId,
      username,
      joinedAt: Date.now(),
      score: 0
    };
    this.players.set(playerId, player);
    this.inputQueue.set(playerId, []);
    this.emit('playerJoined', { playerId, username });
    return true;
  }

  removePlayer(playerId) {
    if (!this.players.has(playerId)) return;

    this.players.delete(playerId);
    this.inputQueue.delete(playerId);

    for (const [entityId, entity] of this.entities.entries()) {
      if (entity.ownerId === playerId) {
        entity.isAlive = false;
        this.emit('entityDespawned', { entityId, playerId });
      }
    }

    this.emit('playerLeft', { playerId });
  }

  getPlayer(playerId) {
    return this.players.get(playerId);
  }

  getPlayers() {
    return Array.from(this.players.values());
  }

  spawnEntity(entity) {
    const newEntity = {
      id: `entity_${this.entityIdCounter++}`,
      x: entity.x || 0,
      y: entity.y || 0,
      vx: entity.vx || 0,
      vy: entity.vy || 0,
      angle: entity.angle || 0,
      isAlive: true,
      isPlayer: entity.isPlayer || false,
      ownerId: entity.ownerId,
      ...entity
    };
    this.entities.set(newEntity.id, newEntity);
    this.emit('entitySpawned', { entityId: newEntity.id, entity: newEntity });
    return newEntity;
  }

  despawnEntity(entityId) {
    const entity = this.entities.get(entityId);
    if (entity) {
      entity.isAlive = false;
      this.entities.delete(entityId);
      this.emit('entityDespawned', { entityId });
    }
  }

  getEntity(entityId) {
    return this.entities.get(entityId);
  }

  getEntities() {
    return Array.from(this.entities.values());
  }

  queueInput(playerId, inputFrame) {
    const queue = this.inputQueue.get(playerId);
    if (!queue) return;

    const maxBufferSize = this.config.inputBufferSize || 3;
    if (queue.length >= maxBufferSize) {
      queue.shift();
    }
    queue.push(inputFrame);
  }

  processInputQueue() {
    for (const [playerId, queue] of this.inputQueue.entries()) {
      for (const inputFrame of queue) {
        this.onPlayerInput(playerId, inputFrame);
      }
      queue.length = 0;
    }
  }

  getState() {
    return {
      roomId: this.roomId,
      gameType: this.gameType,
      currentTick: this.currentTick,
      isRunning: this.isRunning,
      players: Array.from(this.players.values()),
      entities: Array.from(this.entities.values()),
      playerCount: this.players.size
    };
  }

  getDeltaState(lastSeenTick) {
    const shouldFullRefresh = (this.currentTick - lastSeenTick) % 10 === 0;

    if (shouldFullRefresh || lastSeenTick === 0) {
      return {
        tick: this.currentTick,
        type: 'full',
        entities: Array.from(this.entities.values()),
        players: Array.from(this.players.values())
      };
    }

    return {
      tick: this.currentTick,
      type: 'delta',
      entities: Array.from(this.entities.values()),
      playerCount: this.players.size
    };
  }

  getRoomId() {
    return this.roomId;
  }

  getGameType() {
    return this.gameType;
  }

  getPlayerCount() {
    return this.players.size;
  }

  isGameRunning() {
    return this.isRunning;
  }

  getCurrentTick() {
    return this.currentTick;
  }

  distance(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }

  checkCollision(entity1, radius1, entity2, radius2) {
    const dist = this.distance(entity1.x, entity1.y, entity2.x, entity2.y);
    return dist < radius1 + radius2;
  }

  clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
}

class AgarRoom extends AbstractGameRoom {
  constructor(roomId, config = {}) {
    super(roomId, 'agar', {
      maxPlayers: config.maxPlayers || 20,
      tickRate: 60,
      inputBufferSize: 3,
      ...config
    });

    this.gameAreaWidth = config.gameAreaWidth || 10000;
    this.gameAreaHeight = config.gameAreaHeight || 10000;
    this.foodSpawnInterval = config.foodSpawnInterval || 100;
    this.foodPerSpawn = config.foodPerSpawn || 5;
    this.initialMass = config.initialMass || 50;
    this.foodMass = config.foodMass || 1;
    this.lastFoodSpawn = 0;
  }

  addPlayer(playerId, username) {
    const added = super.addPlayer(playerId, username);
    if (!added) return false;

    const x = Math.random() * this.gameAreaWidth;
    const y = Math.random() * this.gameAreaHeight;

    const playerEntity = this.spawnEntity({
      x,
      y,
      vx: 0,
      vy: 0,
      angle: 0,
      isPlayer: true,
      ownerId: playerId,
      mass: this.initialMass,
      color: this.getRandomColor(),
      isFood: false
    });

    const player = this.getPlayer(playerId);
    if (player) {
      player.entityId = playerEntity.id;
    }

    return true;
  }

  async tick() {
    this.updatePhysics();
    this.detectCollisions();
    this.spawnFoodPeriodically();
    this.updatePlayerScores();
  }

  updatePhysics() {
    for (const entity of this.getEntities()) {
      if (!entity.isAlive) continue;

      const damping = 0.95;
      entity.vx *= damping;
      entity.vy *= damping;

      entity.x += entity.vx;
      entity.y += entity.vy;

      if (entity.x < 0) entity.x += this.gameAreaWidth;
      if (entity.x >= this.gameAreaWidth) entity.x -= this.gameAreaWidth;
      if (entity.y < 0) entity.y += this.gameAreaHeight;
      if (entity.y >= this.gameAreaHeight) entity.y -= this.gameAreaHeight;

      if (Math.abs(entity.vx) < 0.01) entity.vx = 0;
      if (Math.abs(entity.vy) < 0.01) entity.vy = 0;
    }
  }

  detectCollisions() {
    const entities = this.getEntities();

    for (let i = 0; i < entities.length; i++) {
      const entityA = entities[i];
      if (!entityA.isAlive) continue;

      const radiusA = this.massToRadius(entityA.mass || this.initialMass);

      for (let j = i + 1; j < entities.length; j++) {
        const entityB = entities[j];
        if (!entityB.isAlive) continue;

        const radiusB = this.massToRadius(entityB.mass || this.initialMass);

        if (this.checkCollision(entityA, radiusA, entityB, radiusB)) {
          this.handleCollision(entityA, entityB);
        }
      }
    }
  }

  handleCollision(entityA, entityB) {
    const massA = entityA.mass || this.initialMass;
    const massB = entityB.mass || this.foodMass;

    if (massA > massB) {
      entityA.mass = (entityA.mass || this.initialMass) + massB;
      this.despawnEntity(entityB.id);

      if (entityA.ownerId) {
        const player = this.getPlayer(entityA.ownerId);
        if (player) player.score += massB;
      }
    } else if (massB > massA) {
      entityB.mass = (entityB.mass || this.initialMass) + massA;
      this.despawnEntity(entityA.id);

      if (entityB.ownerId) {
        const player = this.getPlayer(entityB.ownerId);
        if (player) player.score += massA;
      }
    }
  }

  spawnFoodPeriodically() {
    this.lastFoodSpawn++;

    if (this.lastFoodSpawn >= this.foodSpawnInterval) {
      for (let i = 0; i < this.foodPerSpawn; i++) {
        const x = Math.random() * this.gameAreaWidth;
        const y = Math.random() * this.gameAreaHeight;

        this.spawnEntity({
          x,
          y,
          vx: 0,
          vy: 0,
          angle: 0,
          isPlayer: false,
          mass: this.foodMass,
          color: this.getRandomColor(),
          isFood: true
        });
      }
      this.lastFoodSpawn = 0;
    }
  }

  updatePlayerScores() {
    for (const player of this.getPlayers()) {
      if (player.entityId) {
        const entity = this.getEntity(player.entityId);
        if (entity) {
          player.score = Math.max(player.score, (entity.mass || 0) - this.initialMass);
        }
      }
    }
  }

  onPlayerInput(playerId, inputFrame) {
    const player = this.getPlayer(playerId);
    if (!player || !player.entityId) return;

    const entity = this.getEntity(player.entityId);
    if (!entity || !entity.isAlive) return;

    const mass = entity.mass || this.initialMass;
    const baseSpeed = 2.0;

    const speed = baseSpeed * Math.sqrt(this.initialMass / Math.max(1, mass));

    const acceleration = 0.3;
    entity.vx += inputFrame.moveX * speed * acceleration;
    entity.vy += inputFrame.moveY * speed * acceleration;

    const maxVelocity = speed * 1.5;
    const velocityMagnitude = Math.sqrt(entity.vx * entity.vx + entity.vy * entity.vy);
    if (velocityMagnitude > maxVelocity) {
      entity.vx = (entity.vx / velocityMagnitude) * maxVelocity;
      entity.vy = (entity.vy / velocityMagnitude) * maxVelocity;
    }

    if (entity.vx !== 0 || entity.vy !== 0) {
      entity.angle = Math.atan2(entity.vy, entity.vx) * (180 / Math.PI);
    }
  }

  massToRadius(mass) {
    return Math.sqrt(mass);
  }

  getRandomColor() {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
      '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2',
      '#F8B739', '#52C4CD', '#FF8B5B', '#7FD8BE'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  getState() {
    const state = super.getState();
    return {
      ...state,
      gameAreaWidth: this.gameAreaWidth,
      gameAreaHeight: this.gameAreaHeight,
      entities: this.getEntities().map(entity => ({
        ...entity,
        radius: this.massToRadius(entity.mass || this.initialMass)
      }))
    };
  }
}

// ====================================================================
// SLITHER ROOM - Slither.io game mode
// ====================================================================

class SlitherRoom extends AbstractGameRoom {
  constructor(roomId, config = {}) {
    super(roomId, 'slither', {
      maxPlayers: config.maxPlayers || 20,
      tickRate: 60,
      inputBufferSize: 3,
      ...config
    });

    this.gameAreaWidth = config.gameAreaWidth || 10000;
    this.gameAreaHeight = config.gameAreaHeight || 10000;
    this.foodSpawnInterval = config.foodSpawnInterval || 80;
    this.foodPerSpawn = config.foodPerSpawn || 8;
    this.snakeSpeed = config.snakeSpeed || 3.5;
    this.initialSegments = config.initialSegments || 3;
    this.segmentSpacing = config.segmentSpacing || 2;
    this.lastFoodSpawn = 0;
  }

  addPlayer(playerId, username) {
    const added = super.addPlayer(playerId, username);
    if (!added) return false;

    const x = Math.random() * this.gameAreaWidth;
    const y = Math.random() * this.gameAreaHeight;
    const startAngle = Math.random() * 360;

    const segments = this.initializeSnakeSegments(x, y, startAngle, this.initialSegments);
    const snakeEntity = this.spawnEntity({
      x,
      y,
      vx: 0,
      vy: 0,
      angle: startAngle,
      isPlayer: true,
      ownerId: playerId,
      segmentCount: this.initialSegments,
      segments,
      targetAngle: startAngle,
      isFood: false
    });

    const player = this.getPlayer(playerId);
    if (player) {
      player.entityId = snakeEntity.id;
    }

    return true;
  }

  initializeSnakeSegments(headX, headY, angle, segmentCount) {
    const segments = [];
    const radians = (angle * Math.PI) / 180;

    for (let i = 0; i < segmentCount; i++) {
      const distance = i * this.segmentSpacing;
      const x = headX - Math.cos(radians) * distance;
      const y = headY - Math.sin(radians) * distance;

      segments.push({
        id: `segment_${i}`,
        x,
        y,
        angle
      });
    }

    return segments;
  }

  async tick() {
    this.updateSnakeHeadings();
    this.moveSnakes();
    this.detectFoodCollisions();
    this.detectHeadCollisions();
    this.spawnFoodPeriodically();
  }

  updateSnakeHeadings() {
    for (const entity of this.getEntities()) {
      if (!entity.isAlive || !entity.isPlayer) continue;

      const target = entity.targetAngle || entity.angle;
      const current = entity.angle;
      let diff = target - current;
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;

      const lerpFactor = 0.1;
      entity.angle = current + diff * lerpFactor;
      entity.angle = ((entity.angle % 360) + 360) % 360;
    }
  }

  moveSnakes() {
    for (const entity of this.getEntities()) {
      if (!entity.isAlive || !entity.isPlayer) continue;

      if (!entity.segments || entity.segments.length === 0) continue;

      const radians = (entity.angle * Math.PI) / 180;
      const dx = Math.cos(radians) * this.snakeSpeed;
      const dy = Math.sin(radians) * this.snakeSpeed;

      const head = entity.segments[0];
      head.x = (head.x + dx + this.gameAreaWidth) % this.gameAreaWidth;
      head.y = (head.y + dy + this.gameAreaHeight) % this.gameAreaHeight;
      head.angle = entity.angle;

      for (let i = 1; i < entity.segments.length; i++) {
        const curr = entity.segments[i];
        const prev = entity.segments[i - 1];

        const dist = this.distance(curr.x, curr.y, prev.x, prev.y);

        if (dist > this.segmentSpacing) {
          const ratio = this.segmentSpacing / Math.max(0.1, dist);
          curr.x = curr.x + (prev.x - curr.x) * ratio;
          curr.y = curr.y + (prev.y - curr.y) * ratio;
          curr.angle = Math.atan2(prev.y - curr.y, prev.x - curr.x) * (180 / Math.PI);
        }
      }

      entity.x = head.x;
      entity.y = head.y;
    }
  }

  detectFoodCollisions() {
    const entities = this.getEntities();

    for (const snake of entities) {
      if (!snake.isAlive || !snake.isPlayer) continue;
      if (!snake.segments || snake.segments.length === 0) continue;

      const headRadius = 1.5;
      const headSegment = snake.segments[0];

      for (const food of entities) {
        if (!food.isAlive || food.isPlayer) continue;

        const foodRadius = 1.0;
        const dist = this.distance(headSegment.x, headSegment.y, food.x, food.y);

        if (dist < headRadius + foodRadius) {
          this.consumeFood(snake, food);
        }
      }
    }
  }

  detectHeadCollisions() {
    const entities = this.getEntities();

    for (const snake of entities) {
      if (!snake.isAlive || !snake.isPlayer) continue;
      if (!snake.segments || snake.segments.length === 0) continue;

      const headSegment = snake.segments[0];
      const headRadius = 1.5;

      for (const otherSnake of entities) {
        if (otherSnake.id === snake.id || !otherSnake.isAlive || !otherSnake.isPlayer) continue;

        if (!otherSnake.segments) continue;

        for (const segment of otherSnake.segments) {
          const dist = this.distance(headSegment.x, headSegment.y, segment.x, segment.y);
          if (dist < headRadius + 1.0) {
            snake.segmentCount = 0;
            this.killSnake(snake);
            return;
          }
        }
      }
    }
  }

  consumeFood(snake, food) {
    this.despawnEntity(food.id);

    if (snake.segments && snake.segments.length > 0) {
      const tail = snake.segments[snake.segments.length - 1];
      snake.segments.push({
        id: `segment_${snake.segments.length}`,
        x: tail.x,
        y: tail.y,
        angle: tail.angle
      });
      snake.segmentCount = (snake.segmentCount || 0) + 1;

      const player = this.getPlayer(snake.ownerId || '');
      if (player) {
        player.score += 1;
      }
    }
  }

  killSnake(snake) {
    snake.segmentCount = 0;
    snake.isAlive = false;

    const playerId = snake.ownerId;
    if (playerId) {
      const player = this.getPlayer(playerId);
      if (player) {
        setTimeout(() => {
          if (player.id === playerId) {
            this.respawnSnake(playerId);
          }
        }, 2000);
      }
    }
  }

  respawnSnake(playerId) {
    const entityId = this.getPlayer(playerId)?.entityId;
    const entity = this.getEntity(entityId || '');
    if (!entity) return;

    const x = Math.random() * this.gameAreaWidth;
    const y = Math.random() * this.gameAreaHeight;
    const angle = Math.random() * 360;

    entity.x = x;
    entity.y = y;
    entity.angle = angle;
    entity.isAlive = true;
    entity.segmentCount = this.initialSegments;
    entity.segments = this.initializeSnakeSegments(x, y, angle, this.initialSegments);
    entity.targetAngle = angle;
  }

  spawnFoodPeriodically() {
    this.lastFoodSpawn++;

    if (this.lastFoodSpawn >= this.foodSpawnInterval) {
      for (let i = 0; i < this.foodPerSpawn; i++) {
        const x = Math.random() * this.gameAreaWidth;
        const y = Math.random() * this.gameAreaHeight;

        this.spawnEntity({
          x,
          y,
          vx: 0,
          vy: 0,
          angle: 0,
          isPlayer: false,
          isFood: true,
          mass: 1
        });
      }
      this.lastFoodSpawn = 0;
    }
  }

  onPlayerInput(playerId, inputFrame) {
    const player = this.getPlayer(playerId);
    if (!player || !player.entityId) return;

    const entity = this.getEntity(player.entityId);
    if (!entity || !entity.isAlive) return;

    if (inputFrame.moveX !== 0 || inputFrame.moveY !== 0) {
      const targetAngle = Math.atan2(inputFrame.moveY, inputFrame.moveX) * (180 / Math.PI);
      entity.targetAngle = targetAngle;
    }
  }

  getState() {
    const state = super.getState();
    return {
      ...state,
      gameAreaWidth: this.gameAreaWidth,
      gameAreaHeight: this.gameAreaHeight,
      entities: this.getEntities().map(entity => ({
        ...entity,
        segments: entity.isPlayer ? entity.segments : undefined,
        segmentCount: entity.segmentCount
      }))
    };
  }
}

// ====================================================================
// RACING ROOM - Racing game mode
// ====================================================================

class RacingRoom extends AbstractGameRoom {
  constructor(roomId, config = {}) {
    super(roomId, 'racing', {
      maxPlayers: config.maxPlayers || 20,
      tickRate: 60,
      inputBufferSize: 3,
      ...config
    });

    this.gameAreaWidth = config.gameAreaWidth || 10000;
    this.gameAreaHeight = config.gameAreaHeight || 10000;
    this.checkpointSpawnInterval = config.checkpointSpawnInterval || 120;
    this.checkpointsPerSpawn = config.checkpointsPerSpawn || 3;
    this.vehicleMaxSpeed = config.vehicleMaxSpeed || 5.0;
    this.vehicleAcceleration = config.vehicleAcceleration || 0.15;
    this.vehicleFriction = config.vehicleFriction || 0.98;
    this.vehicleMaxSteeringAngle = config.vehicleMaxSteeringAngle || 30;
    this.lastCheckpointSpawn = 0;
  }

  addPlayer(playerId, username) {
    const added = super.addPlayer(playerId, username);
    if (!added) return false;

    const x = Math.random() * this.gameAreaWidth;
    const y = Math.random() * this.gameAreaHeight;
    const angle = Math.random() * 360;

    const vehicle = this.spawnEntity({
      x,
      y,
      vx: 0,
      vy: 0,
      angle,
      isPlayer: true,
      ownerId: playerId,
      maxSpeed: this.vehicleMaxSpeed,
      acceleration: this.vehicleAcceleration,
      friction: this.vehicleFriction,
      steeringAngle: 0,
      maxSteeringAngle: this.vehicleMaxSteeringAngle,
      isDrifting: false,
      checkpointsCollected: 0,
      isFood: false
    });

    const player = this.getPlayer(playerId);
    if (player) {
      player.entityId = vehicle.id;
      player.score = 0;
    }

    return true;
  }

  async tick() {
    this.updateVehiclePhysics();
    this.detectCheckpointCollisions();
    this.detectVehicleCollisions();
    this.spawnCheckpointsPeriodically();
  }

  updateVehiclePhysics() {
    for (const entity of this.getEntities()) {
      if (!entity.isAlive || !entity.isPlayer) continue;

      const maxSpeed = entity.maxSpeed || this.vehicleMaxSpeed;
      const friction = entity.friction || this.vehicleFriction;
      const steeringAngle = entity.steeringAngle || 0;

      if (steeringAngle !== 0) {
        const steeringRadians = (steeringAngle * Math.PI) / 180;
        const speed = Math.sqrt(entity.vx * entity.vx + entity.vy * entity.vy);
        if (speed > 0.1) {
          const currentAngle = Math.atan2(entity.vy, entity.vx);
          const newAngle = currentAngle + steeringRadians * 0.05;

          entity.vx = Math.cos(newAngle) * speed;
          entity.vy = Math.sin(newAngle) * speed;
          entity.angle = (newAngle * 180) / Math.PI;
        }
      }

      entity.vx *= friction;
      entity.vy *= friction;

      entity.x += entity.vx;
      entity.y += entity.vy;

      if (entity.x < 0) entity.x += this.gameAreaWidth;
      if (entity.x >= this.gameAreaWidth) entity.x -= this.gameAreaWidth;
      if (entity.y < 0) entity.y += this.gameAreaHeight;
      if (entity.y >= this.gameAreaHeight) entity.y -= this.gameAreaHeight;

      const speed = Math.sqrt(entity.vx * entity.vx + entity.vy * entity.vy);
      if (speed < 0.01) {
        entity.vx = 0;
        entity.vy = 0;
      }
    }
  }

  detectCheckpointCollisions() {
    const entities = this.getEntities();

    for (const vehicle of entities) {
      if (!vehicle.isAlive || !vehicle.isPlayer) continue;

      const vehicleRadius = 1.5;

      for (const checkpoint of entities) {
        if (!checkpoint.isAlive || checkpoint.isPlayer) continue;

        const checkpointRadius = 2.0;
        const dist = this.distance(vehicle.x, vehicle.y, checkpoint.x, checkpoint.y);

        if (dist < vehicleRadius + checkpointRadius) {
          this.collectCheckpoint(vehicle, checkpoint);
        }
      }
    }
  }

  collectCheckpoint(vehicle, checkpoint) {
    const maxSpeed = vehicle.maxSpeed || this.vehicleMaxSpeed;

    const speed = Math.sqrt(vehicle.vx * vehicle.vx + vehicle.vy * vehicle.vy);
    if (speed < maxSpeed) {
      const boostFactor = 1.2;
      vehicle.vx *= boostFactor;
      vehicle.vy *= boostFactor;
    }

    vehicle.checkpointsCollected = (vehicle.checkpointsCollected || 0) + 1;

    const player = this.getPlayer(vehicle.ownerId || '');
    if (player) {
      player.score += 10;
    }

    this.despawnEntity(checkpoint.id);
  }

  detectVehicleCollisions() {
    const entities = this.getEntities();

    for (let i = 0; i < entities.length; i++) {
      const vehicle1 = entities[i];
      if (!vehicle1.isAlive || !vehicle1.isPlayer) continue;

      const radius1 = 1.5;

      for (let j = i + 1; j < entities.length; j++) {
        const vehicle2 = entities[j];
        if (!vehicle2.isAlive || !vehicle2.isPlayer) continue;

        const radius2 = 1.5;

        if (this.checkCollision(vehicle1, radius1, vehicle2, radius2)) {
          this.bounceVehicles(vehicle1, vehicle2);
        }
      }
    }
  }

  bounceVehicles(vehicle1, vehicle2) {
    const dx = vehicle2.x - vehicle1.x;
    const dy = vehicle2.y - vehicle1.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist === 0) return;

    const nx = dx / dist;
    const ny = dy / dist;

    const v1n = vehicle1.vx * nx + vehicle1.vy * ny;
    const v2n = vehicle2.vx * nx + vehicle2.vy * ny;

    if (v1n - v2n >= 0) return;

    vehicle1.vx += (v2n - v1n) * nx * 0.5;
    vehicle1.vy += (v2n - v1n) * ny * 0.5;

    vehicle2.vx += (v1n - v2n) * nx * 0.5;
    vehicle2.vy += (v1n - v2n) * ny * 0.5;

    const overlap = 1.5 + 1.5 - dist;
    vehicle1.x -= (overlap / 2) * nx;
    vehicle1.y -= (overlap / 2) * ny;

    vehicle2.x += (overlap / 2) * nx;
    vehicle2.y += (overlap / 2) * ny;
  }

  spawnCheckpointsPeriodically() {
    this.lastCheckpointSpawn++;

    if (this.lastCheckpointSpawn >= this.checkpointSpawnInterval) {
      for (let i = 0; i < this.checkpointsPerSpawn; i++) {
        const x = Math.random() * this.gameAreaWidth;
        const y = Math.random() * this.gameAreaHeight;

        this.spawnEntity({
          x,
          y,
          vx: 0,
          vy: 0,
          angle: 0,
          isPlayer: false,
          isFood: false
        });
      }
      this.lastCheckpointSpawn = 0;
    }
  }

  onPlayerInput(playerId, inputFrame) {
    const player = this.getPlayer(playerId);
    if (!player || !player.entityId) return;

    const entity = this.getEntity(player.entityId);
    if (!entity || !entity.isAlive) return;

    const maxSteeringAngle = entity.maxSteeringAngle || this.vehicleMaxSteeringAngle;
    const maxSpeed = entity.maxSpeed || this.vehicleMaxSpeed;
    const accel = entity.acceleration || this.vehicleAcceleration;

    entity.steeringAngle = inputFrame.moveX * maxSteeringAngle;

    if (inputFrame.moveY > 0) {
      const currentSpeed = Math.sqrt(entity.vx * entity.vx + entity.vy * entity.vy);
      if (currentSpeed < maxSpeed) {
        const angle = entity.angle * (Math.PI / 180);
        entity.vx += Math.cos(angle) * accel * inputFrame.moveY;
        entity.vy += Math.sin(angle) * accel * inputFrame.moveY;
      }
    } else if (inputFrame.moveY < 0) {
      entity.vx *= 0.95;
      entity.vy *= 0.95;
    }

    entity.isDrifting = inputFrame.action > 0;
  }

  getState() {
    const state = super.getState();
    return {
      ...state,
      gameAreaWidth: this.gameAreaWidth,
      gameAreaHeight: this.gameAreaHeight,
      entities: this.getEntities().map(entity => ({
        ...entity,
        steeringAngle: entity.isPlayer ? entity.steeringAngle : undefined,
        isDrifting: entity.isPlayer ? entity.isDrifting : undefined,
        checkpointsCollected: entity.isPlayer ? entity.checkpointsCollected : undefined
      }))
    };
  }
}

// ====================================================================
// FLAPPY ROOM - Gravity-based platformer
// ====================================================================

class FlappyRoom extends AbstractGameRoom {
  constructor(roomId, config = {}) {
    super(roomId, 'flappy', {
      maxPlayers: config.maxPlayers || 20,
      tickRate: 60,
      inputBufferSize: 3,
      ...config
    });

    this.gameAreaWidth = config.gameAreaWidth || 10000;
    this.gameAreaHeight = config.gameAreaHeight || 8000;
    this.playerGravity = config.playerGravity || 0.3;
    this.playerJumpForce = config.playerJumpForce || 7.0;
    this.playerMaxVerticalVelocity = config.playerMaxVerticalVelocity || 15.0;
    this.initialLives = config.initialLives || 3;
    this.obstacleSpawnRate = config.obstacleSpawnRate || 90;
    this.obstacleTypes = config.obstacleTypes || ['pipe', 'spike'];
    this.difficultyScaling = config.difficultyScaling || 0.001;
    this.lastObstacleSpawn = 0;
  }

  addPlayer(playerId, username) {
    const added = super.addPlayer(playerId, username);
    if (!added) return false;

    const x = this.gameAreaWidth * 0.2;
    const y = this.gameAreaHeight / 2;

    const player = this.spawnEntity({
      x,
      y,
      vx: 2.0,
      vy: 0,
      angle: 0,
      isPlayer: true,
      ownerId: playerId,
      velocityY: 0,
      gravity: this.playerGravity,
      jumpForce: this.playerJumpForce,
      isJumping: false,
      lives: this.initialLives,
      isInvincible: false,
      invincibilityCounter: 0,
      distanceTraveled: 0,
      isFood: false
    });

    const playerObj = this.getPlayer(playerId);
    if (playerObj) {
      playerObj.entityId = player.id;
      playerObj.score = 0;
    }

    return true;
  }

  async tick() {
    this.applyGravity();
    this.updatePlayerMovement();
    this.spawnObstaclesPeriodically();
    this.updateObstacleMovement();
    this.detectCollisions();
    this.cleanupOffscreenEntities();
    this.checkGameOverConditions();
  }

  applyGravity() {
    for (const entity of this.getEntities()) {
      if (!entity.isAlive || !entity.isPlayer) continue;

      const gravity = entity.gravity || this.playerGravity;
      const maxVel = entity.playerMaxVerticalVelocity || this.playerMaxVerticalVelocity;

      entity.velocityY = (entity.velocityY || 0) + gravity;
      entity.velocityY = Math.max(-maxVel, Math.min(maxVel, entity.velocityY));

      entity.y += entity.velocityY;

      if (entity.y > this.gameAreaHeight) {
        entity.lives = (entity.lives || 1) - 1;
        entity.y = this.gameAreaHeight;
        entity.velocityY = 0;
        entity.isJumping = false;

        if (entity.lives <= 0) {
          entity.isAlive = false;
          this.emit('playerDeath', { playerId: entity.ownerId, reason: 'fell' });
        }
      }

      if (entity.y < 0) {
        entity.lives = (entity.lives || 1) - 1;
        entity.y = 0;
        entity.velocityY = 0;
        entity.isJumping = false;

        if (entity.lives <= 0) {
          entity.isAlive = false;
          this.emit('playerDeath', { playerId: entity.ownerId, reason: 'ceiling' });
        }
      }
    }
  }

  updatePlayerMovement() {
    const speedBoost = 1.0 + this.currentTick * this.difficultyScaling;

    for (const entity of this.getEntities()) {
      if (!entity.isAlive || !entity.isPlayer) continue;

      const baseSpeed = 2.0;
      entity.x += baseSpeed * speedBoost;

      entity.distanceTraveled = (entity.distanceTraveled || 0) + baseSpeed * speedBoost;

      const playerObj = this.getPlayer(entity.ownerId || '');
      if (playerObj) {
        playerObj.score = Math.floor(entity.distanceTraveled / 100);
      }

      if (entity.isInvincible && entity.invincibilityCounter) {
        entity.invincibilityCounter--;
        if (entity.invincibilityCounter <= 0) {
          entity.isInvincible = false;
        }
      }
    }
  }

  spawnObstaclesPeriodically() {
    this.lastObstacleSpawn++;

    if (this.lastObstacleSpawn >= this.obstacleSpawnRate) {
      const typeIndex = Math.floor(Math.random() * this.obstacleTypes.length);
      const obstacleType = this.obstacleTypes[typeIndex];

      const x = this.gameAreaWidth;
      const y = Math.random() * (this.gameAreaHeight - 200) + 100;

      this.spawnEntity({
        x,
        y,
        vx: -3.0,
        vy: 0,
        angle: 0,
        isPlayer: false,
        obstacleType,
        damage: 1,
        moveDirection: 'left',
        moveSpeed: 3.0,
        isFood: false
      });

      this.lastObstacleSpawn = 0;
    }
  }

  updateObstacleMovement() {
    const speedBoost = 1.0 + this.currentTick * this.difficultyScaling;

    for (const entity of this.getEntities()) {
      if (entity.isAlive && !entity.isPlayer) {
        const moveDir = entity.moveDirection || 'left';
        const moveSpeed = (entity.moveSpeed || 3.0) * speedBoost;

        if (moveDir === 'left') {
          entity.x -= moveSpeed;
        }
      }
    }
  }

  detectCollisions() {
    const entities = this.getEntities();

    for (const player of entities) {
      if (!player.isAlive || !player.isPlayer) continue;

      const playerRadius = 2.0;

      for (const obstacle of entities) {
        if (!obstacle.isAlive || obstacle.isPlayer) continue;

        const obstacleRadius = 2.5;
        const dist = this.distance(player.x, player.y, obstacle.x, obstacle.y);

        if (dist < playerRadius + obstacleRadius) {
          if (!player.isInvincible) {
            player.lives = (player.lives || 1) - 1;
            player.isInvincible = true;
            player.invincibilityCounter = 120;

            if (player.lives <= 0) {
              player.isAlive = false;
              this.emit('playerDeath', { playerId: player.ownerId, reason: 'collision' });
            }

            this.despawnEntity(obstacle.id);
          }
        }
      }
    }
  }

  cleanupOffscreenEntities() {
    const entities = this.getEntities();

    for (const entity of entities) {
      if (entity.isPlayer) continue;

      if (entity.x < -500 || entity.x > this.gameAreaWidth + 500) {
        this.despawnEntity(entity.id);
      }
    }
  }

  checkGameOverConditions() {
    const alivePlayers = Array.from(this.getPlayers()).filter(p =>
      this.getEntity(p.entityId || '')?.isAlive
    );

    if (alivePlayers.length === 0 && this.getPlayers().length > 0) {
      this.emit('gameOver', {
        survivors: 0,
        highestScore: Math.max(
          ...Array.from(this.getPlayers()).map(p => p.score)
        )
      });
    }
  }

  onPlayerInput(playerId, inputFrame) {
    const player = this.getPlayer(playerId);
    if (!player || !player.entityId) return;

    const entity = this.getEntity(player.entityId);
    if (!entity || !entity.isAlive) return;

    if (inputFrame.action > 0 && !entity.isJumping) {
      const jumpForce = entity.jumpForce || this.playerJumpForce;
      entity.velocityY = -jumpForce;
      entity.isJumping = true;
    }

    if (inputFrame.action === 0) {
      entity.isJumping = false;
    }
  }

  getState() {
    const state = super.getState();
    const speedBoost = 1.0 + this.currentTick * this.difficultyScaling;

    return {
      ...state,
      gameAreaWidth: this.gameAreaWidth,
      gameAreaHeight: this.gameAreaHeight,
      currentDifficulty: speedBoost,
      entities: this.getEntities().map(entity => ({
        ...entity,
        velocityY: entity.isPlayer ? entity.velocityY : undefined,
        lives: entity.isPlayer ? entity.lives : undefined,
        isInvincible: entity.isPlayer ? entity.isInvincible : undefined,
        distanceTraveled: entity.isPlayer ? entity.distanceTraveled : undefined,
        obstacleType: !entity.isPlayer ? entity.obstacleType : undefined
      }))
    };
  }
}

module.exports = {
  AbstractGameRoom,
  AgarRoom,
  SlitherRoom,
  RacingRoom,
  FlappyRoom
};

