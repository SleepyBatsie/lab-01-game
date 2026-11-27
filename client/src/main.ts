import { setupCanvas } from './renderer.ts';
import { Lobby, type RoomSummary } from './lobby.ts';
import { GameSocket, type IncomingGameMessage } from './wsClient.ts';
import { BotClient } from './botClient.ts';
import { FrameTimeTracker } from './frameStats.ts';
import { ObjectPool } from '@space-game/shared/pool';
import {
  asSeqNumber,
  assertNever,
  type PlayerId,
  type PlayerInput,
  type WorldSnapshot,
  type ShipEntity,
  type BulletEntity,
  type AsteroidEntity
} from '@space-game/shared/types';
import {
  TICK_RATE,
  FIXED_DT,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  createInitialState,
  addPlayerToState,
  applyPlayerInput,
  wrapCoord,
  normalizeAngle,
  type WorldState
} from '@space-game/shared/simulation';

function getEl<T extends HTMLElement>(id: string, ctor: { new (): T }): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) {
    throw new Error(`Missing or invalid DOM element #${id}`);
  }
  return el;
}

const canvas = getEl('canvas', HTMLCanvasElement);
const ctx = setupCanvas(canvas, WORLD_WIDTH, WORLD_HEIGHT);

const fpsEl = getEl('fps', HTMLElement);
const framePctEl = getEl('frame-pct', HTMLElement);
const hpEl = getEl('hp', HTMLElement);
const scoreEl = getEl('score', HTMLElement);
const ngProtoEl = getEl('ng-proto', HTMLElement);
const ngRttEl = getEl('ng-rtt', HTMLElement);
const ngSimRttEl = getEl('ng-sim-rtt', HTMLElement);
const ngSnapAgeEl = getEl('ng-snap-age', HTMLElement);
const ngTxEl = getEl('ng-tx', HTMLElement);
const ngRxEl = getEl('ng-rx', HTMLElement);
const ngQueueEl = getEl('ng-queue', HTMLElement);
const ngErrEl = getEl('ng-err', HTMLElement);

const chkBinary = getEl('chk-binary', HTMLInputElement);
const chkPrediction = getEl('chk-prediction', HTMLInputElement);
const chkWorker = getEl('chk-worker', HTMLInputElement);
const selNetPreset = getEl('sel-net-preset', HTMLSelectElement);
const botsBtn = getEl('bots-btn', HTMLButtonElement);

const wsStatusEl = getEl('ws-status', HTMLElement);
const lobbyViewEl = getEl('lobby-view', HTMLElement);
const roomViewEl = getEl('room-view', HTMLElement);
const nicknameInput = getEl('nickname-input', HTMLInputElement);
const roomInput = getEl('room-input', HTMLInputElement);
const joinBtn = getEl('join-btn', HTMLButtonElement);
const roomsListEl = getEl('rooms-list', HTMLUListElement);
const currentRoomNameEl = getEl('current-room-name', HTMLElement);
const leaveBtn = getEl('leave-btn', HTMLButtonElement);
const playersListEl = getEl('players-list', HTMLElement);
const chatMessagesEl = getEl('chat-messages', HTMLElement);
const chatForm = getEl('chat-form', HTMLFormElement);
const chatInput = getEl('chat-input', HTMLInputElement);

const socket = new GameSocket();
const lobby = new Lobby('/api/rooms');
const frameTracker = new FrameTimeTracker(300);

let inRoom = false;
let currentRoomId = 'arena';
let myPlayerId: PlayerId | null = null;
let mySlot = 0;
let localState: WorldState = createInitialState(12345);
let inputSeqCounter = 0;
const pendingInputs: PlayerInput[] = [];
let activeBots: BotClient[] = [];

let errOffsetX = 0;
let errOffsetY = 0;
let lastCorrectionMagnitude = 0;

interface BufferedSnapshot {
  readonly recvTime: number;
  readonly ships: readonly ShipEntity[];
  readonly bullets: readonly BulletEntity[];
  readonly asteroids: readonly AsteroidEntity[];
}

