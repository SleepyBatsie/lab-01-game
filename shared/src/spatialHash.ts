// Просторова сітка (Spatial Hash) для швидкого пошуку колізій O(N) замість O(N^2)
// Використовує повторно виділені масиви комірок, щоб не навантажувати GC у V8
export class SpatialHash<T> {
  private readonly cellSize: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: T[][];

  constructor(worldWidth: number, worldHeight: number, cellSize = 80) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(worldWidth / cellSize);
    this.rows = Math.ceil(worldHeight / cellSize);
    const total = this.cols * this.rows;
    this.cells = Array.from({ length: total }, () => []);
  }

  public clear(): void {
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      if (cell) cell.length = 0;
    }
  }

  private getCellIndex(x: number, y: number): number {
    const col = Math.max(0, Math.min(this.cols - 1, Math.floor(x / this.cellSize)));
    const row = Math.max(0, Math.min(this.rows - 1, Math.floor(y / this.cellSize)));
    return row * this.cols + col;
  }

  public insert(item: T, x: number, y: number): void {
    const idx = this.getCellIndex(x, y);
    const cell = this.cells[idx];
    if (cell) {
      cell.push(item);
    }
  }

  public queryNear(x: number, y: number, radius: number, out: T[]): T[] {
    out.length = 0;
    const minCol = Math.max(0, Math.floor((x - radius) / this.cellSize));
    const maxCol = Math.min(this.cols - 1, Math.floor((x + radius) / this.cellSize));
    const minRow = Math.max(0, Math.floor((y - radius) / this.cellSize));
    const maxRow = Math.min(this.rows - 1, Math.floor((y + radius) / this.cellSize));

    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const cell = this.cells[r * this.cols + c];
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const item = cell[i];
          if (item !== undefined) {
            out.push(item);
          }
        }
      }
    }
    return out;
  }
}