import { setupCanvas } from './renderer.js';
import { Lobby } from './lobby.js';
import { GameSocket } from './wsClient.js';
import {
  TICK_RATE,
  FIXED_DT,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  createInitialState,
  addPlayerToState,
  applyPlayerInput,
  wrapCoord,
  normalizeAngle
} from '@space-game/shared/simulation';

const canvas = document.getElementById('canvas');
const ctx = setupCanvas(canvas, WORLD_WIDTH, WORLD_HEIGHT);

// HUD & Netgraph
const fpsEl = document.getElementById('fps');
const hpEl = document.getElementById('hp');
const scoreEl = document.getElementById('score');
const ngProtoEl = document.getElementById('ng-proto');
const ngRttEl = document.getElementById('ng-rtt');
const ngSimRttEl = document.getElementById('ng-sim-rtt');
const ngSnapAgeEl = document.getElementById('ng-snap-age');
const ngTxEl = document.getElementById('ng-tx');
const ngRxEl = document.getElementById('ng-rx');
const ngQueueEl = document.getElementById('ng-queue');
const ngErrEl = document.getElementById('ng-err');

// Controls
const chkBinary = document.getElementById('chk-binary');
const chkPrediction = document.getElementById('chk-prediction');
const selNetPreset = document.getElementById('sel-net-preset');

// Lobby & Chat
const wsStatusEl = document.getElementById('ws-status');
const lobbyViewEl = document.getElementById('lobby-view');
const roomViewEl = document.getElementById('room-view');
const nicknameInput = document.getElementById('nickname-input');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const roomsListEl = document.getElementById('rooms-list');
const currentRoomNameEl = document.getElementById('current-room-name');
const leaveBtn = document.getElementById('leave-btn');
const playersListEl = document.getElementById('players-list');
const chatMessagesEl = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');

const socket = new GameSocket();
const lobby = new Lobby('/api/rooms');

// Стан клієнтської симуляції
let inRoom = false;
let myPlayerId = null;
let mySlot = 0;
let localState = createInitialState(12345);
let inputSeq = 0;
const pendingInputs = []; // Черга непідтверджених сервером input для reconciliation

// Згладжування поправки позиції за 100 мс
let errOffsetX = 0;
let errOffsetY = 0;
let lastCorrectionMagnitude = 0;

// Буфер знімків для інтерполяції суперника (затримка інтерполяції = 100 мс)
const INTERP_DELAY_MS = 100;
const snapshotBuffer = []; // { recvTime, tick, players, bullets }
let lastSnapshotRecvTime = 0;

// Локальні predicted-кулі для миттєвого відгуку при пострілі
const localBullets = [];

// Стан клавіш
const keys = { left: false, right: false, thrust: false, fire: false };
let firePressedOnce = false;

window.addEventListener('keydown', (e) => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.left = true;
  if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.right = true;
  if (e.code === 'ArrowUp' || e.code === 'KeyW') keys.thrust = true;
  if (e.code === 'Space' && !e.repeat) {
    keys.fire = true;
    firePressedOnce = true;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.left = false;
  if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.right = false;
  if (e.code === 'ArrowUp' || e.code === 'KeyW') keys.thrust = false;
  if (e.code === 'Space') keys.fire = false;
});

// Обробники перемикачів
chkBinary.addEventListener('change', () => {
  socket.setProtocolMode(chkBinary.checked);
  ngProtoEl.textContent = chkBinary.checked ? 'BINARY' : 'JSON';
});

selNetPreset.addEventListener('change', () => {
  const [delay, jitter, loss] = selNetPreset.value.split(',').map(Number);
  socket.simDelayMs = delay;
  socket.simJitterMs = jitter;
  socket.simLossPct = loss;
  ngSimRttEl.textContent = delay;
});

