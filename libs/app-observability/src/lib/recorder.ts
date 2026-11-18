/**
 * The recorder port and the clock.
 *
 * This library holds only the port. The implementation (payload store, redaction, event emission)
 * lives in the consuming application and is injected by the composition root; no emitter imports
 * it. This library may depend only on other shared libraries, which is why the port is here and not there.
 */
import type { ContentId } from './content-id';
import type { ContractRecord, IterationRecord } from './inference';
import type { ObservationInput } from './record';

/** The DI token the composition root binds the `Recorder` under; emitters look it up optionally and fall back to `noopRecorder`. */
export const OBSERVATION_RECORDER = 'OBSERVATION_RECORDER';

/** Envelope metadata a seam may attach to the event of one observation. */
export interface RecordOptions {
  /**
   * Groups events of one unit. For an `inference-run` observation this is the run's `runId`, and the
   * recorder treats it as the key that ties the completion event to its iteration events.
   */
  readonly correlationId?: string;
}

/** The port through which a seam records what it observed. Bind an implementation at the composition root. */
export interface Recorder {
  /**
   * Record one observed unit. Resolves to the content id of the stored observation, or `undefined`
   * when nothing was stored (the no-op recorder). A failure to record must never change the observed
   * unit's own result: implementations report it through telemetry and resolve.
   */
  record(
    observation: ObservationInput,
    options?: RecordOptions,
  ): Promise<ContentId | undefined>;
}

/** What storing an input, output or contract artifact answers: its content id, or why it was withheld. */
export type StoredArtifact =
  /** Stored: the artifact's content id. */
  | { readonly ref: ContentId }
  /** Not stored: the reason it was withheld. */
  | { readonly withheld: string };

/**
 * The inference seam's extra needs: artifacts stored by content id, the contract, and one event per
 * iteration. A `Recorder` that lacks them (the no-op recorder) simply means inference runs are not observed.
 */
export interface InferenceRecorder extends Recorder {
  /** Stores text (an input or output) by content id, or reports why it was withheld. */
  storeArtifact(text: string): Promise<StoredArtifact>;
  /** Stores a run's contract by content id, or reports why it was withheld. */
  storeContract(contract: ContractRecord): Promise<StoredArtifact>;
  /**
   * Store an iteration record and emit its `observability.inference.iteration-evaluated` event, once per
   * `(runId, iteration)`: a second call for the same pair (a resumed dispatch) answers the first's ref and writes nothing.
   */
  recordIteration(iteration: IterationRecord): Promise<ContentId | undefined>;
}

/** True when `recorder` can also store inference artifacts, contracts and iterations. */
export function isInferenceRecorder(
  recorder: Recorder | undefined,
): recorder is InferenceRecorder {
  const candidate = recorder as Partial<InferenceRecorder> | undefined;
  return (
    candidate !== undefined &&
    typeof candidate.storeArtifact === 'function' &&
    typeof candidate.storeContract === 'function' &&
    typeof candidate.recordIteration === 'function'
  );
}

/** A recorder that stores nothing and resolves `undefined`; the default when none is bound. */
export const noopRecorder: Recorder = {
  record: async () => undefined,
};

/** Wall clock for the two timestamps, monotonic clock for the durations. Injected. */
export interface Clock {
  /** The current wall-clock time as UTC ISO-8601. */
  nowIso(): string;
  /** A monotonic reading in milliseconds, used only for durations. */
  monotonicMs(): number;
}

/** The real clocks: `Date` for timestamps and `performance.now()` for durations. */
export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};

/** What {@link startTiming}'s `finish()` measures. */
export interface Timing {
  /** When timing started, as UTC ISO-8601. */
  readonly beforeTimestamp: string;
  /** When it finished, as UTC ISO-8601. May precede `beforeTimestamp` if the wall clock stepped back. */
  readonly afterTimestamp: string;
  /** Omitted — never `0` — when the monotonic clock could not measure it. */
  readonly durationMs?: number;
}

/**
 * Start timing a unit. `finish()` measures the duration with the monotonic clock and never by
 * subtracting the two timestamps, because the wall clock can step: `afterTimestamp` may precede
 * `beforeTimestamp`, and that is recorded as it happened.
 *
 * 🔴 **A bad reading never throws.** A failure to record must not change the observed unit's own result,
 * and `finish()` runs in the unit's path. A monotonic reading that is not a finite number,
 * or goes backwards, is a broken reading: the duration is **omitted**, not recorded as a negative or a
 * zero. A `Clock` whose methods themselves throw is a programming error in the injected dependency, not a
 * reading, and propagates: there is no timestamp to record, and swallowing it would hide the bug.
 */
export function startTiming(clock: Clock = systemClock): {
  /** Stops timing and returns the timestamps and, when measurable, the duration. */
  finish(): Timing;
} {
  const beforeTimestamp = clock.nowIso();
  const startedAt = clock.monotonicMs();
  return {
    finish: () => {
      const afterTimestamp = clock.nowIso();
      const reading: unknown = clock.monotonicMs();
      const elapsed =
        typeof reading === 'number' && typeof startedAt === 'number'
          ? reading - startedAt
          : Number.NaN;
      return Number.isFinite(elapsed) && elapsed >= 0
        ? { beforeTimestamp, afterTimestamp, durationMs: elapsed }
        : { beforeTimestamp, afterTimestamp };
    },
  };
}
