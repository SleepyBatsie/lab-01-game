import { Particle } from './entities/Particle.js';
import { Vector2 } from './vector.js';

export class World {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.entities = new Map();
    this.score = 0;
  }

  spawn(entity) {
    this.entities.set(entity.id, entity);
    return entity;
  }

  despawn(id) {
    this.entities.delete(id);
  }

  *ofKind(kind) {
    for (const entity of this.entities.values()) {
      if (entity.kind === kind && !entity.isDead) {
        yield entity;
      }
    }
  }

  spawnParticles(pos, count = 10, color = '#ff0055') {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 150;
      const vel = Vector2.fromAngle(angle, speed);
      this.spawn(new Particle({ pos, vel, color, ttl: 0.3 + Math.random() * 0.4 }));
    }
  }

  step(dt, input) {
    for (const entity of this.entities.values()) {
      if (entity.kind === 'ship') {
        entity.update(dt, this.width, this.height, this, input);
      } else {
        entity.update(dt, this.width, this.height, this);
      }
    }

    this.checkCollisions();

    for (const [id, entity] of this.entities) {
      if (entity.isDead) {
        this.despawn(id);
      }
    }
  }

  checkCollisions() {
    const list = Array.from(this.entities.values());
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];

        if (a.isDead || b.isDead) continue;

        const dist = a.pos.distance(b.pos);
        if (dist < a.radius + b.radius) {
          a.onCollide(b, this);
          b.onCollide(a, this);
        }
      }
    }
  }
}