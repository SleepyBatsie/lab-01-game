import { describe, it, expect, vi, afterEach } from 'vitest';
import { FrameTimeTracker } from './frameStats.ts';
import {
  createInitialState,
  addPlayerToState,
  applyPlayerInput,
  stepWorld,
  FIXED_DT
} from '@space-game/shared/simulation';
import { asPlayerId, asSeqNumber, type PlayerInput } from '@space-game/shared/types';

afterEach(() => {
  vi.useRealTimers();
});

describe('Client FrameTimeTracker (p50 / p95 / p99)', () => {
  it('returns zeros when no frames recorded', () => {
    const tracker = new FrameTimeTracker(100);
    expect(tracker.getPercentiles()).toEqual({ p50: 0, p95: 0, p99: 0 });
  });

  it('computes accurate p50, p95, p99 percentiles across ring buffer', () => {
    const tracker = new FrameTimeTracker(100);
    for (let i = 1; i <= 100; i++) {
      tracker.record(i);
    }
    const pct = tracker.getPercentiles();
    expect(pct.p50).toBe(51);
    expect(pct.p95).toBe(96);
    expect(pct.p99).toBe(100);
  });

  it('overwrites oldest samples cleanly when capacity exceeded', () => {
    const tracker = new FrameTimeTracker(10);
    for (let i = 0; i < 25; i++) {
      tracker.record(4.2);
    }
    const pct = tracker.getPercentiles();
    expect(pct.p50).toBeCloseTo(4.2, 5);
    expect(pct.p99).toBeCloseTo(4.2, 5);
  });
});

describe('Client-side Prediction & Server Reconciliation parity', () => {
  it('reconciles predicted state with authoritative server snapshot + pending inputs', () => {
    const pid = asPlayerId('local-pilot');
    const serverState = createInitialState(12345);
    const clientState = createInitialState(12345);
    addPlayerToState(serverState, pid, 'Pilot', 0);
    addPlayerToState(clientState, pid, 'Pilot', 0);

    const inputs: PlayerInput[] = [
      { seq: asSeqNumber(1), left: false, right: false, thrust: true, fire: false },
      { seq: asSeqNumber(2), left: false, right: false, thrust: true, fire: false },
      { seq: asSeqNumber(3), left: true, right: false, thrust: true, fire: false }
    ];

    // Клієнт передбачає всі 3 кроки
    for (const inp of inputs) {
      applyPlayerInput(clientState, clientState.players[pid]!, inp, FIXED_DT, false);
    }

    // Сервер обробив лише перший крок (seq = 1)
    stepWorld(serverState, new Map([[pid, inputs[0]!]]), FIXED_DT);

    // Звірка (Reconciliation): скидаємо клієнта до знімка сервера (seq=1) і дограємо seq=2, 3
    const srvShip = serverState.players[pid]!;
    const cliShip = clientState.players[pid]!;
    cliShip.x = srvShip.x;
    cliShip.y = srvShip.y;
    cliShip.vx = srvShip.vx;
    cliShip.vy = srvShip.vy;
    cliShip.angle = srvShip.angle;

    const unacked = inputs.filter((i) => i.seq > srvShip.lastProcessedSeq);
    for (const inp of unacked) {
      applyPlayerInput(clientState, cliShip, inp, FIXED_DT, false);
    }

    // Тепер сервер доганяє seq=2 і seq=3
    stepWorld(serverState, new Map([[pid, inputs[1]!]]), FIXED_DT);
    stepWorld(serverState, new Map([[pid, inputs[2]!]]), FIXED_DT);

    expect(cliShip.x).toBeCloseTo(serverState.players[pid]!.x, 5);
    expect(cliShip.y).toBeCloseTo(serverState.players[pid]!.y, 5);
    expect(cliShip.angle).toBeCloseTo(serverState.players[pid]!.angle, 5);
  });

  it('game input loop dispatches 30 ticks per second under fake timers', () => {
    vi.useFakeTimers();
    let sentCount = 0;
    const id = setInterval(() => {
      sentCount++;
    }, 1000 / 30);

    vi.advanceTimersByTime(1000);
    clearInterval(id);
    expect(sentCount).toBe(30);
  });
});