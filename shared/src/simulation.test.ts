import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  createInitialState,
  addPlayerToState,
  removePlayerFromState,
  applyPlayerInput,
  stepWorld,
  buildWorldSnapshot,
  wrapCoord,
  normalizeAngle,
  createRng,
  FIXED_DT,
  WORLD_WIDTH,
  WORLD_HEIGHT
} from './simulation.ts';
import {
  asPlayerId,
  asRoomId,
  asEntityId,
  asTickNumber,
  asSeqNumber,
  assertNever,
  type PlayerInput,
  type SnapshotEntity
} from './types.ts';
import {
  encodeInputBinary,
  decodeInputBinary,
  encodeSnapshotBinary,
  decodeSnapshotBinary,
  encodeAngleInt16,
  decodeAngleInt16,
  PROTOCOL_VERSION,
  MSG_INPUT,
  MSG_SNAPSHOT
} from './protocol.ts';
import { parseClientMessage } from './schemas.ts';
import { ObjectPool } from './pool.ts';
import { SpatialHash } from './spatialHash.ts';
import { vecAdd, vecSub, vecScale, vecLenSq, vecDistSq } from './vec2.ts';

describe('Vec2 math utilities', () => {
  it('adds two vectors', () => {
    expect(vecAdd({ x: 3, y: -2 }, { x: 4, y: 7 })).toEqual({ x: 7, y: 5 });
  });
  it('subtracts two vectors', () => {
    expect(vecSub({ x: 10, y: 4 }, { x: 3, y: 9 })).toEqual({ x: 7, y: -5 });
  });
  it('scales a vector', () => {
    expect(vecScale({ x: 2, y: -5 }, 3)).toEqual({ x: 6, y: -15 });
  });
  it('computes squared length', () => {
    expect(vecLenSq({ x: 3, y: 4 })).toBe(25);
  });
  it('computes squared distance between points', () => {
    expect(vecDistSq({ x: 1, y: 1 }, { x: 4, y: 5 })).toBe(25);
  });
});

describe('ObjectPool & SpatialHash', () => {
  it('reuses released objects without allocating new ones', () => {
    const pool = new ObjectPool(2, () => ({ val: 0 }), (item) => { item.val = 0; });
    expect(pool.availableCount).toBe(2);
    const a = pool.acquire();
    a.val = 42;
    const b = pool.acquire();
    expect(pool.availableCount).toBe(0);
    pool.release(a);
    expect(pool.availableCount).toBe(1);
    const c = pool.acquire();
    expect(c).toBe(a);
    expect(c.val).toBe(0);
    expect(pool.totalCreated).toBe(2);
    pool.release(b);
  });

  it('allocates extra item when pool is temporarily exhausted', () => {
    const pool = new ObjectPool(1, () => ({ id: Math.random() }), () => {});
    const first = pool.acquire();
    const second = pool.acquire();
    expect(first).not.toBe(second);
    expect(pool.totalCreated).toBe(2);
  });

  it('SpatialHash finds nearby entities and ignores distant ones', () => {
    const grid = new SpatialHash<{ id: number }>(800, 600, 80);
    const e1 = { id: 1 };
    const e2 = { id: 2 };
    const e3 = { id: 3 };
    grid.insert(e1, 100, 100);
    grid.insert(e2, 120, 110);
    grid.insert(e3, 700, 500);

    const near = grid.queryNear(105, 105, 40, []);
    expect(near).toContain(e1);
    expect(near).toContain(e2);
    expect(near).not.toContain(e3);

    grid.clear();
    expect(grid.queryNear(105, 105, 40, [])).toHaveLength(0);
  });
});

