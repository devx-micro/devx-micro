/**
 * The observation record — ADR-072 D4 to D6. The fields are a closed list: a new field or a changed
 * meaning bumps `schemaVersion` and starts with an ADR amendment. A kind's own fields live in `detail`,
 * whose schema the ADR that defines the kind owns (ADR-073 for `inference-run`).
 */
import { canonicalJson } from './canonical-json';
import { isContentId, type ContentId } from './content-id';

export const OBSERVATION_SCHEMA_VERSION = 1;

export const OBSERVATION_KINDS = ['operation', 'workflow-step', 'tool-call', 'dispatch', 'inference-run'] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export const OUTCOMES = ['success', 'failure', 'blocked', 'skipped'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
  /** Present only when the provider reported it. */
  readonly version?: string;
  readonly route: 'local' | 'cloud';
}

/** Each member is present only when it exists; both may be absent, in which case omit `confidence`. */
export interface Confidence {
  /** What the model said. Recorded for calibration; never used to gate or rank. */
  readonly selfReported?: number;
  /** Computed by the harness; the only value treated as evidence. */
  readonly derived?: number;
}

export interface ResultRecord {
  readonly outcome: Outcome;
  /** Content ids or short factual strings. Required to be non-empty for `failure` and `blocked`. */
  readonly evidence: readonly string[];
  /** Present only where the unit iterates. */
  readonly iterations?: number;
  /** Present only where the unit can escalate; an escalated unit may still have succeeded. */
  readonly escalated?: boolean;
  /** Present only for model-produced results. */
  readonly confidence?: Confidence;
}

export interface ObservationRecord {
  readonly schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  readonly kind: ObservationKind;
  /** The tool, CLI or role that ran it. */
  readonly operator: string;
  readonly operation: string;
  readonly model?: ModelRef;
  /** UTC ISO-8601. */
  readonly beforeTimestamp: string;
  readonly afterTimestamp: string;
  /** Whole-unit wall time from the monotonic clock. Omitted — never `0` — when not measured. */
  readonly durationMs?: number;
  /** Time for a remote or model call to answer. Omitted — never `0` — when not measured. */
  readonly latencyMs?: number;
  /** Present, and exactly `true`, only on records written by the harness for runs outside our dispatch port. */
  readonly external?: true;
  /** Named content ids of artifacts stored separately (`journalSlice`, `input`, `output`, `arguments`). */
  readonly refs?: Readonly<Record<string, ContentId>>;
  /** A kind's own fields; the schema belongs to the ADR that defines the kind. */
  readonly detail?: Readonly<Record<string, unknown>>;
  /** Present only when a payload was withheld: ref name to reason. */
  readonly withheld?: Readonly<Record<string, string>>;
  readonly result: ResultRecord;
}

/**
 * What a seam hands to a recorder; the recorder stamps `schemaVersion`.
 *
 * 🔴 **There is no `external` member.** The marker has one writer, the ADR-072 D8 harness operation, which reaches it
 * through the observability context's own `recordExternal`, not through the port a seam depends on. A caller that
 * smuggles the key past the type is refused at runtime by the recorder.
 */
export type ObservationInput = Omit<ObservationRecord, 'schemaVersion' | 'external'>;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmpty = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
const isMeasure = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isUnitInterval = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const UTC_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;

/** UTC ISO-8601 with a `Z`, naming a moment that exists (no `02-31`, no `T24:00:00`). */
function parseUtcTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) return undefined;
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) return undefined;
  // V8 rolls an impossible date over; a round trip through the calendar part exposes it.
  return new Date(millis).toISOString().slice(0, 19) === value.slice(0, 19) ? millis : undefined;
}

const TOP_LEVEL_FIELDS = [
  'schemaVersion', 'kind', 'operator', 'operation', 'model', 'beforeTimestamp', 'afterTimestamp',
  'durationMs', 'latencyMs', 'external', 'refs', 'detail', 'withheld', 'result',
];
const RESULT_FIELDS = ['outcome', 'evidence', 'iterations', 'escalated', 'confidence'];
const MODEL_FIELDS = ['provider', 'modelId', 'version', 'route'];
const CONFIDENCE_FIELDS = ['selfReported', 'derived'];
/** Parts of the record itself that can be withheld without being a separately stored ref (ADR-072 D9). */
const RECORD_OWN_WITHHELD = ['detail', 'evidence'];

