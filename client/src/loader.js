const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, options = {}, retries = 3, backoff = 300) {
  try {
    const res = await fetch(url, { signal: options.signal });
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`HTTP Error ${res.status}`);
      }
      throw new Error(`Server Error ${res.status}`);
    }
    return res;
  } catch (err) {
    if (err.name === 'AbortError' || retries <= 0) throw err;
    const jitter = Math.random() * 200;
    await delay(backoff + jitter);
    return fetchWithRetry(url, options, retries - 1, backoff * 2);
  }
}

export async function fetchJson(url, signal) {
  const res = await fetchWithRetry(url, { signal });
  return await res.json();
}

export async function loadImage(url, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    
    const img = new Image();
    img.onload = () => resolve(img);
    
    img.onerror = () => {
      console.warn(`[Loader Warning] Помилка завантаження зображення: ${url}. Створюємо заглушку.`);
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ff0055';
      ctx.fillRect(0, 0, 32, 32);
      
      const fallbackImg = new Image();
      fallbackImg.src = canvas.toDataURL();
      resolve(fallbackImg);
    };

    img.src = url;
  });
}

export async function loadAudio(url, audioCtx, signal) {
  try {
    const res = await fetchWithRetry(url, { signal });
    const arrayBuffer = await res.arrayBuffer();
    return await audioCtx.decodeAudioData(arrayBuffer);
  } catch (err) {
    console.warn(`[Loader Warning] Помилка завантаження аудіо: ${url}`);
    return null;
  }
}

export async function loadAll(manifestUrl, audioCtx, ctx, width, height) {
  drawProgress(ctx, width, height, 0, 'Завантаження маніфесту...');
  const manifest = await fetchJson(manifestUrl);

  const tasks = [];
  if (manifest.images) {
    for (const [key, url] of Object.entries(manifest.images)) {
      tasks.push({ key, type: 'image', url });
    }
  }
  if (manifest.audio && audioCtx) {
    for (const [key, url] of Object.entries(manifest.audio)) {
      tasks.push({ key, type: 'audio', url });
    }
  }

  let completed = 0;
  const total = tasks.length || 1;
  const assets = { images: {}, audio: {} };

  const promises = tasks.map(async (task) => {
    if (task.type === 'image') {
      assets.images[task.key] = await loadImage(task.url);
    } else if (task.type === 'audio') {
      assets.audio[task.key] = await loadAudio(task.url, audioCtx);
    }
    completed++;
    drawProgress(ctx, width, height, completed / total, `Завантажено: ${task.key}`);
  });

  await Promise.all(promises);
  return assets;
}

function drawProgress(ctx, width, height, progress, text) {
  ctx.fillStyle = '#0f0f1b';
  ctx.fillRect(0, 0, width, height);

  const barWidth = width * 0.6;
  const barHeight = 20;
  const x = (width - barWidth) / 2;
  const y = height / 2;

  ctx.strokeStyle = '#00ffcc';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, barWidth, barHeight);

  ctx.fillStyle = '#00ffcc';
  ctx.fillRect(x + 2, y + 2, (barWidth - 4) * progress, barHeight - 4);

  ctx.fillStyle = '#ffffff';
  ctx.font = '16px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${text} (${Math.round(progress * 100)}%)`, width / 2, y - 15);
}