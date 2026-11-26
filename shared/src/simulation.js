export const TICK_RATE = 30;
export const FIXED_DT = 1 / TICK_RATE;
export const WORLD_WIDTH = 800;
export const WORLD_HEIGHT = 600;

// Детермінований PRNG (Mulberry32) замість Math.random()
export function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function wrapCoord(val, max) {
  if (val < 0) return val + max;
  if (val >= max) return val - max;
  return val;
}

export function normalizeAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

export function createInitialState(seed = 12345) {
  const rng = createRng(seed);
  const asteroids = [];
  for (let i = 0; i < 6; i++) {
    const angle = rng() * Math.PI * 2;
    const speed = 40 + rng() * 60;
    asteroids.push({
      id: i + 1,
      x: Math.floor(rng() * WORLD_WIDTH),
      y: Math.floor(rng() * WORLD_HEIGHT),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 18 + Math.floor(rng() * 14)
    });
  }

  return {
    tick: 0,
    seed,
    nextEntityId: 100,
    players: {}, // id -> { id, slot, x, y, vx, vy, angle, hp, score, cooldown, lastProcessedSeq }
    bullets: [], // { id, ownerId, x, y, vx, vy, life }
    asteroids
  };
}

export function addPlayerToState(state, id, nickname, slot = 0) {
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
    lastProcessedSeq: 0
  };
}

export function removePlayerFromState(state, id) {
  delete state.players[id];
}

// Застосовує один пакет input до конкретного корабля (використовується і сервером, і клієнтом для prediction)
export function applyPlayerInput(state, player, input, dt = FIXED_DT, spawnBullets = true) {
  if (!player || player.hp <= 0) return;

  const TURN_SPEED = 4.2; // рад/с
  const THRUST = 260;     // пікс/с^2
  const DRAG = 0.985;

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
        id: state.nextEntityId++,
        ownerId: player.id,
        x: wrapCoord(player.x + Math.cos(player.angle) * 18, WORLD_WIDTH),
        y: wrapCoord(player.y + Math.sin(player.angle) * 18, WORLD_HEIGHT),
        vx: player.vx + Math.cos(player.angle) * BULLET_SPEED,
        vy: player.vy + Math.sin(player.angle) * BULLET_SPEED,
        life: 1.4
      });
    }
  }

  if (typeof input.seq === 'number' && input.seq > player.lastProcessedSeq) {
    player.lastProcessedSeq = input.seq;
  }
}

// Повний крок світу на сервері
export function stepWorld(state, inputsByPlayerId, dt = FIXED_DT) {
  state.tick += 1;

  for (const [playerId, player] of Object.entries(state.players)) {
    const input = inputsByPlayerId.get(playerId) || { left: false, right: false, thrust: false, fire: false };
    applyPlayerInput(state, player, input, dt, true);
  }

  // Рух куль і перевірка влучань
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    b.x = wrapCoord(b.x + b.vx * dt, WORLD_WIDTH);
    b.y = wrapCoord(b.y + b.vy * dt, WORLD_HEIGHT);
    b.life -= dt;

    if (b.life <= 0) {
      state.bullets.splice(i, 1);
      continue;
    }

    // Влучання в інших гравців
    let hit = false;
    for (const player of Object.values(state.players)) {
      if (player.id === b.ownerId || player.hp <= 0) continue;
      const dx = player.x - b.x;
      const dy = player.y - b.y;
      if (dx * dx + dy * dy < 16 * 16) {
        player.hp = Math.max(0, player.hp - 1);
        const shooter = state.players[b.ownerId];
        if (shooter) shooter.score += 100;
        if (player.hp === 0) {
          // Респаун у стартову позицію
          player.hp = 5;
          player.x = player.slot === 0 ? 200 : 600;
          player.y = WORLD_HEIGHT / 2;
          player.vx = 0;
          player.vy = 0;
        }
        hit = true;
        break;
      }
    }
    if (hit) {
      state.bullets.splice(i, 1);
      continue;
    }

    // Влучання в астероїди
    for (const ast of state.asteroids) {
      const dx = ast.x - b.x;
      const dy = ast.y - b.y;
      if (dx * dx + dy * dy < ast.radius * ast.radius) {
        const shooter = state.players[b.ownerId];
        if (shooter) shooter.score += 25;
        ast.x = wrapCoord(ast.x + 173, WORLD_WIDTH);
        ast.y = wrapCoord(ast.y + 97, WORLD_HEIGHT);
        state.bullets.splice(i, 1);
        break;
      }
    }
  }

  // Рух астероїдів
  for (const ast of state.asteroids) {
    ast.x = wrapCoord(ast.x + ast.vx * dt, WORLD_WIDTH);
    ast.y = wrapCoord(ast.y + ast.vy * dt, WORLD_HEIGHT);
  }
}