const unknownFields = (value: Record<string, unknown>, allowed: readonly string[], where: string): string[] =>
  Object.keys(value).filter((key) => !allowed.includes(key)).map((key) => `${where}: unknown field ${key} (the field list is closed, ADR-072 D4)`);

/** Text for whatever was thrown, even a value whose own `toString` throws. */
function describeThrown(thrown: unknown): string {
  try {
    return thrown instanceof Error ? thrown.message : String(thrown);
  } catch {
    return 'a value that cannot be described';
  }
}

/**
 * Every violation of the ADR-072 rules a type alone cannot express; an empty list means the record is
 * valid **and recordable**: the last check asks `canonicalJson` whether the record can be hashed, so a
 * record that validates never fails later with a throw (a sparse array, a lone surrogate, a `Date` in
 * `detail`, an inherited field, a cycle).
 *
 * It accepts `unknown` and never throws: a getter or proxy that throws becomes a problem.
 * The record is read twice (validated, then hashed), so "valid implies recordable" holds for plain
 * data; a hostile stateful getter that answers differently per read is outside that guarantee. It enforces
 * the closed field list, the shapes, and the value ranges. It cannot tell a measured `0` from a
 * fabricated one, so "absent is never zero" is a rule for the emitter (and its review), not a property
 * this function can check.
 */
export function validateObservation(input: unknown): readonly string[] {
  try {
    const problems = [...collectProblems(input)];
    // Only an otherwise clean record is asked: a record already reported as wrong would just repeat itself.
    if (problems.length === 0 && isPlainRecord(input)) {
      try {
        canonicalJson(input);
      } catch (error) {
        problems.push(`the record cannot be hashed: ${describeThrown(error)}`);
      }
    }
    return problems;
  } catch (error) {
    return [`the record could not be read: ${describeThrown(error)}`];
  }
}

