import { AbstractGameRoom, InputFrame, Entity } from './game-room';

/**
 * SlitherRoom - Slither.io-style game mode
 * 
 * Game Rules:
 * - Players control a snake of segments (head + body)
 * - Snake moves forward continuously at constant speed
 * - Input changes heading direction (0-360°)
 * - Consume food pellets to grow (+1 segment)
 * - Head collision with boundary = death (or wrap)
 * - Head collision with obstacle = death
 * - Score = food consumed
 * 
 * Physics:
 * - Constant forward velocity (no acceleration/deceleration)
 * - Heading controlled by player input
 * - Segments follow path of head (fixed spacing)
 * - Smooth turning (heading lerp over 5 frames)
 */

interface SnakeSegment {
  id: string;
  x: number;
  y: number;
  angle: number;
}

interface SlitherEntity extends Entity {
  segmentCount?: number; // Snake length
  headX?: number; // Head position for segment tracking
  headY?: number;
  segments?: SnakeSegment[]; // Array of segment positions
  targetAngle?: number; // Direction player is aiming
}

interface SlitherConfig {
  gameAreaWidth?: number;
  gameAreaHeight?: number;
  maxPlayers?: number;
  snakeSpeed?: number; // Units per frame
  foodSpawnInterval?: number;
  foodPerSpawn?: number;
  initialSegments?: number; // Starting snake length
  segmentSpacing?: number; // Distance between segments
}

export class SlitherRoom extends AbstractGameRoom {
  private lastFoodSpawn: number = 0;
  private gameAreaWidth: number;
  private gameAreaHeight: number;
  private foodSpawnInterval: number;
  private foodPerSpawn: number;
  private snakeSpeed: number;
  private initialSegments: number;
  private segmentSpacing: number;

  constructor(roomId: string, config: SlitherConfig = {}) {
    super(roomId, 'slither', {
      maxPlayers: config.maxPlayers || 20,
      tickRate: 60,
      inputBufferSize: 3,
      ...config,
    });

    this.gameAreaWidth = config.gameAreaWidth || 10000;
    this.gameAreaHeight = config.gameAreaHeight || 10000;
    this.foodSpawnInterval = config.foodSpawnInterval || 80;
    this.foodPerSpawn = config.foodPerSpawn || 8;
    this.snakeSpeed = config.snakeSpeed || 3.5; // Units per frame
    this.initialSegments = config.initialSegments || 3;
    this.segmentSpacing = config.segmentSpacing || 2;
  }

  // ============================================================================
  // PLAYER JOINING - Spawn snake
  // ============================================================================

  /**
   * Override addPlayer to spawn snake entity
   */
  public addPlayer(playerId: string, username: string): boolean {
    const added = super.addPlayer(playerId, username);
    if (!added) return false;

    const x = Math.random() * this.gameAreaWidth;
    const y = Math.random() * this.gameAreaHeight;
    const startAngle = Math.random() * 360;

    // Create snake head entity
    const snakeEntity = this.spawnEntity({
      x,
      y,
      vx: 0,
      vy: 0,
      angle: startAngle,
      isPlayer: true,
      ownerId: playerId,
      segmentCount: this.initialSegments,
      segments: this.initializeSnakeSegments(x, y, startAngle, this.initialSegments),
      targetAngle: startAngle,
      isFood: false,
    }) as SlitherEntity;

    const player = this.getPlayer(playerId);
    if (player) {
      player.entityId = snakeEntity.id;
      player.score = 0;
    }

    return true;
  }

  /**
   * Initialize snake segment positions (head is at index 0)
   */
  private initializeSnakeSegments(
    headX: number,
    headY: number,
    angle: number,
    segmentCount: number
  ): SnakeSegment[] {
    const segments: SnakeSegment[] = [];
    const radians = (angle * Math.PI) / 180;

    for (let i = 0; i < segmentCount; i++) {
      const distance = i * this.segmentSpacing;
      const x = headX - Math.cos(radians) * distance;
      const y = headY - Math.sin(radians) * distance;

      segments.push({
        id: `segment_${i}`,
        x,
        y,
        angle,
      });
    }

    return segments;
  }

