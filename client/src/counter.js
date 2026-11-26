export class Counter {
  constructor(initialValue = 0) {
    this.value = initialValue;
  }

  inc(amount = 1) {
    this.value += amount;
    return this.value;
  }

  dec(amount = 1) {
    this.value -= amount;
    return this.value;
  }

  reset(newValue = 0) {
    this.value = newValue;
    return this.value;
  }

  get() {
    return this.value;
  }
}