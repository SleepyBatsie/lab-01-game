class GameBus extends EventTarget {
  emit(eventName, detail = {}) {
    this.dispatchEvent(new CustomEvent(eventName, { detail }));
  }
}

export const gameEvents = new GameBus();