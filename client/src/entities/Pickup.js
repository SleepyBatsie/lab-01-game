import { Entity } from './Entity.js';

export class Pickup extends Entity {
  constructor({ pos, type = 'heal' }) {
    super({ pos, radius: 12, kind: 'pickup' });
    this.type = type;
  }

  onCollide(other, world) {
    if (other.kind === 'ship' && !other.isDead) {
      this.destroy();
      if (this.type === 'heal') {
        other.heal(1);
      }
      world.score += 50;
    }
  }
}