function appendChat(html, isSystem = false) {
  const div = document.createElement('div');
  div.className = isSystem ? 'chat-msg system' : 'chat-msg';
  div.innerHTML = html;
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

socket.addEventListener('status', (e) => {
  wsStatusEl.textContent = e.detail;
  wsStatusEl.className = e.detail === 'connected' ? 'badge connected' : 'badge offline';
});

socket.addEventListener('message', (e) => {
  const msg = e.detail;

  if (msg.type === 'init_world') {
    mySlot = msg.slot;
    localState = createInitialState(msg.seed);
    if (msg.asteroids) localState.asteroids = msg.asteroids;
    if (myPlayerId) {
      addPlayerToState(localState, myPlayerId, 'Me', mySlot);
    }
    pendingInputs.length = 0;
    snapshotBuffer.length = 0;
  } else if (msg.type === 'joined') {
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
  } else if (msg.type === 'system') {
    if (msg.players) {
      playersListEl.textContent = msg.players.map((p) => p.nickname).join(', ');
    }
    appendChat(msg.text, true);
  } else if (msg.type === 'chat') {
    const safeText = msg.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    appendChat(`<strong>${msg.from}:</strong> ${safeText}`);
  } else if (msg.type === 'snapshot') {
    handleServerSnapshot(msg);
  }
});

function handleServerSnapshot(snap) {
  const now = performance.now();
  lastSnapshotRecvTime = now;

  // Зберігаємо знімок у кільцевий буфер для інтерполяції чужих кораблів
  snapshotBuffer.push({
    recvTime: now,
    tick: snap.tick,
    players: snap.players,
    bullets: snap.bullets
  });
  if (snapshotBuffer.length > 30) snapshotBuffer.shift();

  // Знаходимо наш корабель у знімку сервера
  const serverMe = snap.players.find((p) => p.slot === mySlot);
  const localMe = localState.players[myPlayerId];

  if (serverMe && localMe) {
    // Видаляємо з черги всі input, які сервер уже обробив
    while (pendingInputs.length > 0 && pendingInputs[0].seq <= serverMe.lastProcessedSeq) {
      pendingInputs.shift();
    }

    if (!chkPrediction.checked) {
      // Режим БЕЗ передбачення: ставимо корабель строго у стан зі знімка сервера
      Object.assign(localMe, {
        x: serverMe.x,
        y: serverMe.y,
        vx: serverMe.vx,
        vy: serverMe.vy,
        angle: serverMe.angle,
        hp: serverMe.hp,
        score: serverMe.score
      });
      errOffsetX = 0;
      errOffsetY = 0;
      lastCorrectionMagnitude = 0;
    } else {
      // Режим ІЗ передбаченням та звіркою (Reconciliation)
      const prevX = localMe.x + errOffsetX;
      const prevY = localMe.y + errOffsetY;

      // 1. Ставимо корабель у підтверджений стан сервера
      localMe.x = serverMe.x;
      localMe.y = serverMe.y;
      localMe.vx = serverMe.vx;
      localMe.vy = serverMe.vy;
      localMe.angle = serverMe.angle;
      localMe.hp = serverMe.hp;
      localMe.score = serverMe.score;

      // 2. Заново програємо всі непідтверджені input з черги
      for (const inp of pendingInputs) {
        applyPlayerInput(localState, localMe, inp, FIXED_DT, false);
      }

      // 3. Обчислюємо розбіжність і запускаємо плавне згладжування за ~100 мс
      let dx = prevX - localMe.x;
      let dy = prevY - localMe.y;
      if (dx > WORLD_WIDTH / 2) dx -= WORLD_WIDTH;
      if (dx < -WORLD_WIDTH / 2) dx += WORLD_WIDTH;
      if (dy > WORLD_HEIGHT / 2) dy -= WORLD_HEIGHT;
      if (dy < -WORLD_HEIGHT / 2) dy += WORLD_HEIGHT;

      lastCorrectionMagnitude = Math.hypot(dx, dy);
      if (lastCorrectionMagnitude > 120) {
        // Занадто великий стрибок (телепорт/респаун) — без згладжування
        errOffsetX = 0;
        errOffsetY = 0;
      } else {
        errOffsetX = dx;
        errOffsetY = dy;
      }
    }
  }
}

// Отримання інтерпольованого стану суперника (100 мс у минулому)
function getInterpolatedRemotePlayers() {
  if (snapshotBuffer.length === 0) return [];
  const renderTime = performance.now() - INTERP_DELAY_MS;

  // Шукаємо два сусідні знімки навколо renderTime
  let s0 = snapshotBuffer[0];
  let s1 = snapshotBuffer[snapshotBuffer.length - 1];

  for (let i = 0; i < snapshotBuffer.length - 1; i++) {
    if (snapshotBuffer[i].recvTime <= renderTime && snapshotBuffer[i + 1].recvTime >= renderTime) {
      s0 = snapshotBuffer[i];
      s1 = snapshotBuffer[i + 1];
      break;
    }
  }

  const span = s1.recvTime - s0.recvTime;
  const alpha = span > 0 ? Math.max(0, Math.min(1, (renderTime - s0.recvTime) / span)) : 1;

  const remotes = [];
  for (const p1 of s1.players) {
    if (p1.slot === mySlot) continue;
    const p0 = s0.players.find((p) => p.slot === p1.slot) || p1;

    // Не інтерполюємо через край екрана (wrap-around)
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const x = Math.abs(dx) > WORLD_WIDTH / 2 ? p1.x : p0.x + dx * alpha;
    const y = Math.abs(dy) > WORLD_HEIGHT / 2 ? p1.y : p0.y + dy * alpha;
    const dAngle = normalizeAngle(p1.angle - p0.angle);
    const angle = normalizeAngle(p0.angle + dAngle * alpha);

    remotes.push({ ...p1, x, y, angle });
  }
  return remotes;
}

// Фіксований крок клієнта (30 Гц) — відправка input + локальне передбачення
setInterval(() => {
  if (!inRoom) return;
  const localMe = localState.players[myPlayerId];
  if (!localMe) return;

  inputSeq += 1;
  const input = {
    seq: inputSeq,
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

    // Миттєвий спавн локальної кулі при пострілі
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

// Рендер-цикл (60+ FPS)
let lastFrameTime = performance.now();
let fpsSmoothed = 60;

function renderLoop(now) {
  const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
  lastFrameTime = now;
  if (dt > 0) fpsSmoothed = fpsSmoothed * 0.9 + (1 / dt) * 0.1;

  // Згладжування поправки (згасання за ~100 мс)
  const decay = Math.exp(-dt / 0.1);
  errOffsetX *= decay;
  errOffsetY *= decay;

  // Рух локальних predicted-куль
  for (let i = localBullets.length - 1; i >= 0; i--) {
    const b = localBullets[i];
    b.x = wrapCoord(b.x + b.vx * dt, WORLD_WIDTH);
    b.y = wrapCoord(b.y + b.vy * dt, WORLD_HEIGHT);
    b.life -= dt;
    if (b.life <= 0) localBullets.splice(i, 1);
  }

  // Малювання фону та сітки
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

  // Астероїди (детермінований рух)
  for (const ast of localState.asteroids) {
    ast.x = wrapCoord(ast.x + ast.vx * dt, WORLD_WIDTH);
    ast.y = wrapCoord(ast.y + ast.vy * dt, WORLD_HEIGHT);
    ctx.strokeStyle = '#ed8936';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ast.x, ast.y, ast.radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (inRoom) {
    // 1. Серверні кулі з останнього знімка
    const latestSnap = snapshotBuffer[snapshotBuffer.length - 1];
    if (latestSnap) {
      ctx.fillStyle = '#f6e05e';
      for (const b of latestSnap.bullets) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 2. Локальні миттєві кулі
    ctx.fillStyle = '#68d391';
    for (const b of localBullets) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3. Інтерпольовані кораблі суперників (червоні)
    const remotes = getInterpolatedRemotePlayers();
    for (const rp of remotes) {
      drawShip(ctx, rp.x, rp.y, rp.angle, '#fc8181', `P${rp.slot + 1} (HP:${rp.hp})`);
    }

    // 4. Наш корабель (бірюзовий, зі згладженою поправкою)
    const localMe = localState.players[myPlayerId];
    if (localMe) {
      const drawX = wrapCoord(localMe.x + errOffsetX, WORLD_WIDTH);
      const drawY = wrapCoord(localMe.y + errOffsetY, WORLD_HEIGHT);
      drawShip(ctx, drawX, drawY, localMe.angle, '#4fd1c5', `YOU (HP:${localMe.hp})`);
      hpEl.textContent = localMe.hp;
      scoreEl.textContent = localMe.score;
    }
  }

  // Оновлення HUD і Netgraph
  fpsEl.textContent = Math.round(fpsSmoothed);
  ngRttEl.textContent = socket.rttMs;
  ngSnapAgeEl.textContent = lastSnapshotRecvTime > 0 ? Math.round(now - lastSnapshotRecvTime) : 0;
  ngTxEl.textContent = socket.txBytesPerSec;
  ngRxEl.textContent = socket.rxBytesPerSec;
  ngQueueEl.textContent = pendingInputs.length;
  ngErrEl.textContent = lastCorrectionMagnitude.toFixed(2);

  requestAnimationFrame(renderLoop);
}

function drawShip(ctx, x, y, angle, color, label) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(-12, -10);
  ctx.lineTo(-7, 0);
  ctx.lineTo(-12, 10);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = color;
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(label, x, y - 20);
}

// Лобі та події кнопок
lobby.addEventListener('roomsUpdated', (e) => {
  const rooms = e.detail;
  roomsListEl.innerHTML = '';
  if (!rooms || rooms.length === 0) {
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

function joinRoom(roomId) {
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

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.send({ type: 'chat', text });
  chatInput.value = '';
});

lobby.startPolling();
requestAnimationFrame(renderLoop);
