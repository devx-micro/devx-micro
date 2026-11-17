/**
 * The recorder port and the clock — ADR-072 D1, D5, D7.
 *
 * This library holds only the port. The implementation (payload store, redaction, event emission)
 * lives in `libs/platform/observability` and is injected by the composition root; no emitter imports
 * it. `scope:shared` may depend only on `scope:shared`, which is why the port is here and not there.
 */
import type { ContentId } from './content-id';
import type { ContractRecord, IterationRecord } from './inference';
import type { ObservationInput } from './record';

/** The DI token the composition root binds the `Recorder` under; emitters look it up optionally and fall back to `noopRecorder`. */
export const OBSERVATION_RECORDER = 'OBSERVATION_RECORDER';

/** Envelope metadata a seam may attach to the event of one observation (ADR-069 D3, ADR-072 D4a). */
export interface RecordOptions {
  /**
   * Groups events of one unit. For an `inference-run` observation this is the run's `runId` (ADR-073 D3), and the
   * recorder treats it as the key that ties the completion event to its iteration events.
   */
  readonly correlationId?: string;
}

export interface Recorder {
  /**
   * Record one observed unit. Resolves to the content id of the stored observation, or `undefined`
   * when nothing was stored (the no-op recorder). A failure to record must never change the observed
   * unit's own result (ADR-072 D7): implementations report it through telemetry and resolve.
   */
  record(
    observation: ObservationInput,
    options?: RecordOptions,
  ): Promise<ContentId | undefined>;
}

/** What storing an input, output or contract artifact answers: its content id, or why it was withheld (ADR-072 D9). */
export type StoredArtifact =
  | { readonly ref: ContentId }
  | { readonly withheld: string };

/**
 * The inference seam's extra needs (ADR-073): artifacts stored by content id, the contract, and one event per
 * iteration. A `Recorder` that lacks them (the no-op recorder) simply means inference runs are not observed.
 */
export interface InferenceRecorder extends Recorder {
  storeArtifact(text: string): Promise<StoredArtifact>;
  storeContract(contract: ContractRecord): Promise<StoredArtifact>;
  /**
   * Store an iteration record and emit its `observability.inference.iteration-evaluated` event, once per
   * `(runId, iteration)`: a second call for the same pair (a resumed dispatch) answers the first's ref and writes nothing.
   */
  recordIteration(iteration: IterationRecord): Promise<ContentId | undefined>;
}

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

export const noopRecorder: Recorder = {
  record: async () => undefined,
};

/** Wall clock for the two timestamps, monotonic clock for the durations (ADR-072 D5). Injected. */
export interface Clock {
  nowIso(): string;
  monotonicMs(): number;
}

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};

export interface Timing {
  readonly beforeTimestamp: string;
  readonly afterTimestamp: string;
  /** Omitted — never `0` — when the monotonic clock could not measure it (ADR-072 D5). */
  readonly durationMs?: number;
}

/**
 * Start timing a unit. `finish()` measures the duration with the monotonic clock and never by
 * subtracting the two timestamps, because the wall clock can step: `afterTimestamp` may precede
 * `beforeTimestamp`, and that is recorded as it happened.
 *
 * 🔴 **A bad reading never throws.** A failure to record must not change the observed unit's own result
 * (ADR-072 D7), and `finish()` runs in the unit's path. A monotonic reading that is not a finite number,
 * or goes backwards, is a broken reading: the duration is **omitted**, not recorded as a negative or a
 * zero. A `Clock` whose methods themselves throw is a programming error in the injected dependency, not a
 * reading, and propagates: there is no timestamp to record, and swallowing it would hide the bug.
 */
export function startTiming(clock: Clock = systemClock): { finish(): Timing } {
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
