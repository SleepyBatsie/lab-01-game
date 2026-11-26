import { setupCanvas } from './renderer.js';
import { Lobby, type RoomSummary } from './lobby.js';
import { GameSocket, type IncomingGameMessage } from './wsClient.js';
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
const selNetPreset = getEl('sel-net-preset', HTMLSelectElement);

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

let inRoom = false;
let myPlayerId: PlayerId | null = null;
let mySlot = 0;
let localState: WorldState = createInitialState(12345);
let inputSeqCounter = 0;
const pendingInputs: PlayerInput[] = [];

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

interface LocalBullet {
  x: number;
  y: number;
  readonly vx: number;
  readonly vy: number;
  life: number;
}
const localBullets: LocalBullet[] = [];

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

function appendChat(html: string, isSystem = false): void {
  const div = document.createElement('div');
  div.className = isSystem ? 'chat-msg system' : 'chat-msg';
  div.innerHTML = html;
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

socket.addEventListener('status', (e: Event) => {
  const status = (e as CustomEvent<string>).detail; // Typed CustomEvent payload
  wsStatusEl.textContent = status;
  wsStatusEl.className = status === 'connected' ? 'badge connected' : 'badge offline';
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
    localState.asteroids.splice(
      0,
      localState.asteroids.length,
      ...asteroids.map((a) => ({
        id: a.id,
        x: a.pos.x,
        y: a.pos.y,
        vx: 0,
        vy: 0,
        radius: a.radius
      }))
    );
  }

  snapshotBuffer.push({ recvTime: now, ships, bullets, asteroids });
  if (snapshotBuffer.length > 30) snapshotBuffer.shift();

  const serverMe = ships.find((s) => s.slot === mySlot);
  const localMe = myPlayerId ? localState.players[myPlayerId] : undefined;

  if (serverMe && localMe) {
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

function getInterpolatedRemotePlayers(): InterpolatedShip[] {
  const firstSnap = snapshotBuffer[0];
  const lastSnap = snapshotBuffer[snapshotBuffer.length - 1];
  if (!firstSnap || !lastSnap) return [];

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

  const remotes: InterpolatedShip[] = [];
  for (const p1 of s1.ships) {
    if (p1.slot === mySlot) continue;
    const p0 = s0.ships.find((p) => p.slot === p1.slot) ?? p1;

    const dx = p1.pos.x - p0.pos.x;
    const dy = p1.pos.y - p0.pos.y;
    const x = Math.abs(dx) > WORLD_WIDTH / 2 ? p1.pos.x : p0.pos.x + dx * alpha;
    const y = Math.abs(dy) > WORLD_HEIGHT / 2 ? p1.pos.y : p0.pos.y + dy * alpha;
    const dAngle = normalizeAngle(p1.angle - p0.angle);
    const angle = normalizeAngle(p0.angle + dAngle * alpha);

    remotes.push({ slot: p1.slot, hp: p1.hp, x, y, angle });
  }
  return remotes;
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
      localBullets.push({
        x: wrapCoord(localMe.x + Math.cos(localMe.angle) * 18, WORLD_WIDTH),
        y: wrapCoord(localMe.y + Math.sin(localMe.angle) * 18, WORLD_HEIGHT),
        vx: localMe.vx + Math.cos(localMe.angle) * BULLET_SPEED,
        vy: localMe.vy + Math.sin(localMe.angle) * BULLET_SPEED,
        life: 0.35
      });
    }

    applyPlayerInput(localState, localMe, input, FIXED_DT, false);
  }
}, 1000 / TICK_RATE);

let lastFrameTime = performance.now();
let fpsSmoothed = 60;

function renderLoop(now: number): void {
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
    if (b.life <= 0) localBullets.splice(i, 1);
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

  for (const ast of localState.asteroids) {
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

  if (inRoom) {
    const latestSnap = snapshotBuffer[snapshotBuffer.length - 1];
    if (latestSnap) {
      ctx.fillStyle = '#f6e05e';
      for (const b of latestSnap.bullets) {
        ctx.beginPath();
        ctx.arc(b.pos.x, b.pos.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.fillStyle = '#68d391';
    for (const b of localBullets) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    const remotes = getInterpolatedRemotePlayers();
    for (const rp of remotes) {
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

  fpsEl.textContent = String(Math.round(fpsSmoothed));
  ngRttEl.textContent = String(socket.rttMs);
  ngSnapAgeEl.textContent = lastSnapshotRecvTime > 0 ? String(Math.round(now - lastSnapshotRecvTime)) : '0';
  ngTxEl.textContent = String(socket.txBytesPerSec);
  ngRxEl.textContent = String(socket.rxBytesPerSec);
  ngQueueEl.textContent = String(pendingInputs.length);
  ngErrEl.textContent = lastCorrectionMagnitude.toFixed(2);

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