/**
 * BinaryProtocol - MessagePack-style binary serialization with fixed-point math
 * 
 * Format:
 * - State Update: [Header 0xAA][Tick 4B][NumEntities 1B][Entity...]*
 * - Per Entity: [ID 2B][X 4B fixed][Y 4B fixed][Vx 1B compressed][Vy 1B compressed]
 *              [Angle 1B][Flags 1B][Score 2B] = 20 bytes per entity
 * - Input: [Header 0xBB][Tick 4B][MoveX 1B][MoveY 1B][Action 1B][Timestamp 4B] = 12 bytes
 * 
 * Compression Tactics:
 * - Fixed-point: x stored as int32 × 0.001 (range: ±2.1B units, 0.001 precision)
 * - Velocity: clamped to int8 (-100 to 100 units/frame)
 * - Angle: quantized to uint8 (0-255 → 0-360°, 1.4° precision)
 * - Flags: bit-packed (isAlive, isPlayer, isFood = 3 bits)
 */

export interface Entity {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  isAlive: boolean;
  isPlayer: boolean;
  ownerId?: string;
  score?: number;
  [key: string]: any;
}

export interface InputFrame {
  tick: number;
  moveX: number;
  moveY: number;
  action: number;
  timestamp: number;
}

export interface StateUpdate {
  tick: number;
  entities: Entity[];
  playerCount?: number;
}

export class BinaryProtocol {
  private static readonly STATE_HEADER = 0xaa;
  private static readonly INPUT_HEADER = 0xbb;
  private static readonly FIXED_POINT_SCALE = 1000;
  private static readonly VELOCITY_MAX = 100;

  // ============================================================================
  // STATE UPDATE ENCODING (Server → Client)
  // ============================================================================

  /**
   * Encode game state update to binary buffer
   * Format: [0xAA (1B)][Tick (4B)][NumEntities (1B)][Entity...]*
   */
  public static encodeStateUpdate(stateUpdate: StateUpdate): Buffer {
    const entities = stateUpdate.entities || [];
    const maxEntities = Math.min(entities.length, 255); // 1 byte for count

    // Allocate buffer: 1 + 4 + 1 + (maxEntities * 20)
    const buffer = Buffer.alloc(6 + maxEntities * 20);
    let offset = 0;

    // Header
    buffer.writeUInt8(this.STATE_HEADER, offset);
    offset += 1;

    // Tick
    buffer.writeUInt32LE(stateUpdate.tick, offset);
    offset += 4;

    // Entity count
    buffer.writeUInt8(maxEntities, offset);
    offset += 1;

    // Encode entities
    for (let i = 0; i < maxEntities; i++) {
      const entity = entities[i];
      offset = this.encodeEntity(entity, buffer, offset);
    }

    return buffer.slice(0, offset);
  }

  /**
   * Encode single entity to buffer at offset
   * Returns new offset
   */
  private static encodeEntity(
    entity: Entity,
    buffer: Buffer,
    offset: number
  ): number {
    // ID (2 bytes)
    const idNum = parseInt(entity.id.replace(/\D/g, ''), 10) || 0;
    buffer.writeUInt16LE(idNum & 0xffff, offset);
    offset += 2;

    // X (4 bytes, fixed-point)
    const xFixed = Math.round(entity.x * this.FIXED_POINT_SCALE);
    buffer.writeInt32LE(xFixed, offset);
    offset += 4;

    // Y (4 bytes, fixed-point)
    const yFixed = Math.round(entity.y * this.FIXED_POINT_SCALE);
    buffer.writeInt32LE(yFixed, offset);
    offset += 4;

    // Vx (1 byte, clamped int8)
    const vx = Math.max(-128, Math.min(127, Math.round(entity.vx)));
    buffer.writeInt8(vx, offset);
    offset += 1;

    // Vy (1 byte, clamped int8)
    const vy = Math.max(-128, Math.min(127, Math.round(entity.vy)));
    buffer.writeInt8(vy, offset);
    offset += 1;

    // Angle (1 byte, quantized to 0-255)
    const angle = (Math.round((entity.angle % 360) / 360 * 255) & 0xff);
    buffer.writeUInt8(angle, offset);
    offset += 1;

    // Flags (1 byte: bit0=isAlive, bit1=isPlayer, bit2=isFood)
    const flags =
      ((entity.isAlive ? 1 : 0) << 0) |
      ((entity.isPlayer ? 1 : 0) << 1) |
      (((entity as any).isFood ? 1 : 0) << 2);
    buffer.writeUInt8(flags, offset);
    offset += 1;

    // Score (2 bytes, uint16)
    const score = entity.score || 0;
    buffer.writeUInt16LE(Math.max(0, Math.min(65535, score)), offset);
    offset += 2;

    return offset;
  }

  // ============================================================================
  // STATE UPDATE DECODING (Client receives)
  // ============================================================================

