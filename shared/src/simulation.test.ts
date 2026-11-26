import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  addPlayerToState,
  stepWorld,
  buildWorldSnapshot,
  FIXED_DT
} from './simulation.ts';
import { asPlayerId, asSeqNumber, type PlayerInput } from './types.ts';
import { encodeSnapshotBinary, decodeSnapshotBinary } from './protocol.ts';
import { parseClientMessage } from './schemas.ts';

test('determinism: identical seeds and inputs produce bit-identical states', () => {
  const p1 = asPlayerId('player-1');
  const p2 = asPlayerId('player-2');

  const stateA = createInitialState(424242);
  const stateB = createInitialState(424242);

  addPlayerToState(stateA, p1, 'Alpha', 0);
  addPlayerToState(stateA, p2, 'Beta', 1);

  addPlayerToState(stateB, p1, 'Alpha', 0);
  addPlayerToState(stateB, p2, 'Beta', 1);

  for (let tick = 1; tick <= 120; tick++) {
    const inputs = new Map<typeof p1, PlayerInput>([
      [p1, { seq: asSeqNumber(tick), left: tick % 15 === 0, right: false, thrust: tick % 3 !== 0, fire: tick % 20 === 0 }],
      [p2, { seq: asSeqNumber(tick), left: false, right: tick % 10 === 0, thrust: true, fire: tick % 25 === 0 }]
    ]);
    stepWorld(stateA, inputs, FIXED_DT);
    stepWorld(stateB, inputs, FIXED_DT);
  }

  assert.deepEqual(stateA, stateB);
});

test('binary snapshot roundtrip and zod malformed message handling', () => {
  const p1 = asPlayerId('p-1');
  const state = createInitialState(777);
  addPlayerToState(state, p1, 'Pilot', 0);
  const snap = buildWorldSnapshot(state, 1234.5);

  const buf = encodeSnapshotBinary(snap);
  const decoded = decodeSnapshotBinary(buf);

  assert.equal(decoded.tick, snap.tick);
  assert.equal(decoded.entities.length, snap.entities.length);

  const badJson = parseClientMessage('{broken json');
  assert.equal(badJson.ok, false);

  const badSchema = parseClientMessage(JSON.stringify({ type: 'join', roomId: '' }));
  assert.equal(badSchema.ok, false);
});