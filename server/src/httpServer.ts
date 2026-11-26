import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { RoomsManager } from './wsServer.ts';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

export function createAppHttpServer(roomsManager: RoomsManager, publicDir: string): http.Server {
  return http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/';

    if (req.method === 'GET' && urlPath === '/api/rooms') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(roomsManager.listRooms()));
      return;
    }

    if (req.method === 'GET' && urlPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    const safeSubPath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = path.resolve(publicDir, safeSubPath);

    if (!filePath.startsWith(path.resolve(publicDir))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
  });
}