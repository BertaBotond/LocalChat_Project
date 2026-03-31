import { AbstractGameRoom, InputFrame, Entity } from './game-room';

/**
 * FlappyRoom - Flappy Bird-style platformer
 * 
 * Game Rules:
 * - Players control a character with gravity-based jumping
 * - Tap to jump (upward velocity boost)
 * - Dodge falling obstacles/pipes
 * - Collect power-ups for invincibility/speed
 * - Collide with obstacle = lose life or death
 * - Score = distance traveled or obstacles cleared
 * 
 * Physics:
 * - Constant downward gravity acceleration
 * - Jump adds upward velocity impulse
 * - Max gravity speed clamping
 * - Collision with obstacles = damage
 */

interface PlayerEntity extends Entity {
  velocityY?: number; // Vertical velocity (gravity)
  gravity?: number; // Gravity acceleration per frame
  jumpForce?: number; // Upward velocity on jump
  isJumping?: boolean; // Currently in jump state
  lives?: number; // HP / lives remaining
  isInvincible?: boolean; // Invincibility frames
  invincibilityCounter?: number; // Countdown for invincibility
  distanceTraveled?: number; // Score metric
}

interface ObstacleEntity extends Entity {
  obstacleType?: 'pipe' | 'spike' | 'wall'; // Type of obstacle
  damage?: number; // Damage on collision
  isMoving?: boolean; // Whether it moves
  moveDirection?: 'left' | 'right' | 'down' | 'up';
  moveSpeed?: number; // Units per frame
}

interface FlappyConfig {
  gameAreaWidth?: number;
  gameAreaHeight?: number;
  maxPlayers?: number;
  playerGravity?: number;
  playerJumpForce?: number;
  playerMaxVerticalVelocity?: number;
  initialLives?: number;
  obstacleSpawnRate?: number;
  obstacleTypes?: string[];
  difficultyScaling?: number; // Increase speed over time
}

export class FlappyRoom extends AbstractGameRoom {
  private lastObstacleSpawn: number = 0;
  private gameAreaWidth: number;
  private gameAreaHeight: number;
  private playerGravity: number;
  private playerJumpForce: number;
  private playerMaxVerticalVelocity: number;
  private initialLives: number;
  private obstacleSpawnRate: number;
  private obstacleTypes: string[];
  private difficultyScaling: number;

  constructor(roomId: string, config: FlappyConfig = {}) {
    super(roomId, 'flappy', {
      maxPlayers: config.maxPlayers || 20,
      tickRate: 60,
      inputBufferSize: 3,
      ...config,
    });

    this.gameAreaWidth = config.gameAreaWidth || 10000;
    this.gameAreaHeight = config.gameAreaHeight || 8000;
    this.playerGravity = config.playerGravity || 0.3; // Units/frame² downward
    this.playerJumpForce = config.playerJumpForce || 7.0; // Upward velocity impulse
    this.playerMaxVerticalVelocity = config.playerMaxVerticalVelocity || 15.0; // Terminal velocity
    this.initialLives = config.initialLives || 3;
    this.obstacleSpawnRate = config.obstacleSpawnRate || 90; // Spawn every 1.5 seconds at 60Hz
    this.obstacleTypes = config.obstacleTypes || ['pipe', 'spike'];
    this.difficultyScaling = config.difficultyScaling || 0.001; // Increase speed 0.1% per frame
  }

  // ============================================================================
  // PLAYER JOINING - Spawn player in gravity field
  // ============================================================================

  /**
   * Override addPlayer to spawn player character
   */
  public addPlayer(playerId: string, username: string): boolean {
    const added = super.addPlayer(playerId, username);
    if (!added) return false;

    // Spawn at left-center of screen
    const x = this.gameAreaWidth * 0.2;
    const y = this.gameAreaHeight / 2;

    const player = this.spawnEntity({
      x,
      y,
      vx: 2.0, // Constant forward drift
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
      isFood: false,
    }) as PlayerEntity;

    const playerObj = this.getPlayer(playerId);
    if (playerObj) {
      playerObj.entityId = player.id;
      playerObj.score = 0;
    }

    return true;
  }

  // ============================================================================
  // GAME LOOP (tick)
  // ============================================================================