  // ============================================================================
  // GAME LOOP (tick)
  // ============================================================================

  /**
   * Physics: snake movement, food spawning, collision
   */
  protected async tick(): Promise<void> {
    // 1. Update snake heading (smooth lerp toward target)
    this.updateSnakeHeadings();

    // 2. Move snakes forward based on current heading
    this.moveSnakes();

    // 3. Check food collisions (head eating food)
    this.detectFoodCollisions();

    // 4. Check head-to-head collisions (death)
    this.detectHeadCollisions();

    // 5. Spawn food periodically
    this.spawnFoodPeriodically();
  }

  /**
   * Smooth heading transition (lerp toward target angle)
   */
  private updateSnakeHeadings(): void {
    for (const entity of this.getEntities()) {
      if (!entity.isAlive || !entity.isPlayer) continue;

      const snake = entity as SlitherEntity;
      const target = snake.targetAngle || entity.angle;
      const current = entity.angle;

      // Find shortest path to target angle
      let diff = target - current;
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;

      // Lerp 10% toward target per frame (smooth turning)
      const lerpFactor = 0.1;
      entity.angle = current + diff * lerpFactor;

      // Normalize angle to 0-360
      entity.angle = ((entity.angle % 360) + 360) % 360;
    }
  }

  /**
   * Move snake forward based on heading
   */
  private moveSnakes(): void {
    for (const entity of this.getEntities()) {
      if (!entity.isAlive || !entity.isPlayer) continue;

      const snake = entity as SlitherEntity;
      if (!snake.segments || snake.segments.length === 0) continue;

      const radians = (entity.angle * Math.PI) / 180;
      const dx = Math.cos(radians) * this.snakeSpeed;
      const dy = Math.sin(radians) * this.snakeSpeed;

      // Move head
      const head = snake.segments[0];
      head.x = (head.x + dx + this.gameAreaWidth) % this.gameAreaWidth;
      head.y = (head.y + dy + this.gameAreaHeight) % this.gameAreaHeight;
      head.angle = entity.angle;

      // Move body segments to follow head (smooth chaining)
      for (let i = 1; i < snake.segments.length; i++) {
        const curr = snake.segments[i];
        const prev = snake.segments[i - 1];

        // Move toward previous segment
        const dist = this.distance(
          curr.x,
          curr.y,
          prev.x,
          prev.y
        );

        if (dist > this.segmentSpacing) {
          const ratio = this.segmentSpacing / Math.max(0.1, dist);
          curr.x = curr.x + (prev.x - curr.x) * ratio;
          curr.y = curr.y + (prev.y - curr.y) * ratio;
          curr.angle = Math.atan2(prev.y - curr.y, prev.x - curr.x) * (180 / Math.PI);
        }
      }

      // Update entity position to head position
      entity.x = head.x;
      entity.y = head.y;
    }
  }

  /**
   * Check if snake head collides with food
   */
  private detectFoodCollisions(): void {
    const entities = this.getEntities();

    for (const snake of entities) {
      if (!snake.isAlive || !snake.isPlayer) continue;

      const slither = snake as SlitherEntity;
      if (!slither.segments || slither.segments.length === 0) continue;

      const headRadius = 1.5;
      const headSegment = slither.segments[0];

      for (const food of entities) {
        if (!food.isAlive || food.isPlayer) continue;

        const foodRadius = 1.0;
        const dist = this.distance(headSegment.x, headSegment.y, food.x, food.y);

        if (dist < headRadius + foodRadius) {
          // Consume food, grow snake
          this.consumeFood(snake, food);
        }
      }
    }
  }

