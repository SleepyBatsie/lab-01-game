import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { RoomsManager } from './wsServer.ts';
import { config } from './config.ts';
import { serverMetrics } from './metrics.ts';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

export interface ServerLifecycleState {
  isShuttingDown: boolean;
}

export function createAppHttpServer(
  roomsManager: RoomsManager,
  publicDir: string,
  lifecycle: ServerLifecycleState = { isShuttingDown: false }
): http.Server {
  return http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const urlPath = rawUrl.split('?')[0] ?? '/';

    if (method === 'GET' && urlPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: 'ok',
          gitSha: config.BUILD_SHA,
          uptimeSec: Math.round(process.uptime())
        })
      );
      return;
    }

    if (method === 'GET' && urlPath === '/ready') {
      const rooms = roomsManager.listRooms();
      const canAccept = !lifecycle.isShuttingDown && rooms.length < config.MAX_ROOMS;
      res.writeHead(canAccept ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ready: canAccept,
          roomsCount: rooms.length,
          maxRooms: config.MAX_ROOMS,
          shuttingDown: lifecycle.isShuttingDown
        })
      );
      return;
    }

    if (method === 'GET' && urlPath === '/metrics') {
      const rooms = roomsManager.listRooms();
      const playersCount = rooms.reduce((sum, r) => sum + r.playersCount, 0);
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(serverMetrics.toPrometheus(rooms.length, playersCount));
      return;
    }

    if (method === 'GET' && urlPath === '/api/rooms') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ rooms: roomsManager.listRooms() }));
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    const safeRelative = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
    let filePath = path.join(publicDir, safeRelative === '\\' || safeRelative === '/' ? 'index.html' : safeRelative);

    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        filePath = path.join(publicDir, 'index.html');
      }

      fs.readFile(filePath, (readErr, data) => {
        if (readErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Client build not found. Run npm run build:client');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      });
    });
  });
}