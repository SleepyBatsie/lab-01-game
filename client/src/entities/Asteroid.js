import { Vector2 } from '../vector.js';
import { Entity } from './Entity.js';

export class Asteroid extends Entity {
  constructor({ pos, vel, radius = 20 }) {
    super({ pos, vel, radius, kind: 'asteroid' });
  }

  onCollide(other, world) {
    if (other.kind === 'bullet') {
      this.destroy();
      world.score += 100;
      world.spawnParticles(this.pos, 8, '#ff6600');
    }
  }
}