export const PROTOCOL_VERSION = 1;
export const MSG_INPUT = 1;
export const MSG_SNAPSHOT = 2;

const ANGLE_SCALE = 32767 / Math.PI;

export function encodeAngleInt16(rad) {
  let a = rad;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return Math.max(-32767, Math.min(32767, Math.round(a * ANGLE_SCALE)));
}

export function decodeAngleInt16(int16) {
  return int16 / ANGLE_SCALE;
}

// Клієнт -> Сервер: Input (8 байт замість ~85 байт у JSON!)
// [0]: version (Uint8)
// [1]: type = MSG_INPUT (Uint8)
// [2..5]: seq (Uint32, little-endian)
// [6]: flags bitmask (1=left, 2=right, 4=thrust, 8=fire) (Uint8)
// [7]: clientTimeLow byte для швидкої звірки (Uint8)
export function encodeInputBinary(input) {
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
  view.setUint8(7, (input.clientTs || 0) & 0xff);
  return buf;
}

export function decodeInputBinary(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 8) throw new Error('Binary input too short');
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) throw new Error(`Unsupported version ${version}`);
  const type = view.getUint8(1);
  if (type !== MSG_INPUT) throw new Error(`Unexpected binary type ${type}`);

  const seq = view.getUint32(2, true);
  const flags = view.getUint8(6);
  return {
    type: 'input',
    seq,
    left: Boolean(flags & 1),
    right: Boolean(flags & 2),
    thrust: Boolean(flags & 4),
    fire: Boolean(flags & 8)
  };
}

// Сервер -> Клієнт: Snapshot
// Header (16 байт):
// [0]: version (Uint8)
// [1]: type = MSG_SNAPSHOT (Uint8)
// [2..5]: serverTick (Uint32, LE)
// [6..13]: serverTime (Float64, LE)
// [14]: playersCount (Uint8)
// [15]: bulletsCount (Uint8)
// Player record (22 байти на гравця):
// [0]: slot (Uint8)
// [1]: hp (Uint8)
// [2..5]: lastProcessedSeq (Uint32, LE)
// [6..9]: x (Float32, LE)
// [10..13]: y (Float32, LE)
// [14..17]: vx (Float32, LE)
// [18..21]: vy (Float32, LE)
// + 2 байти angle (Int16, LE) + 2 байти score (Uint16, LE) = 26 байт на гравця
// Bullet record (12 байт на кулю):
// [0..3]: id (Uint32, LE)
// [4..7]: x (Float32, LE)
// [8..11]: y (Float32, LE)
export function encodeSnapshotBinary(snapshot) {
  const players = snapshot.players;
  const bullets = snapshot.bullets;
  const totalBytes = 16 + players.length * 26 + bullets.length * 12;
  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);

  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, MSG_SNAPSHOT);
  view.setUint32(2, snapshot.tick >>> 0, true);
  view.setFloat64(6, snapshot.serverTime, true);
  view.setUint8(14, players.length);
  view.setUint8(15, bullets.length);

  let offset = 16;
  for (const p of players) {
    view.setUint8(offset, p.slot);
    view.setUint8(offset + 1, p.hp);
    view.setUint32(offset + 2, p.lastProcessedSeq >>> 0, true);
    view.setFloat32(offset + 6, p.x, true);
    view.setFloat32(offset + 10, p.y, true);
    view.setFloat32(offset + 14, p.vx, true);
    view.setFloat32(offset + 18, p.vy, true);
    view.setInt16(offset + 22, encodeAngleInt16(p.angle), true);
    view.setUint16(offset + 24, Math.min(65535, p.score), true);
    offset += 26;
  }

  for (const b of bullets) {
    view.setUint32(offset, b.id >>> 0, true);
    view.setFloat32(offset + 4, b.x, true);
    view.setFloat32(offset + 8, b.y, true);
    offset += 12;
  }

  return buf;
}

export function decodeSnapshotBinary(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 16) throw new Error('Snapshot too short');
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) throw new Error(`Bad version ${version}`);

  const tick = view.getUint32(2, true);
  const serverTime = view.getFloat64(6, true);
  const playersCount = view.getUint8(14);
  const bulletsCount = view.getUint8(15);

  let offset = 16;
  const players = [];
  for (let i = 0; i < playersCount; i++) {
    players.push({
      slot: view.getUint8(offset),
      hp: view.getUint8(offset + 1),
      lastProcessedSeq: view.getUint32(offset + 2, true),
      x: view.getFloat32(offset + 6, true),
      y: view.getFloat32(offset + 10, true),
      vx: view.getFloat32(offset + 14, true),
      vy: view.getFloat32(offset + 18, true),
      angle: decodeAngleInt16(view.getInt16(offset + 22, true)),
      score: view.getUint16(offset + 24, true)
    });
    offset += 26;
  }

  const bullets = [];
  for (let i = 0; i < bulletsCount; i++) {
    bullets.push({
      id: view.getUint32(offset, true),
      x: view.getFloat32(offset + 4, true),
      y: view.getFloat32(offset + 8, true)
    });
    offset += 12;
  }

  return { type: 'snapshot', tick, serverTime, players, bullets };
}
