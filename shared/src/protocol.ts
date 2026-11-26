import {
  type PlayerInput,
  type WorldSnapshot,
  type SnapshotEntity,
  type ShipEntity,
  type BulletEntity,
  type AsteroidEntity,
  asEntityId,
  asSeqNumber,
  asTickNumber,
  assertNever
} from './types.ts';

export const PROTOCOL_VERSION = 1;
export const MSG_INPUT = 1;
export const MSG_SNAPSHOT = 2;

const ANGLE_SCALE = 32767 / Math.PI;

export function encodeAngleInt16(rad: number): number {
  let a = rad;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return Math.max(-32767, Math.min(32767, Math.round(a * ANGLE_SCALE)));
}

export function decodeAngleInt16(int16: number): number {
  return int16 / ANGLE_SCALE;
}

export function encodeInputBinary(input: PlayerInput): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, MSG_INPUT);
  view.setUint32(2, input.seq >>> 0, true);

  let flags = 0;
  if (input.left) flags |= 1;
  if (input.right) flags |= 2;
  if (input.thrust) flags |= 4;
  if (input.fire) flags |= 8;
  view.setUint8(6, flags);
  view.setUint8(7, (input.clientTs ?? 0) & 0xff);
  return buf;
}

export function decodeInputBinary(arrayBuffer: ArrayBuffer): PlayerInput {
  if (arrayBuffer.byteLength < 8) {
    throw new Error('Binary input too short');
  }
  const view = new DataView(arrayBuffer);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }
  const type = view.getUint8(1);
  if (type !== MSG_INPUT) {
    throw new Error(`Unexpected binary message type: ${type}`);
  }

  const seq = view.getUint32(2, true);
  const flags = view.getUint8(6);
  return {
    seq: asSeqNumber(seq),
    left: Boolean(flags & 1),
    right: Boolean(flags & 2),
    thrust: Boolean(flags & 4),
    fire: Boolean(flags & 8)
  };
}

export function encodeSnapshotBinary(snapshot: WorldSnapshot): ArrayBuffer {
  const ships: ShipEntity[] = [];
  const bullets: BulletEntity[] = [];
  const asteroids: AsteroidEntity[] = [];

  for (const entity of snapshot.entities) {
    switch (entity.kind) {
      case 'ship':
        ships.push(entity);
        break;
      case 'bullet':
        bullets.push(entity);
        break;
      case 'asteroid':
        asteroids.push(entity);
        break;
      default:
        assertNever(entity);
    }
  }

  const totalBytes = 17 + ships.length * 26 + bullets.length * 12 + asteroids.length * 10;
  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);

  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, MSG_SNAPSHOT);
  view.setUint32(2, snapshot.tick >>> 0, true);
  view.setFloat64(6, snapshot.serverTime, true);
  view.setUint8(14, ships.length);
  view.setUint8(15, bullets.length);
  view.setUint8(16, asteroids.length);

  let offset = 17;
  for (const s of ships) {
    view.setUint8(offset, s.slot);
    view.setUint8(offset + 1, s.hp);
    view.setUint32(offset + 2, s.lastProcessedSeq >>> 0, true);
    view.setFloat32(offset + 6, s.pos.x, true);
    view.setFloat32(offset + 10, s.pos.y, true);
    view.setFloat32(offset + 14, s.vel.x, true);
    view.setFloat32(offset + 18, s.vel.y, true);
    view.setInt16(offset + 22, encodeAngleInt16(s.angle), true);
    view.setUint16(offset + 24, Math.min(65535, s.score), true);
    offset += 26;
  }

  for (const b of bullets) {
    view.setUint32(offset, b.id >>> 0, true);
    view.setFloat32(offset + 4, b.pos.x, true);
    view.setFloat32(offset + 8, b.pos.y, true);
    offset += 12;
  }

  for (const a of asteroids) {
    view.setUint8(offset, a.id);
    view.setUint8(offset + 1, a.radius);
    view.setFloat32(offset + 2, a.pos.x, true);
    view.setFloat32(offset + 6, a.pos.y, true);
    offset += 10;
  }

  return buf;
}

export function decodeSnapshotBinary(arrayBuffer: ArrayBuffer): WorldSnapshot {
  if (arrayBuffer.byteLength < 17) {
    throw new Error('Binary snapshot header too short');
  }
  const view = new DataView(arrayBuffer);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported snapshot version: ${version}`);
  }
  const type = view.getUint8(1);
  if (type !== MSG_SNAPSHOT) {
    throw new Error(`Unexpected snapshot type: ${type}`);
  }

  const tick = asTickNumber(view.getUint32(2, true));
  const serverTime = view.getFloat64(6, true);
  const shipsCount = view.getUint8(14);
  const bulletsCount = view.getUint8(15);
  const asteroidsCount = view.getUint8(16);

  const expectedLength = 17 + shipsCount * 26 + bulletsCount * 12 + asteroidsCount * 10;
  if (arrayBuffer.byteLength !== expectedLength) {
    throw new Error(`Snapshot length mismatch: got ${arrayBuffer.byteLength}, expected ${expectedLength}`);
  }

  let offset = 17;
  const entities: SnapshotEntity[] = [];

  for (let i = 0; i < shipsCount; i++) {
    const slot = view.getUint8(offset);
    const hp = view.getUint8(offset + 1);
    const lastProcessedSeq = asSeqNumber(view.getUint32(offset + 2, true));
    const x = view.getFloat32(offset + 6, true);
    const y = view.getFloat32(offset + 10, true);
    const vx = view.getFloat32(offset + 14, true);
    const vy = view.getFloat32(offset + 18, true);
    const angle = decodeAngleInt16(view.getInt16(offset + 22, true));
    const score = view.getUint16(offset + 24, true);

    if (!Number.isFinite(x) || !Number.isFinite(y) || slot > 16 || hp > 100) {
      throw new Error('Corrupted ship values in snapshot');
    }

    entities.push({
      kind: 'ship',
      slot,
      hp,
      lastProcessedSeq,
      pos: { x, y },
      vel: { x: vx, y: vy },
      angle,
      score
    });
    offset += 26;
  }

  for (let i = 0; i < bulletsCount; i++) {
    const id = asEntityId(view.getUint32(offset, true));
    const x = view.getFloat32(offset + 4, true);
    const y = view.getFloat32(offset + 8, true);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('Corrupted bullet coordinates');
    }
    entities.push({ kind: 'bullet', id, pos: { x, y } });
    offset += 12;
  }

  for (let i = 0; i < asteroidsCount; i++) {
    const id = asEntityId(view.getUint8(offset));
    const radius = view.getUint8(offset + 1);
    const x = view.getFloat32(offset + 2, true);
    const y = view.getFloat32(offset + 6, true);
    if (!Number.isFinite(x) || !Number.isFinite(y) || radius === 0) {
      throw new Error('Corrupted asteroid values');
    }
    entities.push({ kind: 'asteroid', id, radius, pos: { x, y } });
    offset += 10;
  }

  return { type: 'snapshot', tick, serverTime, entities };
}