import { AbstractGameRoom, InputFrame, Entity } from './game-room';

/**
 * RacingRoom - Racing/Driving game mode
 * 
 * Game Rules:
 * - Players control vehicles with physics (acceleration, friction, steering)
 * - Drive through checkpoints to gain speed/score
 * - Collide with walls = bounce/slow down
 * - Collide with other vehicles = bounce apart
 * - Score = checkpoints collected
 * 
 * Physics:
 * - Acceleration up to max speed
 * - Friction/damping (0.98x per frame)
 * - Turning radius (max steering angle 30°)
 * - Drift mode (reduce friction when turning + accelerating)
 * - Boundary walls (wrap or bounce)
 */

interface VehicleEntity extends Entity {
  maxSpeed?: number; // Top speed
  acceleration?: number; // Units/frame² per frame
  friction?: number; // Damping factor
  steeringAngle?: number; // Current steering angle
  maxSteeringAngle?: number; // Max turn angle
  isDrifting?: boolean; // Drift mode active
  checkpointsCollected?: number; // Score (checkpoint count)
}

interface RacingConfig {
  gameAreaWidth?: number;
  gameAreaHeight?: number;
  maxPlayers?: number;
  vehicleMaxSpeed?: number;
  vehicleAcceleration?: number;
  vehicleFriction?: number;
  vehicleMaxSteeringAngle?: number;
  checkpointSpawnInterval?: number;
  checkpointsPerSpawn?: number;
}

export class RacingRoom extends AbstractGameRoom {
  private lastCheckpointSpawn: number = 0;
  private gameAreaWidth: number;
  private gameAreaHeight: number;
  private checkpointSpawnInterval: number;
  private checkpointsPerSpawn: number;
  private vehicleMaxSpeed: number;
  private vehicleAcceleration: number;
  private vehicleFriction: number;
  private vehicleMaxSteeringAngle: number;

  constructor(roomId: string, config: RacingConfig = {}) {
    super(roomId, 'racing', {
      maxPlayers: config.maxPlayers || 20,
      tickRate: 60,
      inputBufferSize: 3,
      ...config,
    });

    this.gameAreaWidth = config.gameAreaWidth || 10000;
    this.gameAreaHeight = config.gameAreaHeight || 10000;
    this.checkpointSpawnInterval = config.checkpointSpawnInterval || 120; // Every 2 seconds
    this.checkpointsPerSpawn = config.checkpointsPerSpawn || 3;
    this.vehicleMaxSpeed = config.vehicleMaxSpeed || 5.0;
    this.vehicleAcceleration = config.vehicleAcceleration || 0.15;
    this.vehicleFriction = config.vehicleFriction || 0.98;
    this.vehicleMaxSteeringAngle = config.vehicleMaxSteeringAngle || 30; // Degrees
  }

  // ============================================================================
  // PLAYER JOINING - Spawn vehicle
  // ============================================================================