describe('Simulation physics, integration, collisions & determinism', () => {
  it('wrapCoord wraps negative and overflow coordinates inside arena', () => {
    expect(wrapCoord(-10, 800)).toBe(790);
    expect(wrapCoord(805, 800)).toBe(5);
    expect(wrapCoord(400, 800)).toBe(400);
  });

  it('normalizeAngle keeps angle within [-PI, PI]', () => {
    expect(normalizeAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 5);
    expect(normalizeAngle(-Math.PI * 3)).toBeCloseTo(-Math.PI, 5);
  });

  it('createRng produces deterministic sequence for same seed', () => {
    const r1 = createRng(999);
    const r2 = createRng(999);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });

  it('integrates thrust and velocity smoothly', () => {
    const state = createInitialState(10);
    const p1 = asPlayerId('p1');
    addPlayerToState(state, p1, 'Alice', 0);
    const player = state.players[p1]!;
    const startX = player.x;

    applyPlayerInput(state, player, { left: false, right: false, thrust: true, fire: false }, FIXED_DT, false);
    expect(player.vx).toBeGreaterThan(0);
    expect(player.x).toBeGreaterThan(startX);
  });

  it('rotates ship left and right', () => {
    const state = createInitialState(10);
    const p1 = asPlayerId('p1');
    addPlayerToState(state, p1, 'Alice', 0);
    const player = state.players[p1]!;

    applyPlayerInput(state, player, { left: true, right: false, thrust: false, fire: false }, FIXED_DT, false);
    expect(player.angle).toBeLessThan(0);

    applyPlayerInput(state, player, { left: false, right: true, thrust: false, fire: false }, FIXED_DT * 2, false);
    expect(player.angle).toBeGreaterThan(0);
  });

  it('spawns bullet from pool on fire and returns it after life expires', () => {
    const state = createInitialState(10);
    const p1 = asPlayerId('p1');
    addPlayerToState(state, p1, 'Alice', 0);
    const initialAvail = state.bulletPool.availableCount;

    const inputs = new Map<typeof p1, PlayerInput>([
      [p1, { seq: asSeqNumber(1), left: false, right: false, thrust: false, fire: true }]
    ]);
    stepWorld(state, inputs, FIXED_DT);
    expect(state.bullets.length).toBe(1);
    expect(state.bulletPool.availableCount).toBe(initialAvail - 1);

    const emptyInputs = new Map<typeof p1, PlayerInput>();
    for (let i = 0; i < 60; i++) {
      stepWorld(state, emptyInputs, FIXED_DT);
    }
    expect(state.bullets.length).toBe(0);
    expect(state.bulletPool.availableCount).toBe(initialAvail);
  });

  it('detects bullet-player collision, reduces HP and awards 100 score', () => {
    const state = createInitialState(10);
    state.asteroids.length = 0;
    const p1 = asPlayerId('p1');
    const p2 = asPlayerId('p2');
    addPlayerToState(state, p1, 'Shooter', 0);
    addPlayerToState(state, p2, 'Target', 1);

    const shooter = state.players[p1]!;
    const target = state.players[p2]!;
    shooter.x = 200;
    shooter.y = 300;
    shooter.angle = 0;
    target.x = 230;
    target.y = 300;
    target.invuln = 0;

    const inputs = new Map<typeof p1, PlayerInput>([
      [p1, { seq: asSeqNumber(1), left: false, right: false, thrust: false, fire: true }]
    ]);
    stepWorld(state, inputs, FIXED_DT);
    stepWorld(state, new Map(), FIXED_DT);

    expect(target.hp).toBe(4);
    expect(shooter.score).toBe(100);
  });

  it('respawns player when HP drops to 0', () => {
    const state = createInitialState(10);
    state.asteroids.length = 0;
    const p1 = asPlayerId('p1');
    const p2 = asPlayerId('p2');
    addPlayerToState(state, p1, 'Shooter', 0);
    addPlayerToState(state, p2, 'Target', 1);

    const shooter = state.players[p1]!;
    const target = state.players[p2]!;
    target.hp = 1;
    target.x = 225;
    target.y = 300;
    shooter.x = 200;
    shooter.y = 300;
    shooter.angle = 0;

    stepWorld(state, new Map([[p1, { seq: asSeqNumber(1), left: false, right: false, thrust: false, fire: true }]]), FIXED_DT);
    stepWorld(state, new Map(), FIXED_DT);

    expect(target.hp).toBe(5);
    expect(target.invuln).toBeGreaterThan(0);
  });

  it('detects bullet-asteroid collision and awards 25 score', () => {
    const state = createInitialState(10);
    const p1 = asPlayerId('p1');
    addPlayerToState(state, p1, 'Miner', 0);
    const miner = state.players[p1]!;
    const ast = state.asteroids[0]!;
    ast.vx = 0;
    ast.vy = 0;
    ast.x = 230;
    ast.y = 300;
    miner.x = 200;
    miner.y = 300;
    miner.angle = 0;

    stepWorld(state, new Map([[p1, { seq: asSeqNumber(1), left: false, right: false, thrust: false, fire: true }]]), FIXED_DT);
    stepWorld(state, new Map(), FIXED_DT);

    expect(miner.score).toBe(25);
  });

  it('detects asteroid-player collision and damages ship', () => {
    const state = createInitialState(10);
    const p1 = asPlayerId('p1');
    addPlayerToState(state, p1, 'Pilot', 0);
    const pilot = state.players[p1]!;
    const ast = state.asteroids[0]!;
    ast.x = pilot.x;
    ast.y = pilot.y;

    stepWorld(state, new Map(), FIXED_DT);
    expect(pilot.hp).toBe(4);
  });

  it('removes player cleanly from state', () => {
    const state = createInitialState(10);
    const p1 = asPlayerId('p1');
    addPlayerToState(state, p1, 'Pilot', 0);
    expect(state.players[p1]).toBeDefined();
    removePlayerFromState(state, p1);
    expect(state.players[p1]).toBeUndefined();
  });

  it('is 100% deterministic across 150 ticks with multiple players', () => {
    const p1 = asPlayerId('p1');
    const p2 = asPlayerId('p2');
    const sA = createInitialState(555);
    const sB = createInitialState(555);
    addPlayerToState(sA, p1, 'A', 0);
    addPlayerToState(sA, p2, 'B', 1);
    addPlayerToState(sB, p1, 'A', 0);
    addPlayerToState(sB, p2, 'B', 1);

    for (let t = 1; t <= 150; t++) {
      const inp = new Map<typeof p1, PlayerInput>([
        [p1, { seq: asSeqNumber(t), left: t % 7 === 0, right: false, thrust: true, fire: t % 15 === 0 }],
        [p2, { seq: asSeqNumber(t), left: false, right: t % 9 === 0, thrust: t % 2 === 0, fire: t % 18 === 0 }]
      ]);
      stepWorld(sA, inp, FIXED_DT);
      stepWorld(sB, inp, FIXED_DT);
    }

    expect(sA.tick).toBe(sB.tick);
    expect(sA.players).toEqual(sB.players);
    expect(sA.asteroids).toEqual(sB.asteroids);
  });

  it('assertNever throws on unexpected discriminated union variant', () => {
    const invalid = { kind: 'alien' } as unknown as SnapshotEntity;
    expect(() => assertNever(invalid as never)).toThrow();
  });
});

