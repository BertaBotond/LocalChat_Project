import { AbstractGameRoom, InputFrame, Entity } from './game-room';

/**
 * AgarRoom - Agar.io-style game mode
 * 
 * Game Rules:
 * - Players control a circular entity (mass-based size)
 * - Consume smaller food pellets to gain mass
 * - Larger entities move slower (speed ∝ 1/sqrt(mass))
 * - Boundaries wrap around (modulo 1000)
 * - Score = total mass gained
 * 
 * Physics:
 * - Frictionless space with velocity damping (0.95x per frame)
 * - Collision detection O(n²) broad-phase
 * - No complex collision response (just consumption)
 */

interface AgarEntity extends Entity {
  mass?: number; // Units: 1-10000 (food=1, starting=50)
  energy?: number; // For future special abilities
  color?: string; // Visual client-side (not replicated in binary protocol)
}

interface AgarConfig {
  gameAreaWidth?: number;
  gameAreaHeight?: number;
  maxPlayers?: number;
  foodSpawnInterval?: number; // ticks between food spawns
  foodPerSpawn?: number;
  initialMass?: number;
  foodMass?: number;
}

export class AgarRoom extends AbstractGameRoom {
  private lastFoodSpawn: number = 0;
  private gameAreaWidth: number;
  private gameAreaHeight: number;
  private foodSpawnInterval: number;
  private foodPerSpawn: number;
  private initialMass: number;
  private foodMass: number;

  constructor(roomId: string, config: AgarConfig = {}) {
    super(roomId, 'agar', {
      maxPlayers: config.maxPlayers || 20,
      tickRate: 60,
      inputBufferSize: 3,
      ...config,
    });

    this.gameAreaWidth = config.gameAreaWidth || 10000;
    this.gameAreaHeight = config.gameAreaHeight || 10000;
    this.foodSpawnInterval = config.foodSpawnInterval || 100; // Spawn every 100 ticks (~1.67s at 60Hz)
    this.foodPerSpawn = config.foodPerSpawn || 5;
    this.initialMass = config.initialMass || 50;
    this.foodMass = config.foodMass || 1;
  }

  // ============================================================================
  // PLAYER JOINING
  // ============================================================================

