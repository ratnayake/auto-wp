export class DryRunRecorder {
  readonly operations: string[] = [];

  record(description: string): void {
    this.operations.push(description);
  }

  /** In dry-run mode records the description and returns undefined; otherwise runs fn. */
  async wrap<T>(dryRun: boolean, description: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (dryRun) {
      this.record(description);
      return undefined;
    }
    return fn();
  }
}
