import { Vector2 } from '../vector.js';

export class Entity {
  static #nextId = 1; // Приватний статичний лічильник id

  constructor({ pos = new Vector2(), vel = new Vector2(), radius = 10, kind = 'entity' }) {
    this.id = Entity.#nextId++;
    this.pos = pos;
    this.vel = vel;
    this.radius = radius;
    this.kind = kind;
    this.isDead = false;
  }

  destroy() {
    this.isDead = true;
  }

  update(dt, arenaWidth, arenaHeight) {
    // Інтеграція позиції
    this.pos = this.pos.add(this.vel.scale(dt));

    // Wrap-around арени
    if (this.pos.x < 0) this.pos = new Vector2(this.pos.x + arenaWidth, this.pos.y);
    if (this.pos.x > arenaWidth) this.pos = new Vector2(this.pos.x - arenaWidth, this.pos.y);
    if (this.pos.y < 0) this.pos = new Vector2(this.pos.x, this.pos.y + arenaHeight);
    if (this.pos.y > arenaHeight) this.pos = new Vector2(this.pos.x, this.pos.y - arenaHeight);
  }
}