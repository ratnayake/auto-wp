/**
 * Incrementally extracts each object/array found directly inside a top-level JSON object or array
 * (the Wordfence feed is `{ "<uuid>": {record}, ... }`), so the 100+ MB feed is never held as one string.
 */
export class TopLevelValueSplitter {
  private depth = 0;
  private inString = false;
  private escape = false;
  private buf: string[] = [];
  private sawOpen = false;

  /** True once the top-level container was opened and properly closed (not truncated). */
  isComplete(): boolean {
    return this.sawOpen && this.depth === 0 && !this.inString;
  }

  /** Feeds a text chunk; calls `emit` with the raw JSON text of each completed child container. */
  push(chunk: string, emit: (raw: string) => void): void {
    let start = this.depth >= 2 ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (c === 92) this.escape = true;
        else if (c === 34) this.inString = false;
        continue;
      }
      if (c === 34) this.inString = true;
      else if (c === 123 || c === 91) {
        this.depth++;
        this.sawOpen = true;
        if (this.depth === 2) start = i;
      } else if (c === 125 || c === 93) {
        this.depth--;
        if (this.depth === 1 && start >= 0) {
          this.buf.push(chunk.slice(start, i + 1));
          emit(this.buf.join(''));
          this.buf = [];
          start = -1;
        }
      }
    }
    if (this.depth >= 2 && start >= 0) this.buf.push(chunk.slice(start));
  }
}
