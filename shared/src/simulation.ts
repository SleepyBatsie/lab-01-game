import {
  type PlayerId,
  type EntityId,
  type TickNumber,
  type SeqNumber,
  type PlayerInput,
  type WorldSnapshot,
  type SnapshotEntity,
  asEntityId,
  asPlayerId,
  asTickNumber,
  asSeqNumber
} from './types.ts';
import { ObjectPool } from './pool.ts';
import { SpatialHash } from './spatialHash.ts';

export const TICK_RATE = 30;
export const FIXED_DT = 1 / TICK_RATE;
export const WORLD_WIDTH = 800;
export const WORLD_HEIGHT = 600;

export interface PlayerSimState {
  readonly id: PlayerId;
  readonly nickname: string;
  readonly slot: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  hp: number;
  score: number;
  cooldown: number;
  invuln: number;
  lastProcessedSeq: SeqNumber;
}

export interface BulletSimState {
  id: EntityId;
  ownerId: PlayerId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

export interface AsteroidSimState {
  readonly id: EntityId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

export interface WorldState {
  tick: TickNumber;
  readonly seed: number;
  nextEntityId: number;
  readonly players: Record<string, PlayerSimState>;
  readonly bullets: BulletSimState[];
  readonly asteroids: AsteroidSimState[];
  readonly bulletPool: ObjectPool<BulletSimState>;
  readonly playerGrid: SpatialHash<PlayerSimState>;
  readonly nearbyPlayersScratch: PlayerSimState[];
}

export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function wrapCoord(val: number, max: number): number {
  if (val < 0) return val + max;
  if (val >= max) return val - max;
  return val;
}

export function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function createBulletPool(): ObjectPool<BulletSimState> {
  return new ObjectPool<BulletSimState>(
    128,
    () => ({
      id: asEntityId(0),
      ownerId: asPlayerId(''),
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 0
    }),
    (b) => {
      b.life = 0;
      b.x = 0;
      b.y = 0;
      b.vx = 0;
      b.vy = 0;
    }
  );
}

export function createInitialState(seed = 12345): WorldState {
  const rng = createRng(seed);
  const asteroids: AsteroidSimState[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = rng() * Math.PI * 2;
    const speed = 40 + rng() * 60;
    asteroids.push({
      id: asEntityId(i + 1),
      x: Math.floor(rng() * WORLD_WIDTH),
      y: Math.floor(rng() * WORLD_HEIGHT),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 20 + Math.floor(rng() * 14)
    });
  }

  return {
    tick: asTickNumber(0),
    seed,
    nextEntityId: 100,
    players: {},
    bullets: [],
    asteroids,
    bulletPool: createBulletPool(),
    playerGrid: new SpatialHash<PlayerSimState>(WORLD_WIDTH, WORLD_HEIGHT, 80),
    nearbyPlayersScratch: []
  };
}

export function addPlayerToState(state: WorldState, id: PlayerId, nickname: string, slot = 0): void {
  const col = slot % 4;
  const row = Math.floor(slot / 4) % 3;
  const spawnX = 160 + col * 160;
  const spawnY = 150 + row * 150;
  state.players[id] = {
    id,
    nickname,
    slot,
    x: spawnX,
    y: spawnY,
    vx: 0,
    vy: 0,
    angle: slot % 2 === 0 ? 0 : Math.PI,
    hp: 5,
    score: 0,
    cooldown: 0,
    invuln: 0,
    lastProcessedSeq: asSeqNumber(0)
  };
}

export function removePlayerFromState(state: WorldState, id: PlayerId): void {
  delete state.players[id];
}

function respawnPlayer(player: PlayerSimState): void {
  const col = player.slot % 4;
  const row = Math.floor(player.slot / 4) % 3;
  player.hp = 5;
  player.x = 160 + col * 160;
  player.y = 150 + row * 150;
  player.vx = 0;
  player.vy = 0;
  player.angle = player.slot % 2 === 0 ? 0 : Math.PI;
  player.invuln = 1.5;
}

const EMPTY_INPUT = {
  left: false,
  right: false,
  thrust: false,
  fire: false
} as const;

export function applyPlayerInput(
  state: WorldState,
  player: PlayerSimState,
  input: Omit<PlayerInput, 'seq'> & { readonly seq?: SeqNumber },
  dt = FIXED_DT,
  spawnBullets = true
): void {
  if (player.hp <= 0) return;

  const TURN_SPEED = 4.2;
  const THRUST = 260;
  const DRAG = 0.985;

  if (player.invuln > 0) {
    player.invuln = Math.max(0, player.invuln - dt);
  }

  if (input.left) player.angle = normalizeAngle(player.angle - TURN_SPEED * dt);
  if (input.right) player.angle = normalizeAngle(player.angle + TURN_SPEED * dt);

  if (input.thrust) {
    player.vx += Math.cos(player.angle) * THRUST * dt;
    player.vy += Math.sin(player.angle) * THRUST * dt;
  }

  player.vx *= DRAG;
  player.vy *= DRAG;
  player.x = wrapCoord(player.x + player.vx * dt, WORLD_WIDTH);
  player.y = wrapCoord(player.y + player.vy * dt, WORLD_HEIGHT);

  if (player.cooldown > 0) {
    player.cooldown = Math.max(0, player.cooldown - dt);
  }

  if (input.fire && player.cooldown <= 0) {
    player.cooldown = 0.25;
    if (spawnBullets) {
      const BULLET_SPEED = 480;
      const bullet = state.bulletPool.acquire();
      bullet.id = asEntityId(state.nextEntityId++);
      bullet.ownerId = player.id;
      bullet.x = wrapCoord(player.x + Math.cos(player.angle) * 18, WORLD_WIDTH);
      bullet.y = wrapCoord(player.y + Math.sin(player.angle) * 18, WORLD_HEIGHT);
      bullet.vx = player.vx + Math.cos(player.angle) * BULLET_SPEED;
      bullet.vy = player.vy + Math.sin(player.angle) * BULLET_SPEED;
      bullet.life = 1.4;
      state.bullets.push(bullet);
    }
  }

  if (input.seq !== undefined && input.seq > player.lastProcessedSeq) {
    player.lastProcessedSeq = input.seq;
  }
}

export function stepWorld(
  state: WorldState,
  inputsByPlayerId: ReadonlyMap<PlayerId, PlayerInput>,
  dt = FIXED_DT
): void {
  state.tick = asTickNumber(state.tick + 1);

  state.playerGrid.clear();
  for (const key in state.players) {
    const player = state.players[key];
    if (!player) continue;
    const input = inputsByPlayerId.get(player.id) ?? EMPTY_INPUT;
    applyPlayerInput(state, player, input, dt, true);
    state.playerGrid.insert(player, player.x, player.y);
  }

  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    if (!b) continue;

    b.x = wrapCoord(b.x + b.vx * dt, WORLD_WIDTH);
    b.y = wrapCoord(b.y + b.vy * dt, WORLD_HEIGHT);
    b.life -= dt;

    if (b.life <= 0) {
      state.bullets.splice(i, 1);
      state.bulletPool.release(b);
      continue;
    }

    let hit = false;
    const candidates = state.playerGrid.queryNear(b.x, b.y, 24, state.nearbyPlayersScratch);
    for (let c = 0; c < candidates.length; c++) {
      const player = candidates[c];
      if (!player || player.id === b.ownerId || player.hp <= 0 || player.invuln > 0) continue;
      const dx = player.x - b.x;
      const dy = player.y - b.y;
      if (dx * dx + dy * dy < 20 * 20) {
        player.hp = Math.max(0, player.hp - 1);
        player.invuln = 0.4;
        const shooter = state.players[b.ownerId];
        if (shooter) shooter.score += 100;
        if (player.hp === 0) respawnPlayer(player);
        hit = true;
        break;
      }
    }
    if (hit) {
      state.bullets.splice(i, 1);
      state.bulletPool.release(b);
      continue;
    }

    for (let a = 0; a < state.asteroids.length; a++) {
      const ast = state.asteroids[a];
      if (!ast) continue;
      const dx = ast.x - b.x;
      const dy = ast.y - b.y;
      if (dx * dx + dy * dy < (ast.radius + 6) * (ast.radius + 6)) {
        const shooter = state.players[b.ownerId];
        if (shooter) shooter.score += 25;
        ast.x = wrapCoord(ast.x + 260, WORLD_WIDTH);
        ast.y = wrapCoord(ast.y + 170, WORLD_HEIGHT);
        state.bullets.splice(i, 1);
        state.bulletPool.release(b);
        break;
      }
    }
  }

