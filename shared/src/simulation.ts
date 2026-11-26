import {
  type PlayerId,
  type EntityId,
  type TickNumber,
  type SeqNumber,
  type PlayerInput,
  type WorldSnapshot,
  type SnapshotEntity,
  asEntityId,
  asTickNumber,
  asSeqNumber
} from './types.ts';

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
  readonly id: EntityId;
  readonly ownerId: PlayerId;
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
    asteroids
  };
}

export function addPlayerToState(state: WorldState, id: PlayerId, nickname: string, slot = 0): void {
  const spawnX = slot === 0 ? 200 : 600;
  const spawnY = WORLD_HEIGHT / 2;
  state.players[id] = {
    id,
    nickname,
    slot,
    x: spawnX,
    y: spawnY,
    vx: 0,
    vy: 0,
    angle: slot === 0 ? 0 : Math.PI,
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
  player.hp = 5;
  player.x = player.slot === 0 ? 200 : 600;
  player.y = WORLD_HEIGHT / 2;
  player.vx = 0;
  player.vy = 0;
  player.angle = player.slot === 0 ? 0 : Math.PI;
  player.invuln = 1.5;
}

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
      state.bullets.push({
        id: asEntityId(state.nextEntityId++),
        ownerId: player.id,
        x: wrapCoord(player.x + Math.cos(player.angle) * 18, WORLD_WIDTH),
        y: wrapCoord(player.y + Math.sin(player.angle) * 18, WORLD_HEIGHT),
        vx: player.vx + Math.cos(player.angle) * BULLET_SPEED,
        vy: player.vy + Math.sin(player.angle) * BULLET_SPEED,
        life: 1.4
      });
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

  for (const player of Object.values(state.players)) {
    const input = inputsByPlayerId.get(player.id) ?? {
      left: false,
      right: false,
      thrust: false,
      fire: false
    };
    applyPlayerInput(state, player, input, dt, true);
  }

  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    if (!b) continue;

    b.x = wrapCoord(b.x + b.vx * dt, WORLD_WIDTH);
    b.y = wrapCoord(b.y + b.vy * dt, WORLD_HEIGHT);
    b.life -= dt;

    if (b.life <= 0) {
      state.bullets.splice(i, 1);
      continue;
    }

    let hit = false;
    for (const player of Object.values(state.players)) {
      if (player.id === b.ownerId || player.hp <= 0 || player.invuln > 0) continue;
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
      continue;
    }

    for (const ast of state.asteroids) {
      const dx = ast.x - b.x;
      const dy = ast.y - b.y;
      if (dx * dx + dy * dy < (ast.radius + 6) * (ast.radius + 6)) {
        const shooter = state.players[b.ownerId];
        if (shooter) shooter.score += 25;
        ast.x = wrapCoord(ast.x + 260, WORLD_WIDTH);
        ast.y = wrapCoord(ast.y + 170, WORLD_HEIGHT);
        state.bullets.splice(i, 1);
        break;
      }
    }
  }

  for (const ast of state.asteroids) {
    ast.x = wrapCoord(ast.x + ast.vx * dt, WORLD_WIDTH);
    ast.y = wrapCoord(ast.y + ast.vy * dt, WORLD_HEIGHT);

    for (const player of Object.values(state.players)) {
      if (player.hp <= 0 || player.invuln > 0) continue;
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

  for (const p of Object.values(state.players)) {
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

  for (const b of state.bullets) {
    entities.push({
      kind: 'bullet',
      id: b.id,
      pos: { x: b.x, y: b.y }
    });
  }

  for (const a of state.asteroids) {
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