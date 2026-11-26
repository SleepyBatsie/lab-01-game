import { Vector2 } from '../vector.js';

export class HomingBehavior {
  constructor({ targetKind = 'asteroid', speed = 250, turnRate = 4 }) {
    this.targetKind = targetKind;
    this.speed = speed;
    this.turnRate = turnRate;
  }

  update(entity, world, dt) {
    let closest = null;
    let minDist = Infinity;

    for (const target of world.ofKind(this.targetKind)) {
      const d = entity.pos.distance(target.pos);
      if (d < minDist) {
        minDist = d;
        closest = target;
      }
    }

    if (closest) {
      const desiredDir = closest.pos.sub(entity.pos).normalize();
      const currentDir = entity.vel.normalize();
      const newDir = currentDir.scale(1 - this.turnRate * dt).add(desiredDir.scale(this.turnRate * dt)).normalize();
      entity.vel = newDir.scale(this.speed);
    }
  }
}