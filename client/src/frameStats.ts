export class FrameTimeTracker {
  private readonly samples: Float64Array;
  private readonly sortedScratch: Float64Array;
  private cursor = 0;
  private filled = 0;

  constructor(capacity = 300) {
    this.samples = new Float64Array(capacity);
    this.sortedScratch = new Float64Array(capacity);
  }

  public record(frameMs: number): void {
    this.samples[this.cursor] = frameMs;
    this.cursor = (this.cursor + 1) % this.samples.length;
    if (this.filled < this.samples.length) {
      this.filled++;
    }
  }

  public getPercentiles(): { p50: number; p95: number; p99: number } {
    if (this.filled === 0) return { p50: 0, p95: 0, p99: 0 };
    const slice = this.sortedScratch.subarray(0, this.filled);
    slice.set(this.samples.subarray(0, this.filled));
    slice.sort();

    const idx50 = Math.min(this.filled - 1, Math.floor(this.filled * 0.5));
    const idx95 = Math.min(this.filled - 1, Math.floor(this.filled * 0.95));
    const idx99 = Math.min(this.filled - 1, Math.floor(this.filled * 0.99));

    return {
      p50: slice[idx50] ?? 0,
      p95: slice[idx95] ?? 0,
      p99: slice[idx99] ?? 0
    };
  }
}