  /**
   * Snake checks if its head hit another snake or obstacle
   */
  private detectHeadCollisions(): void {
    const entities = this.getEntities();

    for (const snake of entities) {
      if (!snake.isAlive || !snake.isPlayer) continue;

      const slither = snake as SlitherEntity;
      if (!slither.segments || slither.segments.length === 0) continue;

      const headSegment = slither.segments[0];
      const headRadius = 1.5;

      // Check collision with other snakes' body segments
      for (const otherSnake of entities) {
        if (otherSnake.id === snake.id || !otherSnake.isAlive || !otherSnake.isPlayer) continue;

        const otherSlither = otherSnake as SlitherEntity;
        if (!otherSlither.segments) continue;

        for (const segment of otherSlither.segments) {
          const dist = this.distance(headSegment.x, headSegment.y, segment.x, segment.y);
          if (dist < headRadius + 1.0) {
            // Head-to-body collision = death
            slither.segmentCount = 0;
            this.killSnake(snake);
            return;
          }
        }
      }

      // Check if head went off-map (optional: could allow wraparound)
      // For now, wraparound is handled in moveSnakes()
    }
  }

  /**
   * Snake eats food pellet
   */
  private consumeFood(snake: Entity, food: Entity): void {
    const slither = snake as SlitherEntity;

    // Remove food
    this.despawnEntity(food.id);

    // Add body segment to tail
    if (slither.segments && slither.segments.length > 0) {
      const tail = slither.segments[slither.segments.length - 1];
      slither.segments.push({
        id: `segment_${slither.segments.length}`,
        x: tail.x,
        y: tail.y,
        angle: tail.angle,
      });
      slither.segmentCount = (slither.segmentCount || 0) + 1;

      // Award score
      const player = this.getPlayer(snake.ownerId || '');
      if (player) {
        player.score += 1;
      }
    }
  }

  /**
   * Kill snake (reset to spawn)
   */
  private killSnake(snake: Entity): void {
    const slither = snake as SlitherEntity;
    slither.segmentCount = 0;
    snake.isAlive = false;

    // Respawn with delay or mark as dead
    const playerId = snake.ownerId;
    if (playerId) {
      const player = this.getPlayer(playerId);
      if (player) {
        // Optional: Auto-respawn after 2 seconds
        setTimeout(() => {
          if (player.id === playerId) {
            this.respawnSnake(playerId);
          }
        }, 2000);
      }
    }
  }

  /**
   * Respawn snake at random location
   */
  private respawnSnake(playerId: string): void {
    const entity = this.getEntity(
      this.getPlayer(playerId)?.entityId || ''
    );
    if (!entity) return;

    const x = Math.random() * this.gameAreaWidth;
    const y = Math.random() * this.gameAreaHeight;
    const angle = Math.random() * 360;

    entity.x = x;
    entity.y = y;
    entity.angle = angle;
    entity.isAlive = true;

    const slither = entity as SlitherEntity;
    slither.segmentCount = this.initialSegments;
    slither.segments = this.initializeSnakeSegments(
      x,
      y,
      angle,
      this.initialSegments
    );
    slither.targetAngle = angle;
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
          isFood: true,
          mass: 1,
        });
      }
      this.lastFoodSpawn = 0;
    }
  }

  // ============================================================================
  // INPUT HANDLING
  // ============================================================================

  /**
   * Apply player input: change snake heading
   * Input: moveX, moveY in range [-1, 1]
   */
  protected onPlayerInput(playerId: string, inputFrame: InputFrame): void {
    const player = this.getPlayer(playerId);
    if (!player || !player.entityId) return;

    const entity = this.getEntity(player.entityId) as SlitherEntity;
    if (!entity || !entity.isAlive) return;

    // Calculate target heading from input
    if (inputFrame.moveX !== 0 || inputFrame.moveY !== 0) {
      const targetAngle =
        Math.atan2(inputFrame.moveY, inputFrame.moveX) * (180 / Math.PI);
      entity.targetAngle = targetAngle;
    }
  }

  // ============================================================================
  // STATE SERIALIZATION
  // ============================================================================

  /**
   * Get game state with fish segments for rendering
   */
  public getState(): any {
    const state = super.getState();
    return {
      ...state,
      gameAreaWidth: this.gameAreaWidth,
      gameAreaHeight: this.gameAreaHeight,
      entities: this.getEntities().map((entity) => {
        const slither = entity as SlitherEntity;
        return {
          ...entity,
          segments: slither.isPlayer ? slither.segments : undefined,
          segmentCount: slither.segmentCount,
        };
      }),
    };
  }
}