const INTERP_DELAY_MS = 100;
const snapshotBuffer: BufferedSnapshot[] = [];
let lastSnapshotRecvTime = 0;

// Пул об'єктів для локальних куль і частинок (без алокацій під час гри)
interface LocalBullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}
const localBulletPool = new ObjectPool<LocalBullet>(
  64,
  () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0 }),
  (b) => { b.life = 0; }
);
const localBullets: LocalBullet[] = [];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}
const particlePool = new ObjectPool<Particle>(
  400,
  () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0 }),
  (p) => { p.life = 0; }
);
const localParticles: Particle[] = [];

// Експериментальний Web Worker для розрахунку частинок
let particleWorker: Worker | null = null;
let workerParticlesBuffer = new Float32Array(0);
const pendingSpawnEvents: Array<{ x: number; y: number; count: number }> = [];

if (typeof Worker !== 'undefined') {
  particleWorker = new Worker(new URL('./particleWorker.ts', import.meta.url), { type: 'module' });
  particleWorker.onmessage = (e: MessageEvent<Float32Array>) => {
    workerParticlesBuffer = e.data as Float32Array<ArrayBuffer>;
  };
}

function spawnExplosion(x: number, y: number, count = 14): void {
  if (chkWorker.checked && particleWorker) {
    pendingSpawnEvents.push({ x, y, count });
    return;
  }
  for (let i = 0; i < count; i++) {
    const p = particlePool.acquire();
    const angle = (Math.PI * 2 * i) / count;
    const speed = 40 + (i % 5) * 20;
    p.x = x;
    p.y = y;
    p.vx = Math.cos(angle) * speed;
    p.vy = Math.sin(angle) * speed;
    p.life = 0.4;
    localParticles.push(p);
  }
}

const keys = { left: false, right: false, thrust: false, fire: false };
let firePressedOnce = false;

window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.left = true;
  if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.right = true;
  if (e.code === 'ArrowUp' || e.code === 'KeyW') keys.thrust = true;
  if (e.code === 'Space' && !e.repeat) {
    keys.fire = true;
    firePressedOnce = true;
  }
});

window.addEventListener('keyup', (e: KeyboardEvent) => {
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.left = false;
  if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.right = false;
  if (e.code === 'ArrowUp' || e.code === 'KeyW') keys.thrust = false;
  if (e.code === 'Space') keys.fire = false;
});

chkBinary.addEventListener('change', () => {
  socket.setProtocolMode(chkBinary.checked);
  ngProtoEl.textContent = chkBinary.checked ? 'BINARY' : 'JSON';
});

selNetPreset.addEventListener('change', () => {
  const parts = selNetPreset.value.split(',').map(Number);
  const delay = parts[0] ?? 0;
  const jitter = parts[1] ?? 0;
  const loss = parts[2] ?? 0;
  socket.simDelayMs = delay;
  socket.simJitterMs = jitter;
  socket.simLossPct = loss;
  ngSimRttEl.textContent = String(delay);
});

botsBtn.addEventListener('click', () => {
  if (activeBots.length > 0) {
    for (const bot of activeBots) bot.stop();
    activeBots = [];
    botsBtn.textContent = 'Запустити 8 ботів';
    return;
  }
  const targetRoom = inRoom ? currentRoomId : (roomInput.value.trim() || 'arena');
  if (!inRoom) {
    joinRoom(targetRoom);
  }
  for (let i = 0; i < 8; i++) {
    activeBots.push(new BotClient(targetRoom, i));
  }
  botsBtn.textContent = 'Зупинити 8 ботів';
});

