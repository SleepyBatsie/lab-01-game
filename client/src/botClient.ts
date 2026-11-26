import { GameSocket } from './wsClient.ts';
import { asSeqNumber } from '@space-game/shared/types';

// Бот підключається як звичайний клієнт і надсилає стандартний PlayerInput
export class BotClient {
  private readonly socket: GameSocket;
  private timer: number | null = null;
  private seq = 0;
  private phase: number;

  constructor(roomId: string, botIndex: number) {
    this.socket = new GameSocket();
    this.phase = botIndex * 1.1;
    this.socket.connect();
    this.socket.send({ type: 'join', roomId, nickname: `Bot_${botIndex + 1}` });

    this.timer = window.setInterval(() => {
      this.seq++;
      this.phase += 0.12;
      this.socket.sendInput({
        seq: asSeqNumber(this.seq),
        left: Math.sin(this.phase) > 0.55,
        right: Math.sin(this.phase) < -0.55,
        thrust: Math.cos(this.phase * 0.7) > -0.3,
        fire: this.seq % 12 === 0
      });
    }, 1000 / 30);
  }

  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.socket.send({ type: 'leave' });
  }
}