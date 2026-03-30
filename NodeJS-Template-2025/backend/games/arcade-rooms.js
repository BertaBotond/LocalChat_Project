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

module.exports = {
  AbstractGameRoom,
  AgarRoom
};
