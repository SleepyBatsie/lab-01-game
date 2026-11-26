import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { MatchLogger } from './matchLogger.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

export function createHttpServer(roomsManager) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    // 1. Перевірка стану сервера
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        roomsCount: roomsManager.rooms.size,
        memoryRss: process.memoryUsage().rss
      }));
      return;
    }

    // 2. API кімнат: GET /api/rooms та POST /api/rooms
    if (pathname === '/api/rooms') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(roomsManager.listRooms()));
        return;
      }

      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const roomId = typeof body.id === 'string' && body.id.trim()
            ? body.id.trim()
            : `room-${Math.floor(1000 + Math.random() * 9000)}`;
          const room = roomsManager.getOrCreateRoom(roomId, body.name);

          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(room.toJSON()));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
    }

    // 3. Потокове завантаження реплею: GET /api/replay?file=match-xxx.ndjson
    if (req.method === 'GET' && pathname === '/api/replay') {
      const fileName = url.searchParams.get('file');
      if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid file parameter' }));
        return;
      }
      const fullPath = path.join(config.logDir, fileName);
      MatchLogger.streamReplay(fullPath, res);
      return;
    }

    // 4. Захист від Path Traversal ("..") при роздачі статики
    if (pathname.includes('..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden: Path traversal is not allowed');
      return;
    }

    // 5. Роздача зібраного клієнта (client/dist)
    if (req.method === 'GET') {
      let filePath = path.join(config.clientDistDir, pathname === '/' ? 'index.html' : pathname);
      
      // Додаткова перевірка, що шлях точно всередині clientDistDir
      if (!filePath.startsWith(config.clientDistDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found (Run npm run build:client first if requesting static files)');
      }
      return;
    }

    res.writeHead(405);
    res.end('Method Not Allowed');
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 4096) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}