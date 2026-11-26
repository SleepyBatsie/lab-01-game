import { gameEvents } from './events.js';

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.buffers = {};
  }

  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  setBuffers(buffers) {
    this.buffers = buffers;
  }

  bindEvents() {
    gameEvents.addEventListener('fired', () => this.playSound('shoot'));
    gameEvents.addEventListener('exploded', () => this.playSound('explode'));
  }

  playSound(name) {
    this.init(); 

    if (this.buffers && this.buffers[name]) {
      
      const source = this.ctx.createBufferSource();
      source.buffer = this.buffers[name];
      source.connect(this.ctx.destination);
      source.start(0);
    } else if (name === 'shoot') {
      
      this.playSynthesizedShoot();
    }
  }

  playSynthesizedShoot() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(600, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(80, this.ctx.currentTime + 0.15);

    gain.gain.setValueAtTime(0.2, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.15);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + 0.15);
  }
}

export const audioManager = new AudioManager();