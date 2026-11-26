import { Vector2 } from '../vector.js';
import { Entity } from './Entity.js';

export class Bullet extends Entity {
  constructor({ pos, vel, ttl = 1.5, isHoming = false }) {
    super({ pos, vel, radius: 4, kind: 'bullet' });
    this.ttl = ttl;
    this.homing = null;
  }

  update(dt, arenaWidth, arenaHeight, world) {
    if (this.homing) {
      this.homing.update(this, world, dt);
    }
    super.update(dt, arenaWidth, arenaHeight);
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.destroy();
    }
  }

  onCollide(other) {
    if (other.kind === 'asteroid' || other.kind === 'ship') {
      this.destroy();
    }
  }
}