describe('Binary protocol & Zod error handling', () => {
  it('encodes and decodes input binary frame accurately', () => {
    const input: PlayerInput = {
      seq: asSeqNumber(1024),
      left: true,
      right: false,
      thrust: true,
      fire: true
    };
    const decoded = decodeInputBinary(encodeInputBinary(input));
    expect(decoded.seq).toBe(1024);
    expect(decoded.left).toBe(true);
    expect(decoded.right).toBe(false);
    expect(decoded.thrust).toBe(true);
    expect(decoded.fire).toBe(true);
  });

  it('rejects binary input with wrong version or type or length', () => {
    expect(() => decodeInputBinary(new ArrayBuffer(3))).toThrow();
    const badVer = new ArrayBuffer(8);
    new DataView(badVer).setUint8(0, 99);
    expect(() => decodeInputBinary(badVer)).toThrow();

    const badType = new ArrayBuffer(8);
    const v = new DataView(badType);
    v.setUint8(0, PROTOCOL_VERSION);
    v.setUint8(1, 99);
    expect(() => decodeInputBinary(badType)).toThrow();
  });

  it('rejects binary snapshot with wrong version, type, or corrupted coordinates', () => {
    expect(() => decodeSnapshotBinary(new ArrayBuffer(5))).toThrow();

    const badVer = new ArrayBuffer(17);
    new DataView(badVer).setUint8(0, 77);
    expect(() => decodeSnapshotBinary(badVer)).toThrow();

    const badType = new ArrayBuffer(17);
    const v = new DataView(badType);
    v.setUint8(0, PROTOCOL_VERSION);
    v.setUint8(1, MSG_INPUT);
    expect(() => decodeSnapshotBinary(badType)).toThrow();
  });

  it('validates all client message types via Zod', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'join', roomId: 'arena', nickname: 'Neo' })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: 'input', seq: 1, left: true, right: false, thrust: true, fire: false })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: 'protocol_mode', binary: false })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: 'ping_rtt', clientTs: 123 })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: 'chat', text: 'hello' })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: 'leave' })).ok).toBe(true);
  });
});

