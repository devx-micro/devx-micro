/**
 * The bounded recorder wait and its breaker — ADR-072 D7, shared by every seam that records (the CQRS tool runtime,
 * the dispatch seam) so they cannot drift.
 *
 * 🔴 **Recording never changes the observed unit's result.** `run` never throws, and it never waits longer than the
 * bound: a recorder that never settles (a wedged store) must not withhold the answer. A merely slow one is awaited, so
 * a one-shot CLI process still exits after its write.
 *
 * 🔴 **After a TIMEOUT the seam stops asking for a cooldown**, so a wedged store costs the bound once and not on every
 * call. The breaker's clock never throws, a non-finite reading falls back to the wall clock, and a clock stepped
 * backwards ends the pause rather than extending it.
 *
 * 🔴 **The timer is deliberately NOT unref'd.** It is bounded by `timeoutMs`, and an unref'd timer lets a bare
 * one-shot process with nothing else alive exit silently, with code 0, before the answer is written.
 */
export interface BoundedRecordingOptions {
  /** Named in the one stderr line written when the breaker trips, e.g. `cqrs-tool-runtime`. */
  readonly label: string;
  /** How long to wait for the recorder before carrying on anyway (default 2000 ms). */
  readonly timeoutMs?: number;
  /** How long to stop asking after a timeout (default 30 000 ms). */
  readonly cooldownMs?: number;
  /** Millisecond clock for the cooldown (`Date.now` when absent); injected for tests. */
  readonly now?: () => number;
}

/**
 * Runs a recording call with a time bound and a circuit breaker. See {@link BoundedRecordingOptions}
 * for the knobs and the module notes above for the guarantees.
 */
export class BoundedRecording {
  private pausedUntil = 0;
  private pausedFrom = 0;

  public constructor(private readonly options: BoundedRecordingOptions) {}

  private safeNow(): number {
    try {
      const t = (this.options.now ?? Date.now)();
      return Number.isFinite(t) ? t : Date.now();
    } catch {
      return Date.now();
    }
  }

  /** True while the breaker is open: the recorder just timed out and must not be asked yet. */
  public isPaused(): boolean {
    const t = this.safeNow();
    if (t < this.pausedFrom) {
      this.pausedFrom = 0;
      this.pausedUntil = 0;
      return false;
    }
    return t < this.pausedUntil;
  }

  /** Run `work` within the bound. Resolves whatever happens. */
  /**
   * Runs `work`, awaiting it for at most `timeoutMs`. Never throws and never waits longer than the
   * bound; a timeout opens the breaker for `cooldownMs`.
   */
  public async run(work: () => Promise<unknown> | unknown): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        Promise.resolve().then(work),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, this.options.timeoutMs ?? 2000);
        }),
      ]);
    } catch {
      // A recording failure must not change the observed unit's result; the recorder reports its own failures.
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (timedOut) this.trip();
  }

  private trip(): void {
    try {
      const cooldown = this.options.cooldownMs ?? 30_000;
      const from = this.safeNow();
      const alreadyOpen = from >= this.pausedFrom && from < this.pausedUntil;
      this.pausedFrom = from;
      this.pausedUntil = from + cooldown;
      // Silence would look like "nothing happened", so say once that observations are being skipped.
      if (!alreadyOpen)
        process.stderr.write(
          `${this.options.label}: the recorder exceeded its bound; not recording for ${cooldown} ms\n`,
        );
    } catch {
      // Reporting must not itself become a failure.
    }
  }
}