  /**
   * Override addPlayer to spawn player entity
   */
  public addPlayer(playerId: string, username: string): boolean {
    const added = super.addPlayer(playerId, username);
    if (!added) return false;

    // Spawn player entity at random location
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
      isFood: false,
    }) as AgarEntity;

    // Link player to entity
    const player = this.getPlayer(playerId);
    if (player) {
      player.entityId = playerEntity.id;
    }

    return true;
  }

  // ============================================================================
  // GAME LOOP (tick)
  // ============================================================================

  /**
   * Physics simulation: movement, collision, food spawning
   */
  protected async tick(): Promise<void> {
    // 1. Update entity physics (velocity damping, boundary wrapping)
    this.updatePhysics();

    // 2. Collision detection: consume food / other entities
    this.detectCollisions();

    // 3. Spawn food periodically
    this.spawnFoodPeriodically();

    // 4. Update player scores
    this.updatePlayerScores();
  }

  /**
   * Update entity positions and apply damping
   */
  private updatePhysics(): void {
    for (const entity of this.getEntities()) {
      if (!entity.isAlive) continue;

      // Apply velocity damping (friction)
      const damping = 0.95;
      entity.vx *= damping;
      entity.vy *= damping;

      // Update position
      entity.x += entity.vx;
      entity.y += entity.vy;

      // Boundary wrapping
      if (entity.x < 0) entity.x += this.gameAreaWidth;
      if (entity.x >= this.gameAreaWidth) entity.x -= this.gameAreaWidth;
      if (entity.y < 0) entity.y += this.gameAreaHeight;
      if (entity.y >= this.gameAreaHeight) entity.y -= this.gameAreaHeight;

      // Stop if velocity is negligible
      if (Math.abs(entity.vx) < 0.01) entity.vx = 0;
      if (Math.abs(entity.vy) < 0.01) entity.vy = 0;
    }
  }

  /**
   * Collision detection and handling
   * O(n²) broad-phase: check all entity pairs for overlap
   */
  private detectCollisions(): void {
    const entities = this.getEntities();

    for (let i = 0; i < entities.length; i++) {
      const entityA = entities[i];
      if (!entityA.isAlive) continue;

      const agarA = entityA as AgarEntity;
      const radiusA = this.massToRadius(agarA.mass || this.initialMass);

      for (let j = i + 1; j < entities.length; j++) {
        const entityB = entities[j];
        if (!entityB.isAlive) continue;

        const agarB = entityB as AgarEntity;
        const radiusB = this.massToRadius(agarB.mass || this.initialMass);

        // Check if entities overlap
        if (this.checkCollision(entityA, radiusA, entityB, radiusB)) {
          this.handleCollision(entityA, entityB);
        }
      }
    }
  }

  /**
   * Handle collision between two entities
   * - Player eating food: gain mass
   * - Player eating player: if significantly larger, consume
   * - Food touching food: no-op
   */
  private handleCollision(entityA: Entity, entityB: Entity): void {
    const agarA = entityA as AgarEntity;
    const agarB = entityB as AgarEntity;

    const massA = agarA.mass || this.initialMass;
    const massB = agarB.mass || this.foodMass;

    // Larger entity consumes smaller
    if (massA > massB) {
      // A consumes B
      agarA.mass = (agarA.mass || this.initialMass) + massB;
      this.despawnEntity(entityB.id);

      // Award score to consuming player
      if (entityA.ownerId) {
        const player = this.getPlayer(entityA.ownerId);
        if (player) player.score += massB;
      }
    } else if (massB > massA) {
      // B consumes A
      agarB.mass = (agarB.mass || this.initialMass) + massA;
      this.despawnEntity(entityA.id);

      // Award score to consuming player
      if (entityB.ownerId) {
        const player = this.getPlayer(entityB.ownerId);
        if (player) player.score += massA;
      }
    }
  }

  /**
   * Periodically spawn food throughout the game area
   */
  private spawnFoodPeriodically(): void {
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
          isFood: true,
        });
      }
      this.lastFoodSpawn = 0;
    }
  }

  /**
   * Update player scores based on entity mass
   */
  private updatePlayerScores(): void {
    for (const player of this.getPlayers()) {
      if (player.entityId) {
        const entity = this.getEntity(player.entityId);
        if (entity) {
          const agarEntity = entity as AgarEntity;
          // Initial score from start; additional from consumption
          player.score = Math.max(player.score, (agarEntity.mass || 0) - this.initialMass);
        }
      }
    }
  }

  // ============================================================================
  // INPUT HANDLING
  // ============================================================================

  /**
   * Apply player input to their entity
   * Input: moveX, moveY in range [-1, 1]
   * Apply acceleration based on available mass
   */
  protected onPlayerInput(
    playerId: string,
    inputFrame: InputFrame
  ): void {
    const player = this.getPlayer(playerId);
    if (!player || !player.entityId) return;

    const entity = this.getEntity(player.entityId) as AgarEntity;
    if (!entity || !entity.isAlive) return;

    const mass = entity.mass || this.initialMass;
    const baseSpeed = 2.0;

    // Speed inversely scales with mass: speed = baseSpeed * sqrt(initialMass / mass)
    const speed =
      baseSpeed * Math.sqrt(this.initialMass / Math.max(1, mass));

    // Apply input
    const acceleration = 0.3; // Smooth acceleration
    entity.vx += inputFrame.moveX * speed * acceleration;
    entity.vy += inputFrame.moveY * speed * acceleration;

    // Cap maximum velocity to prevent exploits
    const maxVelocity = speed * 1.5;
    const velocityMagnitude = Math.sqrt(
      entity.vx * entity.vx + entity.vy * entity.vy
    );
    if (velocityMagnitude > maxVelocity) {
      entity.vx = (entity.vx / velocityMagnitude) * maxVelocity;
      entity.vy = (entity.vy / velocityMagnitude) * maxVelocity;
    }

    // Update angle to face direction of movement
    if (entity.vx !== 0 || entity.vy !== 0) {
      entity.angle = Math.atan2(entity.vy, entity.vx) * (180 / Math.PI);
    }
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Convert mass to visual radius
   * Radius roughly proportional to sqrt(mass)
   */
  private massToRadius(mass: number): number {
    return Math.sqrt(mass);
  }

  /**
   * Get random color for visual representation
   */
  private getRandomColor(): string {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
      '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2',
      '#F8B739', '#52C4CD', '#FF8B5B', '#7FD8BE',
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  /**
   * Get game state with Agar-specific properties
   */
  public getState(): any {
    const state = super.getState();
    return {
      ...state,
      gameAreaWidth: this.gameAreaWidth,
      gameAreaHeight: this.gameAreaHeight,
      entities: this.getEntities().map((entity) => ({
        ...entity,
        radius: this.massToRadius((entity as AgarEntity).mass || this.initialMass),
      })),
    };
  }
}
