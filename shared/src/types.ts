// Branded-типи: запобігають випадковій підміні id, номеру кроку та seq
declare const __brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type PlayerId = Brand<string, 'PlayerId'>;
export type RoomId = Brand<string, 'RoomId'>;
export type EntityId = Brand<number, 'EntityId'>;
export type TickNumber = Brand<number, 'TickNumber'>;
export type SeqNumber = Brand<number, 'SeqNumber'>;

export const asPlayerId = (id: string): PlayerId => id as PlayerId; // Brand constructor
export const asRoomId = (id: string): RoomId => id as RoomId; // Brand constructor
export const asEntityId = (id: number): EntityId => id as EntityId; // Brand constructor
export const asTickNumber = (tick: number): TickNumber => tick as TickNumber; // Brand constructor
export const asSeqNumber = (seq: number): SeqNumber => seq as SeqNumber; // Brand constructor

// Вектор із readonly полями
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

// Вичерпна перевірка switch через never
export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union member: ${JSON.stringify(value)}`);
}

// Сутності у знімку розрізняються полем kind
export interface ShipEntity {
  readonly kind: 'ship';
  readonly slot: number;
  readonly hp: number;
  readonly lastProcessedSeq: SeqNumber;
  readonly pos: Vec2;
  readonly vel: Vec2;
  readonly angle: number;
  readonly score: number;
}

export interface BulletEntity {
  readonly kind: 'bullet';
  readonly id: EntityId;
  readonly pos: Vec2;
}

export interface AsteroidEntity {
  readonly kind: 'asteroid';
  readonly id: EntityId;
  readonly radius: number;
  readonly pos: Vec2;
}

export type SnapshotEntity = ShipEntity | BulletEntity | AsteroidEntity;

export interface WorldSnapshot {
  readonly type: 'snapshot';
  readonly tick: TickNumber;
  readonly serverTime: number;
  readonly entities: readonly SnapshotEntity[];
}

export interface PlayerInput {
  readonly seq: SeqNumber;
  readonly left: boolean;
  readonly right: boolean;
  readonly thrust: boolean;
  readonly fire: boolean;
  readonly clientTs?: number;
}