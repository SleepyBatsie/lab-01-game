# Space Game — Lab 04: Node.js, Streams & WebSockets

Багатокористувацький сервер та клієнт для 2D-гри на базі `npm workspaces` (`client/` та `server/`), потокового логування (`node:stream`) та WebSocket (`ws`).

## Запуск проєкту

```bash
# Встановлення залежностей для обох workspaces
npm install

# Режим розробки (у двох окремих терміналах)
npm run dev:server
npm run dev:client

# Продакшн-збірка клієнта та запуск єдиного сервера (http://localhost:3000)
npm run build:client
npm start