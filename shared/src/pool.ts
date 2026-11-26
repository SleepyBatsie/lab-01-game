export class ObjectPool<T> {
  private readonly items: T[] = [];
  private readonly factory: () => T;
  private readonly resetFn: (item: T) => void;
  public totalCreated = 0;

  constructor(initialSize: number, factory: () => T, resetFn: (item: T) => void) {
    this.factory = factory;
    this.resetFn = resetFn;
    for (let i = 0; i < initialSize; i++) {
      this.items.push(this.factory());
      this.totalCreated++;
    }
  }

  public acquire(): T {
    const existing = this.items.pop();
    if (existing !== undefined) {
      return existing;
    }
    this.totalCreated++;
    return this.factory();
  }

  public release(item: T): void {
    this.resetFn(item);
    this.items.push(item);
  }

  public get availableCount(): number {
    return this.items.length;
  }
}