  /**
   * Override addPlayer to spawn vehicle
   */
  public addPlayer(playerId: string, username: string): boolean {
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
      isFood: false,
    }) as VehicleEntity;

    const player = this.getPlayer(playerId);
    if (player) {
      player.entityId = vehicle.id;
      player.score = 0;
    }

    return true;
  }

  // ============================================================================
  // GAME LOOP (tick)
  // ============================================================================

  /**
   * Physics: acceleration, steering, friction, collisions
   */
  protected async tick(): Promise<void> {
    // 1. Apply vehicle physics (steering, acceleration, friction)
    this.updateVehiclePhysics();

    // 2. Check checkpoint collisions (scoring)
    this.detectCheckpointCollisions();

    // 3. Check vehicle-to-vehicle collisions (bouncing)
    this.detectVehicleCollisions();

    // 4. Check boundary collisions (bouncing)
    this.detectBoundaryCollisions();

    // 5. Spawn checkpoints periodically
    this.spawnCheckpointsPeriodically();
  }

  /**
   * Update vehicle physics: steering, acceleration, friction
   */
  private updateVehiclePhysics(): void {
    for (const entity of this.getEntities()) {
      if (!entity.isAlive || !entity.isPlayer) continue;

      const vehicle = entity as VehicleEntity;
      const maxSpeed = vehicle.maxSpeed || this.vehicleMaxSpeed;
      const accel = vehicle.acceleration || this.vehicleAcceleration;
      const friction = vehicle.friction || this.vehicleFriction;

      // Apply steering: rotate velocity vector based on steering angle
      const steeringAngle = vehicle.steeringAngle || 0;
      if (steeringAngle !== 0) {
        const steeringRadians = (steeringAngle * Math.PI) / 180;

        // Rotate velocity vector by steering angle
        const speed = Math.sqrt(entity.vx * entity.vx + entity.vy * entity.vy);
        if (speed > 0.1) {
          const currentAngle = Math.atan2(entity.vy, entity.vx);
          const newAngle = currentAngle + steeringRadians * 0.05; // Gradual steering

          entity.vx = Math.cos(newAngle) * speed;
          entity.vy = Math.sin(newAngle) * speed;
          entity.angle = (newAngle * 180) / Math.PI;
        }
      }

      // Apply friction/damping
      entity.vx *= friction;
      entity.vy *= friction;

      // Update position
      entity.x += entity.vx;
      entity.y += entity.vy;

      // Boundary wrapping
      if (entity.x < 0) entity.x += this.gameAreaWidth;
      if (entity.x >= this.gameAreaWidth) entity.x -= this.gameAreaWidth;
      if (entity.y < 0) entity.y += this.gameAreaHeight;
      if (entity.y >= this.gameAreaHeight) entity.y -= this.gameAreaHeight;

      // Stop if speed is negligible
      const speed = Math.sqrt(entity.vx * entity.vx + entity.vy * entity.vy);
      if (speed < 0.01) {
        entity.vx = 0;
        entity.vy = 0;
      }
    }
  }

  /**
   * Check if vehicle collects checkpoint
   */
  private detectCheckpointCollisions(): void {
    const entities = this.getEntities();

    for (const vehicle of entities) {
      if (!vehicle.isAlive || !vehicle.isPlayer) continue;

      const vehicleRadius = 1.5;

      for (const checkpoint of entities) {
        if (!checkpoint.isAlive || checkpoint.isPlayer) continue;

        const checkpointRadius = 2.0;
        const dist = this.distance(
          vehicle.x,
          vehicle.y,
          checkpoint.x,
          checkpoint.y
        );

        if (dist < vehicleRadius + checkpointRadius) {
          // Collect checkpoint
          this.collectCheckpoint(vehicle, checkpoint);
        }
      }
    }
  }

  /**
   * Vehicle collects checkpoint (boost + score)
   */
  private collectCheckpoint(vehicle: Entity, checkpoint: Entity): void {
    const vehicleObj = vehicle as VehicleEntity;
    const maxSpeed = vehicleObj.maxSpeed || this.vehicleMaxSpeed;

    // Boost velocity when collecting checkpoint
    const speed = Math.sqrt(vehicle.vx * vehicle.vx + vehicle.vy * vehicle.vy);
    if (speed < maxSpeed) {
      const boostFactor = 1.2; // 20% speed boost
      vehicle.vx *= boostFactor;
      vehicle.vy *= boostFactor;
    }

    // Award checkpoint + score
    vehicleObj.checkpointsCollected = (vehicleObj.checkpointsCollected || 0) + 1;

    const player = this.getPlayer(vehicle.ownerId || '');
    if (player) {
      player.score += 10; // 10 points per checkpoint
    }

    // Remove checkpoint
    this.despawnEntity(checkpoint.id);
  }

  /**
   * Vehicle-to-vehicle collision (bouncing)
   */
  private detectVehicleCollisions(): void {
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
          // Bounce vehicles apart
          this.bounceVehicles(vehicle1, vehicle2);
        }
      }
    }
  }

  /**
   * Bounce two vehicles apart
   */
  private bounceVehicles(vehicle1: Entity, vehicle2: Entity): void {
    // Calculate collision normal
    const dx = vehicle2.x - vehicle1.x;
    const dy = vehicle2.y - vehicle1.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist === 0) return;

    const nx = dx / dist;
    const ny = dy / dist;

    // Swap velocity components along collision normal (elastic bounce)
    const v1n = vehicle1.vx * nx + vehicle1.vy * ny;
    const v2n = vehicle2.vx * nx + vehicle2.vy * ny;

    // Only bounce if moving toward each other
    if (v1n - v2n >= 0) return;

    vehicle1.vx += (v2n - v1n) * nx * 0.5;
    vehicle1.vy += (v2n - v1n) * ny * 0.5;

    vehicle2.vx += (v1n - v2n) * nx * 0.5;
    vehicle2.vy += (v1n - v2n) * ny * 0.5;

    // Separate vehicles to prevent overlap
    const overlap = 1.5 + 1.5 - dist;
    vehicle1.x -= (overlap / 2) * nx;
    vehicle1.y -= (overlap / 2) * ny;

    vehicle2.x += (overlap / 2) * nx;
    vehicle2.y += (overlap / 2) * ny;
  }

  /**
   * Detect boundary collisions (optional: could enable walls instead of wraparound)
   */
  private detectBoundaryCollisions(): void {
    // Currently using wraparound. Could add optional walls:
    // if (entity.x < WALL_WIDTH) { entity.vx *= -0.8; entity.x = WALL_WIDTH; }
  }

  /**
   * Periodically spawn checkpoints throughout the game area
   */
  private spawnCheckpointsPeriodically(): void {
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
          isFood: false,
        });
      }
      this.lastCheckpointSpawn = 0;
    }
  }

  // ============================================================================
  // INPUT HANDLING
  // ============================================================================

  /**
   * Apply player input: acceleration + steering
   * Input: moveX (steering -1 to +1), moveY (acceleration -1 to +1)
   */
  protected onPlayerInput(playerId: string, inputFrame: InputFrame): void {
    const player = this.getPlayer(playerId);
    if (!player || !player.entityId) return;

    const entity = this.getEntity(player.entityId) as VehicleEntity;
    if (!entity || !entity.isAlive) return;

    const maxSpeed = entity.maxSpeed || this.vehicleMaxSpeed;
    const accel = entity.acceleration || this.vehicleAcceleration;
    const maxSteeringAngle = entity.maxSteeringAngle || this.vehicleMaxSteeringAngle;

    // Steering input
    entity.steeringAngle = inputFrame.moveX * maxSteeringAngle;

    // Acceleration input
    if (inputFrame.moveY > 0) {
      // Forward acceleration
      const currentSpeed = Math.sqrt(entity.vx * entity.vx + entity.vy * entity.vy);
      if (currentSpeed < maxSpeed) {
        const angle = entity.angle * (Math.PI / 180);
        entity.vx += Math.cos(angle) * accel * inputFrame.moveY;
        entity.vy += Math.sin(angle) * accel * inputFrame.moveY;
      }
    } else if (inputFrame.moveY < 0) {
      // Reverse/braking
      entity.vx *= 0.95; // Rapid deceleration
      entity.vy *= 0.95;
    }

    // Drift mode (pressing action button)
    entity.isDrifting = inputFrame.action > 0;
  }

  // ============================================================================
  // STATE SERIALIZATION
  // ============================================================================

  /**
   * Get game state with vehicle properties
   */
  public getState(): any {
    const state = super.getState();
    return {
      ...state,
      gameAreaWidth: this.gameAreaWidth,
      gameAreaHeight: this.gameAreaHeight,
      entities: this.getEntities().map((entity) => {
        const vehicle = entity as VehicleEntity;
        return {
          ...entity,
          steeringAngle: entity.isPlayer ? vehicle.steeringAngle : undefined,
          isDrifting: entity.isPlayer ? vehicle.isDrifting : undefined,
          checkpointsCollected: entity.isPlayer
            ? vehicle.checkpointsCollected
            : undefined,
        };
      }),
    };
  }
}
