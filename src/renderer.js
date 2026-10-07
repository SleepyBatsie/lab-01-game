export function setupCanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  return ctx;
}

export function interpolateState(prev, curr, alpha) {
  return {
    x: prev.x + (curr.x - prev.x) * alpha,
    y: prev.y + (curr.y - prev.y) * alpha,
    angle: prev.angle + (curr.angle - prev.angle) * alpha,
  };
}

export function render(ctx, shipState, width, height) {
  ctx.clearRect(0, 0, width, height);

  // Фонова сітка
  ctx.strokeStyle = "#1e1e2f";
  ctx.lineWidth = 1;
  const gridSize = 40;
  for (let x = 0; x < width; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Малювання корабля
  ctx.save();
  ctx.translate(shipState.x, shipState.y);
  ctx.rotate(shipState.angle);

  ctx.strokeStyle = "#00ffcc";
  ctx.fillStyle = "#00ffcc22";
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(15, 0); // Ніс
  ctx.lineTo(-10, -10); // Ліве крило
  ctx.lineTo(-5, 0); // Корма
  ctx.lineTo(-10, 10); // Праве крило
  ctx.closePath();

  ctx.fill();
  ctx.stroke();

  ctx.restore();
}
