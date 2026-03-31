import { EventEmitter } from 'events';

/**
 * AbstractGameRoom - Base class for all real-time multiplayer arcade games
 * 
 * Provides:
 * - 60Hz tick loop (deterministic frame stepping)
 * - Entity lifecycle management
 * - Input queue buffering (lag compensation)
 * - Delta-state serialization
 * - Event emission for lifecycle hooks
 * 
 * Subclasses MUST override:
 * - tick(): Physics update, collision detection, state changes
 * - onPlayerInput(playerId, inputFrame): Apply player input to entities
 */

export interface InputFrame {
  tick: number;
  moveX: number; // -1, 0, +1
  moveY: number; // -1, 0, +1
  action: number; // 0 = no action, 1-255 = game-specific actions
  timestamp: number; // client timestamp (for replay)
}

export interface Entity {
  id: string;
  x: number; // fixed-point: int32 × 0.001
  y: number;
  vx: number; // velocity x
  vy: number; // velocity y
  angle: number; // 0-360 degrees
  isAlive: boolean;
  isPlayer: boolean;
  ownerId?: string; // player ID that owns this entity
  [key: string]: any; // game-specific properties (mass, score, color, etc)
}

export interface Player {
  id: string;
  username: string;
  joinedAt: number; // timestamp
  entityId?: string; // primary controlled entity
  score: number;
}

export interface GameConfig {
  maxPlayers?: number;
  tickRate?: number; // default 60Hz
  inputBufferSize?: number; // default 3 frames
  [key: string]: any; // game-specific config
}

export abstract class AbstractGameRoom extends EventEmitter {
  protected roomId: string;
  protected gameType: string;
  protected config: GameConfig;

  protected players: Map<string, Player> = new Map();
  protected entities: Map<string, Entity> = new Map();
  protected inputQueue: Map<string, InputFrame[]> = new Map();

  protected currentTick: number = 0;
  protected isRunning: boolean = false;
  protected tickIntervalHandle: NodeJS.Timeout | null = null;

  protected entityIdCounter: number = 0;
  protected lastDeltaTick: number = 0;

  constructor(roomId: string, gameType: string, config: GameConfig = {}) {
    super();
    this.roomId = roomId;
    this.gameType = gameType;
    this.config = {
      maxPlayers: 20,
      tickRate: 60,
      inputBufferSize: 3,
      ...config,
    };
  }

  // ============================================================================
  // LIFECYCLE MANAGEMENT
  // ============================================================================

