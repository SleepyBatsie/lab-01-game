export function createShip(x, y) {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2, // Дивиться вгору
    rotationSpeed: 3.5, // рад/с
    thrust: 250, // пікселів/с²
    drag: 0.98, // Опір середовища
    radius: 15,
  };
}

export function integrate(ship, input, dt, arenaWidth, arenaHeight) {
  // Чиста функція: повертаємо новий об'єкт, а не мутуємо старий
  const nextShip = { ...ship };

  // Поворот (A/D або Стрілки)
  if (input.isPressed("ArrowLeft") || input.isPressed("KeyA")) {
    nextShip.angle -= nextShip.rotationSpeed * dt;
  }
  if (input.isPressed("ArrowRight") || input.isPressed("KeyD")) {
    nextShip.angle += nextShip.rotationSpeed * dt;
  }

  // Тяга (W або Стрілка вгору)
  if (input.isPressed("ArrowUp") || input.isPressed("KeyW")) {
    nextShip.vx += Math.cos(nextShip.angle) * nextShip.thrust * dt;
    nextShip.vy += Math.sin(nextShip.angle) * nextShip.thrust * dt;
  }

  // Застосування швидкості
  nextShip.x += nextShip.vx * dt;
  nextShip.y += nextShip.vy * dt;

  // Сповільнення / опір
  nextShip.vx *= nextShip.drag ** (dt * 60);
  nextShip.vy *= nextShip.drag ** (dt * 60);

  // «Загортання» країв арени (Wrap-around)
  if (nextShip.x < 0) nextShip.x += arenaWidth;
  if (nextShip.x > arenaWidth) nextShip.x -= arenaWidth;
  if (nextShip.y < 0) nextShip.y += arenaHeight;
  if (nextShip.y > arenaHeight) nextShip.y -= arenaHeight;

  return nextShip;
}