  /**
   * Physics: gravity, jumping, forward movement, obstacles, collisions
   */
  protected async tick(): Promise<void> {
    // 1. Apply gravity physics to all players
    this.applyGravity();

    // 2. Update player positions and distance
    this.updatePlayerMovement();

    // 3. Spawn obstacles periodically
    this.spawnObstaclesPeriodically();

    // 4. Move existing obstacles
    this.updateObstacleMovement();

    // 5. Check player-to-obstacle collisions
    this.detectCollisions();

    // 6. Remove off-screen entities
    this.cleanupOffscreenEntities();

    // 7. Check if any players died
    this.checkGameOverConditions();
  }

  /**
   * Apply gravity physics
   */
  private applyGravity(): void {
    for (const entity of this.getEntities()) {
      if (!entity.isAlive || !entity.isPlayer) continue;

      const player = entity as PlayerEntity;
      const gravity = player.gravity || this.playerGravity;
      const maxVel = player.maxVerticalVelocity || this.playerMaxVerticalVelocity;

      // Apply gravity acceleration
      player.velocityY = (player.velocityY || 0) + gravity;

      // Clamp terminal velocity
      player.velocityY = Math.max(
        -maxVel,
        Math.min(maxVel, player.velocityY)
      );

      // Update Y position
      entity.y += player.velocityY;

      // Boundary: crash at bottom
      if (entity.y > this.gameAreaHeight) {
        player.lives = (player.lives || 1) - 1;
        entity.y = this.gameAreaHeight;
        player.velocityY = 0;
        player.isJumping = false;

        if (player.lives <= 0) {
          entity.isAlive = false;
          this.emit('playerDeath', {
            playerId: entity.ownerId,
            reason: 'fell-bottom'
          });
        }
      }

      // Boundary: crash at top
      if (entity.y < 0) {
        player.lives = (player.lives || 1) - 1;
        entity.y = 0;
        player.velocityY = 0;
        player.isJumping = false;

        if (player.lives <= 0) {
          entity.isAlive = false;
          this.emit('playerDeath', {
            playerId: entity.ownerId,
            reason: 'hit-ceiling'
          });
        }
      }
    }
  }

  /**
   * Update player forward movement and scoring
   */
  private updatePlayerMovement(): void {
    for (const entity of this.getEntities()) {
      if (!entity.isAlive || !entity.isPlayer) continue;

      const player = entity as PlayerEntity;
      const baseSpeed = 2.0;
      const speedBoost = 1.0 + this.currentTick * this.difficultyScaling; // Gradual difficulty increase

      // Constant forward movement (scrolling)
      entity.x += baseSpeed * speedBoost;

      // Update distance traveled for scoring
      player.distanceTraveled = (player.distanceTraveled || 0) + baseSpeed * speedBoost;

      const playerObj = this.getPlayer(entity.ownerId || '');
      if (playerObj) {
        playerObj.score = Math.floor(player.distanceTraveled / 100); // 1 point per 100 units
      }

      // Decrement invincibility frames
      if (player.isInvincible && player.invincibilityCounter) {
        player.invincibilityCounter--;
        if (player.invincibilityCounter <= 0) {
          player.isInvincible = false;
        }
      }
    }
  }

  /**
   * Periodically spawn obstacles
   */
  private spawnObstaclesPeriodically(): void {
    this.lastObstacleSpawn++;

    if (this.lastObstacleSpawn >= this.obstacleSpawnRate) {
      const typeIndex = Math.floor(Math.random() * this.obstacleTypes.length);
      const obstacleType = this.obstacleTypes[typeIndex];

      // Spawn at right edge, random vertical position
      const x = this.gameAreaWidth;
      const y = Math.random() * (this.gameAreaHeight - 200) + 100;

      this.spawnEntity({
        x,
        y,
        vx: -3.0, // Move left toward players
        vy: 0,
        angle: 0,
        isPlayer: false,
        obstacleType: obstacleType as 'pipe' | 'spike' | 'wall',
        damage: 1,
        moveDirection: 'left',
        moveSpeed: 3.0,
        isFood: false,
      });

      this.lastObstacleSpawn = 0;
    }
  }

