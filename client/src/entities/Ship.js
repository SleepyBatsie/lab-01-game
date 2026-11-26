import { Bullet } from './Bullet.js';
import { Entity } from './Entity.js';
import { Vector2 } from '../vector.js';
import { HomingBehavior } from '../components/HomingBehavior.js';
import { gameEvents } from '../events.js';

export class Ship extends Entity {
  constructor(options = {}) {
    super({ ...options, kind: 'ship', radius: 15 });
    this.hp = 3;
    this.maxHp = 3;
    this.angle = 0;
    this.cooldown = 0;
  }

  update(dt, arenaWidth, arenaHeight, world, input) {
    super.update(dt, arenaWidth, arenaHeight);

    if (this.cooldown > 0) {
      this.cooldown -= dt;
    }

    const isPressed = (code) => {
      if (!input) return false;
      if (typeof input.isDown === 'function') return input.isDown(code);
      if (input.keys && typeof input.keys.has === 'function') return input.keys.has(code);
      return false;
    };

    if (isPressed('ArrowLeft') || isPressed('KeyA')) this.angle -= 3 * dt;
    if (isPressed('ArrowRight') || isPressed('KeyD')) this.angle += 3 * dt;
    if (isPressed('ArrowUp') || isPressed('KeyW')) {
      const accel = Vector2.fromAngle(this.angle, 300 * dt);
      this.vel = this.vel.add(accel);
    }

    this.vel = this.vel.scale(0.98);
  }

  fire(world, isHoming = false) {
    if (this.isDead || this.cooldown > 0) return;

    const muzzleOffset = Vector2.fromAngle(this.angle, this.radius + 5);
    const bulletPos = this.pos.add(muzzleOffset);
    const bulletVel = Vector2.fromAngle(this.angle, 400).add(this.vel.scale(0.2));

    const bullet = new Bullet({ pos: bulletPos, vel: bulletVel });

    if (isHoming) {
      bullet.homing = new HomingBehavior({
        targetKind: 'asteroid',
        speed: 350
      });
    }

    world.spawn(bullet);
    this.cooldown = 0.25;

    // Сповіщаємо про постріл через шину подій
    gameEvents.emit('fired');
  }
}