function appendChat(html: string, isSystem = false): void {
  const div = document.createElement('div');
  div.className = isSystem ? 'chat-msg system' : 'chat-msg';
  div.innerHTML = html;
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function returnToLobbyOnDisconnect(notice: string): void {
  if (!inRoom) return;
  inRoom = false;
  myPlayerId = null;
  pendingInputs.length = 0;
  snapshotBuffer.length = 0;
  for (const bot of activeBots) bot.stop();
  activeBots = [];
  botsBtn.textContent = 'Запустити 8 ботів';
  roomViewEl.classList.add('hidden');
  lobbyViewEl.classList.remove('hidden');
  lobby.startPolling();
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = notice;
  roomsListEl.prepend(li);
}

socket.addEventListener('status', (e: Event) => {
  const status = (e as CustomEvent<string>).detail;
  wsStatusEl.textContent = status;
  wsStatusEl.className = status === 'connected' ? 'badge connected' : 'badge offline';
  if (status === 'disconnected' && inRoom) {
    returnToLobbyOnDisconnect('Зʼєднання з сервером втрачено — повернено в лобі.');
  }
});

socket.addEventListener('message', (e: Event) => {
  const msg = (e as CustomEvent<IncomingGameMessage>).detail; // Typed CustomEvent payload

  switch (msg.type) {
    case 'init_world': {
      mySlot = msg.slot;
      localState = createInitialState(msg.seed);
      if (msg.asteroids) {
        localState.asteroids.splice(0, localState.asteroids.length, ...msg.asteroids);
      }
      if (myPlayerId) {
        addPlayerToState(localState, myPlayerId, 'Me', mySlot);
      }
      pendingInputs.length = 0;
      snapshotBuffer.length = 0;
      break;
    }

    case 'joined': {
      inRoom = true;
      currentRoomId = msg.roomId;
      myPlayerId = msg.playerId;
      if (!localState.players[myPlayerId]) {
        addPlayerToState(localState, myPlayerId, msg.nickname, mySlot);
      }
      lobby.stopPolling();
      lobbyViewEl.classList.add('hidden');
      roomViewEl.classList.remove('hidden');
      currentRoomNameEl.textContent = msg.roomId;
      playersListEl.textContent = msg.players.map((p) => p.nickname).join(', ');
      chatMessagesEl.innerHTML = '';
      appendChat(`Ви в кімнаті "${msg.roomId}" (Slot ${mySlot + 1})`, true);
      break;
    }

    case 'system': {
      if (msg.players) {
        playersListEl.textContent = msg.players.map((p) => p.nickname).join(', ');
      }
      appendChat(msg.text, true);
      break;
    }

    case 'chat': {
      const safeText = msg.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      appendChat(`<strong>${msg.from}:</strong> ${safeText}`);
      break;
    }

    case 'snapshot': {
      handleServerSnapshot(msg);
      break;
    }

    case 'pong_rtt':
      break;
    case 'shutdown':
      returnToLobbyOnDisconnect('Сервер перезавантажується — ви повернулись у лобі.');
      break;

    default:
      assertNever(msg);
  }
});

function handleServerSnapshot(snap: WorldSnapshot): void {
  const now = performance.now();
  lastSnapshotRecvTime = now;
  localState.tick = snap.tick;

  const ships: ShipEntity[] = [];
  const bullets: BulletEntity[] = [];
  const asteroids: AsteroidEntity[] = [];

  for (const entity of snap.entities) {
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

  if (asteroids.length > 0) {
    for (let i = 0; i < asteroids.length; i++) {
      const a = asteroids[i];
      const existing = localState.asteroids[i];
      if (a && existing) {
        existing.x = a.pos.x;
        existing.y = a.pos.y;
        existing.radius = a.radius;
      }
    }
  }

  snapshotBuffer.push({ recvTime: now, ships, bullets, asteroids });
  if (snapshotBuffer.length > 30) snapshotBuffer.shift();

  const serverMe = ships.find((s) => s.slot === mySlot);
  const localMe = myPlayerId ? localState.players[myPlayerId] : undefined;

  if (serverMe && localMe) {
    if (serverMe.hp < localMe.hp) {
      spawnExplosion(serverMe.pos.x, serverMe.pos.y, 18);
    }

    while (pendingInputs.length > 0) {
      const first = pendingInputs[0];
      if (!first || first.seq > serverMe.lastProcessedSeq) break;
      pendingInputs.shift();
    }

    if (!chkPrediction.checked) {
      localMe.x = serverMe.pos.x;
      localMe.y = serverMe.pos.y;
      localMe.vx = serverMe.vel.x;
      localMe.vy = serverMe.vel.y;
      localMe.angle = serverMe.angle;
      localMe.hp = serverMe.hp;
      localMe.score = serverMe.score;
      errOffsetX = 0;
      errOffsetY = 0;
      lastCorrectionMagnitude = 0;
    } else {
      const prevX = localMe.x + errOffsetX;
      const prevY = localMe.y + errOffsetY;

      localMe.x = serverMe.pos.x;
      localMe.y = serverMe.pos.y;
      localMe.vx = serverMe.vel.x;
      localMe.vy = serverMe.vel.y;
      localMe.angle = serverMe.angle;
      localMe.hp = serverMe.hp;
      localMe.score = serverMe.score;

      for (const inp of pendingInputs) {
        applyPlayerInput(localState, localMe, inp, FIXED_DT, false);
      }

      let dx = prevX - localMe.x;
      let dy = prevY - localMe.y;
      if (dx > WORLD_WIDTH / 2) dx -= WORLD_WIDTH;
      if (dx < -WORLD_WIDTH / 2) dx += WORLD_WIDTH;
      if (dy > WORLD_HEIGHT / 2) dy -= WORLD_HEIGHT;
      if (dy < -WORLD_HEIGHT / 2) dy += WORLD_HEIGHT;

      lastCorrectionMagnitude = Math.hypot(dx, dy);
      if (lastCorrectionMagnitude > 120) {
        errOffsetX = 0;
        errOffsetY = 0;
      } else {
        errOffsetX = dx;
        errOffsetY = dy;
      }
    }
  }
}

interface InterpolatedShip {
  readonly slot: number;
  readonly hp: number;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

const interpolatedScratch: InterpolatedShip[] = [];

function getInterpolatedRemotePlayers(): readonly InterpolatedShip[] {
  interpolatedScratch.length = 0;
  const firstSnap = snapshotBuffer[0];
  const lastSnap = snapshotBuffer[snapshotBuffer.length - 1];
  if (!firstSnap || !lastSnap) return interpolatedScratch;

  const renderTime = performance.now() - INTERP_DELAY_MS;
  let s0: BufferedSnapshot = firstSnap;
  let s1: BufferedSnapshot = lastSnap;

  for (let i = 0; i < snapshotBuffer.length - 1; i++) {
    const curr = snapshotBuffer[i];
    const next = snapshotBuffer[i + 1];
    if (curr && next && curr.recvTime <= renderTime && next.recvTime >= renderTime) {
      s0 = curr;
      s1 = next;
      break;
    }
  }

  const span = s1.recvTime - s0.recvTime;
  const alpha = span > 0 ? Math.max(0, Math.min(1, (renderTime - s0.recvTime) / span)) : 1;

  for (let i = 0; i < s1.ships.length; i++) {
    const p1 = s1.ships[i];
    if (!p1 || p1.slot === mySlot) continue;
    const p0 = s0.ships.find((p) => p.slot === p1.slot) ?? p1;

    const dx = p1.pos.x - p0.pos.x;
    const dy = p1.pos.y - p0.pos.y;
    const x = Math.abs(dx) > WORLD_WIDTH / 2 ? p1.pos.x : p0.pos.x + dx * alpha;
    const y = Math.abs(dy) > WORLD_HEIGHT / 2 ? p1.pos.y : p0.pos.y + dy * alpha;
    const dAngle = normalizeAngle(p1.angle - p0.angle);
    const angle = normalizeAngle(p0.angle + dAngle * alpha);

    interpolatedScratch.push({ slot: p1.slot, hp: p1.hp, x, y, angle });
  }
  return interpolatedScratch;
}

window.setInterval(() => {
  if (!inRoom || !myPlayerId) return;
  const localMe = localState.players[myPlayerId];
  if (!localMe) return;

  inputSeqCounter += 1;
  const input: PlayerInput = {
    seq: asSeqNumber(inputSeqCounter),
    left: keys.left,
    right: keys.right,
    thrust: keys.thrust,
    fire: keys.fire || firePressedOnce,
    clientTs: performance.now()
  };
  firePressedOnce = false;

  socket.sendInput(input);

  if (chkPrediction.checked) {
    pendingInputs.push(input);
    if (pendingInputs.length > 60) pendingInputs.shift();

    if (input.fire && localMe.cooldown <= 0) {
      const BULLET_SPEED = 480;
      const b = localBulletPool.acquire();
      b.x = wrapCoord(localMe.x + Math.cos(localMe.angle) * 18, WORLD_WIDTH);
      b.y = wrapCoord(localMe.y + Math.sin(localMe.angle) * 18, WORLD_HEIGHT);
      b.vx = localMe.vx + Math.cos(localMe.angle) * BULLET_SPEED;
      b.vy = localMe.vy + Math.sin(localMe.angle) * BULLET_SPEED;
      b.life = 0.35;
      localBullets.push(b);
      spawnExplosion(b.x, b.y, 4);
    }

    applyPlayerInput(localState, localMe, input, FIXED_DT, false);
  }
}, 1000 / TICK_RATE);

let lastFrameTime = performance.now();
let fpsSmoothed = 60;
let hudUpdateCounter = 0;

function renderLoop(now: number): void {
  const frameStart = performance.now();
  const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  if (dt > 0) fpsSmoothed = fpsSmoothed * 0.9 + (1 / dt) * 0.1;

  const decay = Math.exp(-dt / 0.1);
  errOffsetX *= decay;
  errOffsetY *= decay;

  for (let i = localBullets.length - 1; i >= 0; i--) {
    const b = localBullets[i];
    if (!b) continue;
    b.x = wrapCoord(b.x + b.vx * dt, WORLD_WIDTH);
    b.y = wrapCoord(b.y + b.vy * dt, WORLD_HEIGHT);
    b.life -= dt;
    if (b.life <= 0) {
      localBullets.splice(i, 1);
      localBulletPool.release(b);
    }
  }

  if (chkWorker.checked && particleWorker) {
    particleWorker.postMessage({ type: 'tick', dt, spawnEvents: pendingSpawnEvents });
    pendingSpawnEvents.length = 0;
  } else {
    for (let i = localParticles.length - 1; i >= 0; i--) {
      const p = localParticles[i];
      if (!p) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) {
        localParticles.splice(i, 1);
        particlePool.release(p);
      }
    }
  }

  ctx.fillStyle = '#0f0f1b';
  ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  ctx.strokeStyle = '#1a202c';
  ctx.lineWidth = 1;
  for (let x = 0; x < WORLD_WIDTH; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_HEIGHT); ctx.stroke();
  }
  for (let y = 0; y < WORLD_HEIGHT; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WORLD_WIDTH, y); ctx.stroke();
  }

  for (let i = 0; i < localState.asteroids.length; i++) {
    const ast = localState.asteroids[i];
    if (!ast) continue;
    if (!inRoom) {
      ast.x = wrapCoord(ast.x + ast.vx * dt, WORLD_WIDTH);
      ast.y = wrapCoord(ast.y + ast.vy * dt, WORLD_HEIGHT);
    }
    ctx.strokeStyle = '#ed8936';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ast.x, ast.y, ast.radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = '#f6ad55';
  if (chkWorker.checked) {
    for (let i = 0; i + 2 < workerParticlesBuffer.length; i += 3) {
      const px = workerParticlesBuffer[i] ?? 0;
      const py = workerParticlesBuffer[i + 1] ?? 0;
      ctx.fillRect(px, py, 2.5, 2.5);
    }
  } else {
    for (let i = 0; i < localParticles.length; i++) {
      const p = localParticles[i];
      if (!p) continue;
      ctx.fillRect(p.x, p.y, 2.5, 2.5);
    }
  }

  if (inRoom) {
    const latestSnap = snapshotBuffer[snapshotBuffer.length - 1];
    if (latestSnap) {
      ctx.fillStyle = '#f6e05e';
      for (let i = 0; i < latestSnap.bullets.length; i++) {
        const b = latestSnap.bullets[i];
        if (!b) continue;
        ctx.beginPath();
        ctx.arc(b.pos.x, b.pos.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.fillStyle = '#68d391';
    for (let i = 0; i < localBullets.length; i++) {
      const b = localBullets[i];
      if (!b) continue;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    const remotes = getInterpolatedRemotePlayers();
    for (let i = 0; i < remotes.length; i++) {
      const rp = remotes[i];
      if (!rp) continue;
      drawShip(ctx, rp.x, rp.y, rp.angle, '#fc8181', `P${rp.slot + 1} (HP:${rp.hp})`);
    }

    const localMe = myPlayerId ? localState.players[myPlayerId] : undefined;
    if (localMe) {
      const drawX = wrapCoord(localMe.x + errOffsetX, WORLD_WIDTH);
      const drawY = wrapCoord(localMe.y + errOffsetY, WORLD_HEIGHT);
      drawShip(ctx, drawX, drawY, localMe.angle, '#4fd1c5', `YOU (HP:${localMe.hp})`);
      hpEl.textContent = String(localMe.hp);
      scoreEl.textContent = String(localMe.score);
    }
  }

  const frameCostMs = performance.now() - frameStart;
  frameTracker.record(frameCostMs);

  hudUpdateCounter++;
  if (hudUpdateCounter % 15 === 0) {
    const pct = frameTracker.getPercentiles();
    fpsEl.textContent = String(Math.round(fpsSmoothed));
    framePctEl.textContent = `${pct.p50.toFixed(2)}/${pct.p95.toFixed(2)}/${pct.p99.toFixed(2)}`;
    ngRttEl.textContent = String(socket.rttMs);
    ngSnapAgeEl.textContent = lastSnapshotRecvTime > 0 ? String(Math.round(now - lastSnapshotRecvTime)) : '0';
    ngTxEl.textContent = String(socket.txBytesPerSec);
    ngRxEl.textContent = String(socket.rxBytesPerSec);
    ngQueueEl.textContent = String(pendingInputs.length);
    ngErrEl.textContent = lastCorrectionMagnitude.toFixed(2);
  }

  requestAnimationFrame(renderLoop);
}

function drawShip(context: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string, label: string): void {
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.strokeStyle = color;
  context.lineWidth = 2.5;
  context.beginPath();
  context.moveTo(16, 0);
  context.lineTo(-12, -10);
  context.lineTo(-7, 0);
  context.lineTo(-12, 10);
  context.closePath();
  context.stroke();
  context.restore();

  context.fillStyle = color;
  context.font = '11px monospace';
  context.textAlign = 'center';
  context.fillText(label, x, y - 20);
}

lobby.addEventListener('roomsUpdated', (e: Event) => {
  const rooms = (e as CustomEvent<RoomSummary[]>).detail; // Typed CustomEvent payload
  roomsListEl.innerHTML = '';
  if (rooms.length === 0) {
    roomsListEl.innerHTML = '<li class="empty">Немає активних кімнат. Створіть першу!</li>';
    return;
  }
  for (const room of rooms) {
    const li = document.createElement('li');
    li.innerHTML = `<span><strong>${room.id}</strong> (${room.playersCount} грав.)</span>`;
    const btn = document.createElement('button');
    btn.textContent = 'Зайти';
    btn.onclick = () => joinRoom(room.id);
    li.appendChild(btn);
    roomsListEl.appendChild(li);
  }
});

function joinRoom(roomId: string): void {
  const nickname = nicknameInput.value.trim() || `Pilot_${Math.floor(Math.random() * 1000)}`;
  socket.connect();
  socket.send({ type: 'join', roomId, nickname });
}

joinBtn.addEventListener('click', () => {
  joinRoom(roomInput.value.trim() || 'arena');
});

leaveBtn.addEventListener('click', () => {
  inRoom = false;
  for (const bot of activeBots) bot.stop();
  activeBots = [];
  botsBtn.textContent = 'Запустити 8 ботів';
  socket.send({ type: 'leave' });
  roomViewEl.classList.add('hidden');
  lobbyViewEl.classList.remove('hidden');
  lobby.startPolling();
});

chatForm.addEventListener('submit', (e: SubmitEvent) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.send({ type: 'chat', text });
  chatInput.value = '';
});

lobby.startPolling();
requestAnimationFrame(renderLoop);
if ('serviceWorker' in navigator) { window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js'); }); }
