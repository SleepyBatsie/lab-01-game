export function createLoop({ update, render, hudUpdate }) {
  let lastTime = performance.now();
  let accumulator = 0;
  const dt = 1 / 60; // Фіксований крок фізики (60 SPS)

  let frames = 0;
  let steps = 0;
  let fps = 0;
  let sps = 0;
  let lastFpsUpdate = performance.now();

  function tick(currentTime) {
    const frameTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

    accumulator += Math.min(frameTime, 0.25); // Запобігаємо spiral of death

    while (accumulator >= dt) {
      update(dt);
      accumulator -= dt;
      steps++;
    }

    render(accumulator / dt);
    frames++;

    // Оновлюємо метрики та викликаємо hudUpdate кожну секунду
    if (currentTime - lastFpsUpdate >= 1000) {
      fps = frames;
      sps = steps;
      frames = 0;
      steps = 0;
      lastFpsUpdate = currentTime;
    }

    // Викликаємо оновлення HUD у кожному кадрі
    if (typeof hudUpdate === 'function') {
      hudUpdate({ fps, sps });
    }

    requestAnimationFrame(tick);
  }

  return {
    start() {
      lastTime = performance.now();
      lastFpsUpdate = performance.now();
      requestAnimationFrame(tick);
    }
  };
}