  /**
   * Decode binary state update buffer
   */
  public static decodeStateUpdate(buffer: Buffer): StateUpdate | null {
    if (buffer.length < 6) {
      return null; // Invalid: too short
    }

    let offset = 0;

    // Verify header
    const header = buffer.readUInt8(offset);
    if (header !== this.STATE_HEADER) {
      return null; // Wrong magic byte
    }
    offset += 1;

    // Read tick
    const tick = buffer.readUInt32LE(offset);
    offset += 4;

    // Read entity count
    const entityCount = buffer.readUInt8(offset);
    offset += 1;

    // Verify buffer size
    const expectedSize = 6 + entityCount * 20;
    if (buffer.length < expectedSize) {
      return null; // Truncated buffer
    }

    // Decode entities
    const entities: Entity[] = [];
    for (let i = 0; i < entityCount; i++) {
      const entity = this.decodeEntity(buffer, offset);
      if (entity) {
        entities.push(entity);
        offset += 20;
      }
    }

    return { tick, entities };
  }

  /**
   * Decode single entity from buffer at offset
   */
  private static decodeEntity(buffer: Buffer, offset: number): Entity | null {
    try {
      // ID (2 bytes)
      const idNum = buffer.readUInt16LE(offset);
      const id = `entity_${idNum}`;

      // X (4 bytes, fixed-point)
      const xFixed = buffer.readInt32LE(offset + 2);
      const x = xFixed / this.FIXED_POINT_SCALE;

      // Y (4 bytes, fixed-point)
      const yFixed = buffer.readInt32LE(offset + 6);
      const y = yFixed / this.FIXED_POINT_SCALE;

      // Vx (1 byte)
      const vx = buffer.readInt8(offset + 10);

      // Vy (1 byte)
      const vy = buffer.readInt8(offset + 11);

      // Angle (1 byte, quantized)
      const angleQuantized = buffer.readUInt8(offset + 12);
      const angle = (angleQuantized / 255) * 360;

      // Flags (1 byte)
      const flags = buffer.readUInt8(offset + 13);
      const isAlive = (flags & (1 << 0)) !== 0;
      const isPlayer = (flags & (1 << 1)) !== 0;
      const isFood = (flags & (1 << 2)) !== 0;

      // Score (2 bytes)
      const score = buffer.readUInt16LE(offset + 14);

      return {
        id,
        x,
        y,
        vx,
        vy,
        angle: angle % 360,
        isAlive,
        isPlayer,
        score,
        isFood,
      };
    } catch {
      return null;
    }
  }

  // ============================================================================
  // INPUT ENCODING (Client → Server)
  // ============================================================================

  /**
   * Encode input frame to binary buffer
   * Format: [0xBB (1B)][Tick (4B)][MoveX (1B)][MoveY (1B)][Action (1B)][Timestamp (4B)]
   */
  public static encodeInput(inputFrame: InputFrame): Buffer {
    const buffer = Buffer.alloc(12);
    let offset = 0;

    // Header
    buffer.writeUInt8(this.INPUT_HEADER, offset);
    offset += 1;

    // Tick
    buffer.writeUInt32LE(inputFrame.tick, offset);
    offset += 4;

    // MoveX (-1, 0, +1) → stored as 0, 1, 2
    buffer.writeUInt8(inputFrame.moveX + 1, offset);
    offset += 1;

    // MoveY
    buffer.writeUInt8(inputFrame.moveY + 1, offset);
    offset += 1;

    // Action
    buffer.writeUInt8(inputFrame.action & 0xff, offset);
    offset += 1;

    // Timestamp
    buffer.writeUInt32LE(inputFrame.timestamp & 0xffffffff, offset);
    offset += 4;

    return buffer;
  }

  // ============================================================================
  // INPUT DECODING (Server receives)
  // ============================================================================

  /**
   * Decode input frame from binary buffer
   */
  public static decodeInput(buffer: Buffer): InputFrame | null {
    if (buffer.length < 12) {
      return null; // Invalid: too short
    }

    let offset = 0;

    // Verify header
    const header = buffer.readUInt8(offset);
    if (header !== this.INPUT_HEADER) {
      return null; // Wrong magic byte
    }
    offset += 1;

    // Tick
    const tick = buffer.readUInt32LE(offset);
    offset += 4;

    // MoveX
    const moveX = buffer.readUInt8(offset) - 1; // Convert 0,1,2 back to -1,0,+1
    offset += 1;

    // MoveY
    const moveY = buffer.readUInt8(offset) - 1;
    offset += 1;

    // Action
    const action = buffer.readUInt8(offset);
    offset += 1;

    // Timestamp
    const timestamp = buffer.readUInt32LE(offset);

    return { tick, moveX, moveY, action, timestamp };
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Get estimated bytes for state update encoding
   */
  public static estimateStateUpdateSize(entityCount: number): number {
    return 6 + entityCount * 20;
  }

  /**
   * Get estimated bytes for input encoding
   */
  public static estimateInputSize(): number {
    return 12;
  }

  /**
   * Convert angle to encoded uint8
   */
  public static encodeAngle(angle: number): number {
    return Math.round(((angle % 360) / 360) * 255) & 0xff;
  }

  /**
   * Convert encoded uint8 angle back to degrees
   */
  public static decodeAngle(encoded: number): number {
    return (encoded / 255) * 360;
  }

  /**
   * Convert coordinate to fixed-point int32
   */
  public static encodeCoordinate(value: number): number {
    return Math.round(value * this.FIXED_POINT_SCALE);
  }

  /**
   * Convert fixed-point int32 back to coordinate
   */
  public static decodeCoordinate(fixed: number): number {
    return fixed / this.FIXED_POINT_SCALE;
  }
}