  /**
   * Start the game loop (60Hz tick)
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.currentTick = 0;
    this.emit('started');

    const tickInterval = 1000 / (this.config.tickRate || 60); // ~16.67ms for 60Hz
    this.tickIntervalHandle = setInterval(() => {
      this.tickCycle();
    }, tickInterval);
  }

  /**
   * Stop the game loop
   */
  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.tickIntervalHandle) {
      clearInterval(this.tickIntervalHandle);
      this.tickIntervalHandle = null;
    }
    this.emit('stopped');
  }

  /**
   * Internal tick cycle: input processing → physics step → state capture
   */
  private async tickCycle(): Promise<void> {
    try {
      // 1. Process queued inputs for all players
      this.processInputQueue();

      // 2. Run game-specific physics, collision detection, logic
      await this.tick();

      // 3. Increment frame counter
      this.currentTick++;
    } catch (error) {
      console.error(`[Arcade] Tick error in room ${this.roomId}:`, error);
      this.emit('tickError', error);
    }
  }

  // ============================================================================
  // ABSTRACT METHODS (Subclasses override)
  // ============================================================================

  /**
   * Game-specific logic: physics updates, collision detection, entity spawning
   * Called once per tick (60Hz)
   */
  protected abstract tick(): Promise<void>;

  /**
   * Apply player input to their controlled entity
   * Called during input queue processing
   */
  protected abstract onPlayerInput(
    playerId: string,
    inputFrame: InputFrame
  ): void;

  // ============================================================================
  // PLAYER MANAGEMENT
  // ============================================================================

  /**
   * Add player to game room
   */
  public addPlayer(playerId: string, username: string): boolean {
    if (this.players.size >= (this.config.maxPlayers || 20)) {
      return false; // Room full
    }
    if (this.players.has(playerId)) {
      return false; // Player already joined
    }

    const player: Player = {
      id: playerId,
      username,
      joinedAt: Date.now(),
      score: 0,
    };
    this.players.set(playerId, player);
    this.inputQueue.set(playerId, []);
    this.emit('playerJoined', { playerId, username });
    return true;
  }

  /**
   * Remove player from game room (cleanup owned entities)
   */
  public removePlayer(playerId: string): void {
    if (!this.players.has(playerId)) return;

    this.players.delete(playerId);
    this.inputQueue.delete(playerId);

    // Mark owned entities as dead or despawn them
    for (const [entityId, entity] of this.entities.entries()) {
      if (entity.ownerId === playerId) {
        entity.isAlive = false;
        this.emit('entityDespawned', { entityId, playerId });
      }
    }

    this.emit('playerLeft', { playerId });
  }

  /**
   * Get player by ID
   */
  public getPlayer(playerId: string): Player | undefined {
    return this.players.get(playerId);
  }

  /**
   * Get all players
   */
  public getPlayers(): Player[] {
    return Array.from(this.players.values());
  }

  // ============================================================================
  // ENTITY MANAGEMENT
  // ============================================================================

  /**
   * Spawn a new entity
   */
  protected spawnEntity(entity: Partial<Entity>): Entity {
    const newEntity: Entity = {
      id: `entity_${this.entityIdCounter++}`,
      x: entity.x || 0,
      y: entity.y || 0,
      vx: entity.vx || 0,
      vy: entity.vy || 0,
      angle: entity.angle || 0,
      isAlive: true,
      isPlayer: entity.isPlayer || false,
      ownerId: entity.ownerId,
      ...entity,
    };
    this.entities.set(newEntity.id, newEntity);
    this.emit('entitySpawned', { entityId: newEntity.id, entity: newEntity });
    return newEntity;
  }

  /**
   * Despawn entity
   */
  protected despawnEntity(entityId: string): void {
    const entity = this.entities.get(entityId);
    if (entity) {
      entity.isAlive = false;
      this.entities.delete(entityId);
      this.emit('entityDespawned', { entityId });
    }
  }

  /**
   * Get entity by ID
   */
  protected getEntity(entityId: string): Entity | undefined {
    return this.entities.get(entityId);
  }

  /**
   * Get all entities
   */
  protected getEntities(): Entity[] {
    return Array.from(this.entities.values());
  }

  // ============================================================================
  // INPUT QUEUE PROCESSING (LAG COMPENSATION)
  // ============================================================================

  /**
   * Queue input from client (called from Socket.IO event handler)
   */
  public queueInput(playerId: string, inputFrame: InputFrame): void {
    const queue = this.inputQueue.get(playerId);
    if (!queue) return; // Player not in game

    // Keep only last N frames to prevent memory leak
    const maxBufferSize = this.config.inputBufferSize || 3;
    if (queue.length >= maxBufferSize) {
      queue.shift(); // Remove oldest frame
    }
    queue.push(inputFrame);
  }

  /**
   * Process all buffered inputs (called once per tick)
   */
  protected processInputQueue(): void {
    for (const [playerId, queue] of this.inputQueue.entries()) {
      for (const inputFrame of queue) {
        this.onPlayerInput(playerId, inputFrame);
      }
      queue.length = 0; // Clear queue after processing
    }
  }

  // ============================================================================
  // STATE SERIALIZATION
  // ============================================================================

  /**
   * Get full game state (all entities, players, tick counter)
   */
  public getState(): any {
    return {
      roomId: this.roomId,
      gameType: this.gameType,
      currentTick: this.currentTick,
      isRunning: this.isRunning,
      players: Array.from(this.players.values()),
      entities: Array.from(this.entities.values()),
      playerCount: this.players.size,
    };
  }

  /**
   * Get delta state (only entities changed since lastDeltaTick)
   * Used for efficient binary protocol encoding
   */
  public getDeltaState(lastSeenTick: number): any {
    // Full state refresh every 10 ticks to prevent divergence
    const shouldFullRefresh = (this.currentTick - lastSeenTick) % 10 === 0;

    if (shouldFullRefresh || lastSeenTick === 0) {
      return {
        tick: this.currentTick,
        type: 'full',
        entities: Array.from(this.entities.values()),
        players: Array.from(this.players.values()),
      };
    }

    return {
      tick: this.currentTick,
      type: 'delta',
      entities: Array.from(this.entities.values()),
      playerCount: this.players.size,
    };
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  public getRoomId(): string {
    return this.roomId;
  }

  public getGameType(): string {
    return this.gameType;
  }

  public getPlayerCount(): number {
    return this.players.size;
  }

  public isGameRunning(): boolean {
    return this.isRunning;
  }

  public getCurrentTick(): number {
    return this.currentTick;
  }

  /**
   * Calculate distance between two points (using fixed-point coordinates)
   */
  protected distance(x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Check if two circular entities overlap
   */
  protected checkCollision(
    entity1: Entity,
    radius1: number,
    entity2: Entity,
    radius2: number
  ): boolean {
    const dist = this.distance(entity1.x, entity1.y, entity2.x, entity2.y);
    return dist < radius1 + radius2;
  }

  /**
   * Clamp a value between min and max
   */
  protected clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