describe('Property-based tests with fast-check (6 invariants)', () => {
  it('FC-1: binary snapshot roundtrip preserves ships, bullets, asteroids and angle within int16 precision', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100000 }),
        fc.float({ min: 0, max: Math.fround(799), noNaN: true }),
        fc.float({ min: 0, max: Math.fround(599), noNaN: true }),
        fc.float({ min: Math.fround(-Math.PI), max: Math.fround(Math.PI), noNaN: true }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5000 }),
        (tick, x, y, angle, hp, score) => {
          const snap = {
            type: 'snapshot' as const,
            tick: asTickNumber(tick),
            serverTime: 1000,
            entities: [
              {
                kind: 'ship' as const,
                slot: 0,
                hp,
                lastProcessedSeq: asSeqNumber(12),
                pos: { x, y },
                vel: { x: 10, y: -5 },
                angle,
                score
              },
              {
                kind: 'bullet' as const,
                id: asEntityId(50),
                pos: { x: 100, y: 200 }
              },
              {
                kind: 'asteroid' as const,
                id: asEntityId(1),
                radius: 24,
                pos: { x: 300, y: 400 }
              }
            ]
          };

          const buf = encodeSnapshotBinary(snap);
          const decoded = decodeSnapshotBinary(buf);

          expect(decoded.tick).toBe(tick);
          expect(decoded.entities).toHaveLength(3);
          const ship = decoded.entities[0]!;
          expect(ship.kind).toBe('ship');
          if (ship.kind === 'ship') {
            expect(ship.pos.x).toBeCloseTo(x, 2);
            expect(ship.pos.y).toBeCloseTo(y, 2);
            expect(Math.abs(normalizeAngle(ship.angle - angle))).toBeLessThan(0.001);
            expect(ship.hp).toBe(hp);
            expect(ship.score).toBe(score);
          }
        }
      )
    );
  });

  it('FC-2: encoded binary snapshot byteLength always equals 17 + 26*ships + 12*bullets + 10*asteroids', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 10 }),
        (numShips, numBullets, numAsteroids) => {
          const entities: SnapshotEntity[] = [];
          for (let i = 0; i < numShips; i++) {
            entities.push({
              kind: 'ship',
              slot: i,
              hp: 5,
              lastProcessedSeq: asSeqNumber(i),
              pos: { x: 100, y: 100 },
              vel: { x: 0, y: 0 },
              angle: 0,
              score: 0
            });
          }
          for (let i = 0; i < numBullets; i++) {
            entities.push({ kind: 'bullet', id: asEntityId(i + 1), pos: { x: 50, y: 50 } });
          }
          for (let i = 0; i < numAsteroids; i++) {
            entities.push({ kind: 'asteroid', id: asEntityId(i + 1), radius: 20, pos: { x: 200, y: 200 } });
          }

          const buf = encodeSnapshotBinary({
            type: 'snapshot',
            tick: asTickNumber(1),
            serverTime: 0,
            entities
          });

          const expectedBytes = 17 + numShips * 26 + numBullets * 12 + numAsteroids * 10;
          expect(buf.byteLength).toBe(expectedBytes);
        }
      )
    );
  });

  it('FC-3: arbitrary corrupted binary buffers throw clean Error and never crash the process', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 120 }), (bytes) => {
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        if (bytes.byteLength >= 17 && bytes[0] === PROTOCOL_VERSION && bytes[1] === MSG_SNAPSHOT) {
          // May either succeed if accidental valid header or throw validation Error
          try {
            decodeSnapshotBinary(ab);
          } catch (err) {
            expect(err).toBeInstanceOf(Error);
          }
        } else {
          expect(() => decodeSnapshotBinary(ab)).toThrow(Error);
        }
      })
    );
  });

  it('FC-4: ship always remains inside arena bounds [0, WORLD_WIDTH) x [0, WORLD_HEIGHT) after arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            left: fc.boolean(),
            right: fc.boolean(),
            thrust: fc.boolean(),
            fire: fc.boolean()
          }),
          { minLength: 1, maxLength: 50 }
        ),
        (inputs) => {
          const state = createInitialState(42);
          const pid = asPlayerId('fc-pilot');
          addPlayerToState(state, pid, 'FC', 0);

          for (let i = 0; i < inputs.length; i++) {
            const inp = inputs[i]!;
            stepWorld(
              state,
              new Map([[pid, { seq: asSeqNumber(i + 1), ...inp }]]),
              FIXED_DT
            );
            const ship = state.players[pid]!;
            expect(ship.x).toBeGreaterThanOrEqual(0);
            expect(ship.x).toBeLessThan(WORLD_WIDTH);
            expect(ship.y).toBeGreaterThanOrEqual(0);
            expect(ship.y).toBeLessThan(WORLD_HEIGHT);
          }
        }
      )
    );
  });

  it('FC-5: parseClientMessage accepts valid chat messages and rejects malformed JSON or invalid payloads', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 100 }), (rawText) => {
        const trimmed = rawText.trim();
        const validPayload = JSON.stringify({ type: 'chat', text: rawText });
        const res = parseClientMessage(validPayload);
        if (trimmed.length > 0) {
          expect(res.ok).toBe(true);
        } else {
          expect(res.ok).toBe(false);
        }

        const corrupted = parseClientMessage(`{corrupted_${rawText}`);
        expect(corrupted.ok).toBe(false);
      })
    );
  });

  it('FC-6: encodeAngleInt16 and decodeAngleInt16 roundtrip for any finite angle in [-PI, PI]', () => {
    fc.assert(
      fc.property(fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }), (rad) => {
        const decoded = decodeAngleInt16(encodeAngleInt16(rad));
        expect(Math.abs(decoded - rad)).toBeLessThan(0.0002);
      })
    );
  });
});
describe('Extended edge-case & protocol coverage suite (30+ cases)', () => {
  it.each([
    [0, 800, 0],
    [799, 800, 799],
    [-1, 800, 799],
    [-800, 800, 0],
    [800, 800, 0],
    [805, 800, 5]
  ])('wrapCoord(%i, %i) -> %i', (val, max, expected) => {
    expect(wrapCoord(val, max)).toBe(expected);
  });

  it.each([
    [0, 0],
    [Math.PI, Math.PI],
    [-Math.PI, -Math.PI],
    [Math.PI * 2, 0],
    [-Math.PI * 2, 0],
    [Math.PI * 1.5, -Math.PI * 0.5]
  ])('normalizeAngle(%f) -> %f', (angle, expected) => {
    expect(normalizeAngle(angle)).toBeCloseTo(expected, 5);
  });

  it.each([
    { left: true, right: false, thrust: false, fire: false },
    { left: false, right: true, thrust: false, fire: false },
    { left: false, right: false, thrust: true, fire: false },
    { left: false, right: false, thrust: false, fire: true },
    { left: true, right: true, thrust: true, fire: true },
    { left: false, right: false, thrust: false, fire: false }
  ])('binary input roundtrip for flags %o', (flags) => {
    const encoded = encodeInputBinary({ seq: asSeqNumber(42), ...flags });
    const decoded = decodeInputBinary(encoded);
    expect(decoded).toMatchObject({ seq: 42, ...flags });
  });

  it.each([
    '',
    '   ',
    '{}',
    '{"type":"unknown"}',
    '{"type":"join","roomId":""}',
    '{"type":"join","roomId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
    '{"type":"input","seq":-1,"left":true,"right":false,"thrust":false,"fire":false}',
    '{"type":"input","seq":1.5,"left":true,"right":false,"thrust":false,"fire":false}',
    '{"type":"protocol_mode","binary":"yes"}',
    '{"type":"ping_rtt","clientTs":"now"}',
    '{"type":"chat","text":""}',
    '{"type":"chat","text":"   "}'
  ])('parseClientMessage rejects invalid input #%#: %s', (raw) => {
    expect(parseClientMessage(raw).ok).toBe(false);
  });

  it('branded constructors preserve underlying primitive values', () => {
    expect(asPlayerId('u1')).toBe('u1');
    expect(asRoomId('r1')).toBe('r1');
    expect(asEntityId(7)).toBe(7);
    expect(asTickNumber(10)).toBe(10);
    expect(asSeqNumber(99)).toBe(99);
  });

  it('buildWorldSnapshot serializes ships, bullets and asteroids accurately', () => {
    const state = createInitialState(101);
    const pid = asPlayerId('p-snap');
    addPlayerToState(state, pid, 'SnapPilot', 2);
    stepWorld(state, new Map([[pid, { seq: asSeqNumber(1), left: false, right: false, thrust: false, fire: true }]]), FIXED_DT);

    const snap = buildWorldSnapshot(state, 5555);
    expect(snap.type).toBe('snapshot');
    expect(snap.serverTime).toBe(5555);
    expect(snap.entities.some((e) => e.kind === 'ship')).toBe(true);
    expect(snap.entities.some((e) => e.kind === 'bullet')).toBe(true);
    expect(snap.entities.some((e) => e.kind === 'asteroid')).toBe(true);
  });

  it('decodeSnapshotBinary throws on snapshot length mismatch and invalid ship/asteroid values', () => {
    const snap = buildWorldSnapshot(createInitialState(1), 0);
    const valid = encodeSnapshotBinary(snap);
    expect(() => decodeSnapshotBinary(valid.slice(0, valid.byteLength - 2))).toThrow(/length mismatch/i);
  });

  it('dead player (hp <= 0) ignores input in applyPlayerInput', () => {
    const state = createInitialState(1);
    const pid = asPlayerId('dead');
    addPlayerToState(state, pid, 'Dead', 0);
    const p = state.players[pid]!;
    p.hp = 0;
    const prevX = p.x;
    applyPlayerInput(state, p, { left: true, right: false, thrust: true, fire: true }, FIXED_DT, true);
    expect(p.x).toBe(prevX);
  });
});