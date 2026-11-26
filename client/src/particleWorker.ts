export interface WorkerTickMessage {
  readonly type: 'tick';
  readonly dt: number;
  readonly spawnEvents: ReadonlyArray<{ readonly x: number; readonly y: number; readonly count: number }>;
}

interface WorkerParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

const MAX_PARTICLES = 600;
const pool: WorkerParticle[] = Array.from({ length: MAX_PARTICLES }, () => ({
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  life: 0
}));
let activeCount = 0;

self.onmessage = (e: MessageEvent<WorkerTickMessage>) => {
  const msg = e.data;
  if (msg.type !== 'tick') return;

  for (const ev of msg.spawnEvents) {
    for (let i = 0; i < ev.count && activeCount < MAX_PARTICLES; i++) {
      const p = pool[activeCount];
      if (!p) continue;
      const angle = (Math.PI * 2 * i) / ev.count + Math.random() * 0.4;
      const speed = 30 + Math.random() * 90;
      p.x = ev.x;
      p.y = ev.y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.life = 0.45;
      activeCount++;
    }
  }

  let i = 0;
  while (i < activeCount) {
    const p = pool[i];
    if (!p) {
      i++;
      continue;
    }
    p.x += p.vx * msg.dt;
    p.y += p.vy * msg.dt;
    p.life -= msg.dt;
    if (p.life <= 0) {
      activeCount--;
      const last = pool[activeCount];
      if (last) {
        pool[i] = last;
        pool[activeCount] = p;
      }
    } else {
      i++;
    }
  }

  const out = new Float32Array(activeCount * 3);
  for (let k = 0; k < activeCount; k++) {
    const p = pool[k];
    if (!p) continue;
    out[k * 3] = p.x;
    out[k * 3 + 1] = p.y;
    out[k * 3 + 2] = p.life;
  }

  self.postMessage(out, { transfer: [out.buffer] });
};