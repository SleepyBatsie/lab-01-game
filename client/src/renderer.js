export function setupCanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

export function renderWorld(ctx, world, width, height) {
  ctx.clearRect(0, 0, width, height);

  // Background grid
  ctx.strokeStyle = '#1e1e2f';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Entities
  for (const entity of world.entities.values()) {
    if (entity.isDead) continue;

    ctx.save();
    ctx.translate(entity.pos.x, entity.pos.y);

    if (entity.kind === 'ship') {
      ctx.rotate(entity.angle);
      ctx.strokeStyle = '#00ffcc';
      ctx.fillStyle = '#00ffcc22';
      ctx.lineWidth = 2;

      ctx.beginPath();
      ctx.moveTo(15, 0);
      ctx.lineTo(-10, -10);
      ctx.lineTo(-5, 0);
      ctx.lineTo(-10, 10);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (entity.kind === 'bullet') {
      ctx.fillStyle = '#ffcc00';
      ctx.beginPath();
      ctx.arc(0, 0, entity.radius, 0, Math.PI * 2);
      ctx.fill();
    } else if (entity.kind === 'asteroid') {
      ctx.strokeStyle = '#ff6600';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, entity.radius, 0, Math.PI * 2);
      ctx.stroke();
    } else if (entity.kind === 'pickup') {
      ctx.fillStyle = '#00ff55';
      ctx.beginPath();
      ctx.arc(0, 0, entity.radius, 0, Math.PI * 2);
      ctx.fill();
    } else if (entity.kind === 'particle') {
      ctx.fillStyle = entity.color;
      ctx.globalAlpha = entity.ttl / entity.maxTtl;
      ctx.beginPath();
      ctx.arc(0, 0, entity.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}