  for (let a = 0; a < state.asteroids.length; a++) {
    const ast = state.asteroids[a];
    if (!ast) continue;
    ast.x = wrapCoord(ast.x + ast.vx * dt, WORLD_WIDTH);
    ast.y = wrapCoord(ast.y + ast.vy * dt, WORLD_HEIGHT);

    const candidates = state.playerGrid.queryNear(ast.x, ast.y, ast.radius + 20, state.nearbyPlayersScratch);
    for (let c = 0; c < candidates.length; c++) {
      const player = candidates[c];
      if (!player || player.hp <= 0 || player.invuln > 0) continue;
      const dx = player.x - ast.x;
      const dy = player.y - ast.y;
      const hitDist = ast.radius + 16;
      if (dx * dx + dy * dy < hitDist * hitDist) {
        player.hp = Math.max(0, player.hp - 1);
        player.invuln = 0.8;
        player.vx = -player.vx * 0.5;
        player.vy = -player.vy * 0.5;
        ast.x = wrapCoord(ast.x + 260, WORLD_WIDTH);
        ast.y = wrapCoord(ast.y + 170, WORLD_HEIGHT);
        if (player.hp === 0) {
          respawnPlayer(player);
        }
        break;
      }
    }
  }
}

export function buildWorldSnapshot(state: WorldState, serverTime: number): WorldSnapshot {
  const entities: SnapshotEntity[] = [];

  for (const key in state.players) {
    const p = state.players[key];
    if (!p) continue;
    entities.push({
      kind: 'ship',
      slot: p.slot,
      hp: p.hp,
      lastProcessedSeq: p.lastProcessedSeq,
      pos: { x: p.x, y: p.y },
      vel: { x: p.vx, y: p.vy },
      angle: p.angle,
      score: p.score
    });
  }

  for (let i = 0; i < state.bullets.length; i++) {
    const b = state.bullets[i];
    if (!b) continue;
    entities.push({
      kind: 'bullet',
      id: b.id,
      pos: { x: b.x, y: b.y }
    });
  }

  for (let i = 0; i < state.asteroids.length; i++) {
    const a = state.asteroids[i];
    if (!a) continue;
    entities.push({
      kind: 'asteroid',
      id: a.id,
      radius: a.radius,
      pos: { x: a.x, y: a.y }
    });
  }

  return {
    type: 'snapshot',
    tick: state.tick,
    serverTime,
    entities
  };
}