  /**
   * Update obstacle movement
   */
  private updateObstacleMovement(): void {
    const speedBoost = 1.0 + this.currentTick * this.difficultyScaling;

    for (const entity of this.getEntities()) {
      if (entity.isAlive && !entity.isPlayer) {
        const obstacle = entity as ObstacleEntity;
        const moveDir = obstacle.moveDirection || 'left';
        const moveSpeed = (obstacle.moveSpeed || 3.0) * speedBoost;

        if (moveDir === 'left') {
          entity.x -= moveSpeed;
        }
      }
    }
  }

  /**
   * Check player-to-obstacle collisions
   */
  private detectCollisions(): void {
    const entities = this.getEntities();

    for (const player of entities) {
      if (!player.isAlive || !player.isPlayer) continue;

      const playerObj = player as PlayerEntity;
      const playerRadius = 2.0;

      for (const obstacle of entities) {
        if (!obstacle.isAlive || obstacle.isPlayer) continue;

        const obstacleRadius = 2.5;
        const dist = this.distance(player.x, player.y, obstacle.x, obstacle.y);

        if (dist < playerRadius + obstacleRadius) {
          if (!playerObj.isInvincible) {
            // Take damage
            playerObj.lives = (playerObj.lives || 1) - 1;
            playerObj.isInvincible = true;
            playerObj.invincibilityCounter = 120; // 2 seconds at 60Hz

            if (playerObj.lives <= 0) {
              player.isAlive = false;
              this.emit('playerDeath', {
                playerId: player.ownerId,
                reason: 'hit-obstacle'
              });
            }

            // Push player, remove obstacle
            this.despawnEntity(obstacle.id);
          }
        }
      }
    }
  }

  /**
   * Remove entities that moved off-screen
   */
  private cleanupOffscreenEntities(): void {
    const entities = this.getEntities();

    for (const entity of entities) {
      if (entity.isPlayer) continue;

      // Remove obstacles that have scrolled off-screen
      if (entity.x < -500 || entity.x > this.gameAreaWidth + 500) {
        this.despawnEntity(entity.id);
      }
    }
  }

  /**
   * Check if all players are dead
   */
  private checkGameOverConditions(): void {
    const alivePlayers = Array.from(this.getPlayers()).filter((p) =>
      this.getEntity(p.entityId || '')?.isAlive
    );

    if (alivePlayers.length === 0 && this.getPlayers().length > 0) {
      // All players dead - game over
      this.emit('gameOver', {
        survivors: 0,
        highestScore: Math.max(
          ...Array.from(this.getPlayers()).map((p) => p.score)
        ),
      });
    }
  }

  // ============================================================================
  // INPUT HANDLING
  // ============================================================================

  /**
   * Apply player input: jump
   * Action input (action > 0) triggers jump
   */
  protected onPlayerInput(playerId: string, inputFrame: InputFrame): void {
    const player = this.getPlayer(playerId);
    if (!player || !player.entityId) return;

    const entity = this.getEntity(player.entityId) as PlayerEntity;
    if (!entity || !entity.isAlive) return;

    // Jump on action input
    if (inputFrame.action > 0 && !entity.isJumping) {
      const jumpForce = entity.jumpForce || this.playerJumpForce;
      entity.velocityY = -jumpForce; // Negative = upward
      entity.isJumping = true;

      // Allow slight adjustment of trajectory with forward/back input
      // (moveX could tilt the jump, making platforming more skillful)
    }

    // Landing detection (optional)
    if (inputFrame.action === 0) {
      entity.isJumping = false;
    }
  }

  // ============================================================================
  // STATE SERIALIZATION
  // ============================================================================

  /**
   * Get game state with physics properties
   */
  public getState(): any {
    const state = super.getState();
    const speedBoost = 1.0 + this.currentTick * this.difficultyScaling;

    return {
      ...state,
      gameAreaWidth: this.gameAreaWidth,
      gameAreaHeight: this.gameAreaHeight,
      currentDifficulty: speedBoost,
      entities: this.getEntities().map((entity) => {
        const player = entity as PlayerEntity;
        return {
          ...entity,
          velocityY: entity.isPlayer ? player.velocityY : undefined,
          lives: entity.isPlayer ? player.lives : undefined,
          isInvincible: entity.isPlayer ? player.isInvincible : undefined,
          distanceTraveled: entity.isPlayer ? player.distanceTraveled : undefined,
          obstacleType: !entity.isPlayer
            ? (entity as ObstacleEntity).obstacleType
            : undefined,
        };
      }),
    };
  }
}
