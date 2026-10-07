export function createLoop({ update, render, hudUpdate, targetFps = 60 }) {
  const dt = 1 / targetFps;
  const dtMs = dt * 1000;

  let lastTime = performance.now();
  let accumulator = 0;
  let animationFrameId = null;

  let framesCount = 0;
  let stepsCount = 0;
  let lastMetricTime = performance.now();
  let frameTime = 0;

  function tick(currentTime) {
    const elapsed = currentTime - lastTime;
    lastTime = currentTime;
    frameTime = elapsed;

    // Захист від спиралі смерті
    accumulator += Math.min(elapsed, 250);

    while (accumulator >= dtMs) {
      update(dt);
      accumulator -= dtMs;
      stepsCount++;
    }

    const alpha = accumulator / dtMs;
    render(alpha);
    framesCount++;

    // Оновлення метрик щосекунди
    if (currentTime - lastMetricTime >= 1000) {
      hudUpdate({
        fps: framesCount,
        sps: stepsCount,
        frameTime: frameTime.toFixed(2),
      });
      framesCount = 0;
      stepsCount = 0;
      lastMetricTime = currentTime;
    }

    animationFrameId = requestAnimationFrame(tick);
  }

  return {
    start() {
      lastTime = performance.now();
      lastMetricTime = lastTime;
      animationFrameId = requestAnimationFrame(tick);
    },
    stop() {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    },
  };
}