function collectProblems(input: unknown): readonly string[] {
  if (!isPlainRecord(input)) return ['the record must be an object'];
  const record = input;
  const problems: string[] = unknownFields(record, TOP_LEVEL_FIELDS, 'record');
  if (record['schemaVersion'] !== OBSERVATION_SCHEMA_VERSION) problems.push(`schemaVersion must be ${OBSERVATION_SCHEMA_VERSION}`);
  if (!OBSERVATION_KINDS.includes(record['kind'] as ObservationKind)) problems.push(`kind must be one of ${OBSERVATION_KINDS.join(', ')}`);
  if (!isNonEmpty(record['operator'])) problems.push('operator must be a non-empty string');
  if (!isNonEmpty(record['operation'])) problems.push('operation must be a non-empty string');
  if (parseUtcTimestamp(record['beforeTimestamp']) === undefined) problems.push('beforeTimestamp must be a UTC ISO-8601 timestamp ending in Z');
  if (parseUtcTimestamp(record['afterTimestamp']) === undefined) problems.push('afterTimestamp must be a UTC ISO-8601 timestamp ending in Z');
  // No ordering check: the wall clock can step backwards (ADR-072 D5), and a unit that ran correctly
  // must still be recordable. `durationMs` comes from the monotonic clock, not from these two.
  for (const field of ['durationMs', 'latencyMs']) {
    if (record[field] !== undefined && !isMeasure(record[field])) problems.push(`${field} must be a finite number >= 0, or omitted`);
  }
  if (record['model'] !== undefined) {
    const model = record['model'];
    if (!isPlainRecord(model)) problems.push('model must be an object');
    else {
      problems.push(...unknownFields(model, MODEL_FIELDS, 'model'));
      if (model['route'] !== 'local' && model['route'] !== 'cloud') problems.push("model.route must be 'local' or 'cloud'");
      if (!isNonEmpty(model['provider']) || !isNonEmpty(model['modelId'])) problems.push('model.provider and model.modelId must be non-empty');
      if (model['version'] !== undefined && !isNonEmpty(model['version'])) problems.push('model.version must be a non-empty string, or omitted');
    }
  }
  if (record['external'] !== undefined && record['external'] !== true) problems.push('external must be exactly true when present');
  let refNames: string[] = [];
  if (record['refs'] !== undefined) {
    if (!isPlainRecord(record['refs'])) problems.push('refs must be an object of content ids');
    else {
      refNames = Object.keys(record['refs']);
      for (const [name, ref] of Object.entries(record['refs'])) if (!isContentId(ref)) problems.push(`refs.${name} must be a content id`);
    }
  }
  if (record['detail'] !== undefined && !isPlainRecord(record['detail'])) problems.push('detail must be an object');
  if (record['withheld'] !== undefined) {
    if (!isPlainRecord(record['withheld'])) problems.push('withheld must be an object of reasons');
    else {
      for (const [name, reason] of Object.entries(record['withheld'])) {
        if (!refNames.includes(name) && !RECORD_OWN_WITHHELD.includes(name)) {
          problems.push(`withheld.${name} must name a ref that was replaced, or one of ${RECORD_OWN_WITHHELD.join(', ')}`);
        }
        if (!isNonEmpty(reason)) problems.push(`withheld.${name} must be a non-empty reason`);
        // A present detail is allowed only after a PARTIAL redaction, which names what it dropped: `redacted: <kinds> (a, b)`.
        // The named properties must really be absent from the detail that remains.
        if (name === 'detail' && record['detail'] !== undefined) {
          const named = typeof reason === 'string' ? /\(([^()]*)\)$/.exec(reason)?.[1] : undefined;
          const names = named === undefined ? [] : named.split(',').map((part) => part.trim());
          const present = isPlainRecord(record['detail']) ? Object.keys(record['detail']) : [];
          if (names.length === 0 || names.some((part) => part === '')) {
            problems.push('withheld.detail claims the detail was withheld, but a detail is present and the reason names no dropped property');
          } else if (names.some((part) => part !== '<unnamed>' && present.includes(part))) {
            problems.push('withheld.detail names a property that is still present in the detail');
          }
        }
        if (name === 'evidence') {
          const entries = isPlainRecord(record['result']) && Array.isArray(record['result']['evidence']) ? record['result']['evidence'] : [];
          if (!entries.some((entry) => typeof entry === 'string' && entry.startsWith('withheld:'))) {
            problems.push('withheld.evidence claims evidence was withheld, but no evidence entry is a withheld marker');
          }
        }
      }
    }
  }
  const result = record['result'];
  if (!isPlainRecord(result)) {
    problems.push('result must be an object');
    return problems;
  }
  problems.push(...unknownFields(result, RESULT_FIELDS, 'result'));
  if (!OUTCOMES.includes(result['outcome'] as Outcome)) problems.push(`result.outcome must be one of ${OUTCOMES.join(', ')}`);
  const evidence = result['evidence'];
  if (!Array.isArray(evidence) || !evidence.every(isNonEmpty)) problems.push('result.evidence must be an array of non-empty strings');
  else if ((result['outcome'] === 'failure' || result['outcome'] === 'blocked') && evidence.length === 0) {
    problems.push(`result.evidence must be non-empty for a ${String(result['outcome'])} (at least the error class)`);
  }
  if (result['iterations'] !== undefined && !(Number.isInteger(result['iterations']) && (result['iterations'] as number) >= 0)) {
    problems.push('result.iterations must be a whole number >= 0, or omitted');
  }
  if (result['escalated'] !== undefined && typeof result['escalated'] !== 'boolean') problems.push('result.escalated must be a boolean, or omitted');
  if (result['confidence'] !== undefined) {
    const confidence = result['confidence'];
    if (!isPlainRecord(confidence)) problems.push('result.confidence must be an object');
    else {
      problems.push(...unknownFields(confidence, CONFIDENCE_FIELDS, 'result.confidence'));
      if (confidence['selfReported'] === undefined && confidence['derived'] === undefined) problems.push('result.confidence must be omitted when it has no member');
      if (confidence['selfReported'] !== undefined && !isUnitInterval(confidence['selfReported'])) problems.push('result.confidence.selfReported must be within 0 to 1');
      if (confidence['derived'] !== undefined && !isUnitInterval(confidence['derived'])) problems.push('result.confidence.derived must be within 0 to 1');
    }
  }
  return problems;
}
