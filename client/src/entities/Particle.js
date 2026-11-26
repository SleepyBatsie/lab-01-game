import { Entity } from './Entity.js';

export class Particle extends Entity {
  constructor({ pos, vel, color, ttl = 0.5 }) {
    super({ pos, vel, radius: 2, kind: 'particle' });
    this.color = color;
    this.ttl = ttl;
    this.maxTtl = ttl;
  }

  update(dt, arenaWidth, arenaHeight) {
    this.pos = this.pos.add(this.vel.scale(dt));
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.destroy();
    }
  }
}