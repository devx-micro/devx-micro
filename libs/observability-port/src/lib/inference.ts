/**
 * Inference run records — ADR-073. Pure: types, validators and the decision rule, no I/O.
 *
 * A run is a contract, a sequence of iterations and an overall result. The contract and every iteration are
 * stored by content id in the ADR-072 payload store; the overall result is an ordinary observation of kind
 * `inference-run` whose `detail` is `InferenceRunDetail` (D7a).
 */
import { canonicalJson } from './canonical-json';
import { isContentId, type ContentId } from './content-id';
import type { Confidence, ResultRecord } from './record';
import { requirementId } from './requirement';

export const INFERENCE_SCHEMA_VERSION = 1;

/**
 * 🔴 **The one switch for enforcement.** ADR-073 D2/D8 say a duplicate-requirement or contract-incomplete run is
 * refused before dispatch. The founder ruled on 2026-10-10 (Phase 04) to OBSERVE those runs first: they still
 * dispatch and are recorded as `failure` with the error class as evidence. `'refuse'` restores the ADR text.
 * ADR-073 needs a short amendment (authored on dev, ADR-030) before `'refuse'` is the default again.
 */
export type ContractEnforcement = 'observe' | 'refuse';
export const DEFAULT_CONTRACT_ENFORCEMENT: ContractEnforcement = 'observe';

export const VERDICTS = ['met', 'not-met', 'not-evaluated'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const EVALUATOR_KINDS = ['deterministic', 'model', 'human'] as const;
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];

export interface Evaluator {
  readonly kind: EvaluatorKind;
  readonly identity: string;
  /** True only when `kind` is `model` and the identity is the model that produced the output (D3). */
  readonly selfEvaluated: boolean;
}

export interface EvaluationEntry {
  readonly requirementId: ContentId;
  readonly verdict: Verdict;
  /** A content id or a short factual statement; required for `met` and `not-met` (D4). */
  readonly evidence?: string;
  /** Omitted for `not-evaluated` (D3). */
  readonly evaluator?: Evaluator;
}

export interface EvaluationSummary {
  readonly met: number;
  readonly notMet: number;
  readonly notEvaluated: number;
}

export const ITERATION_DECISIONS = ['accepted', 'rejected'] as const;
export type IterationDecision = (typeof ITERATION_DECISIONS)[number];

/** Why an iteration was decided as it was; `unevaluable` is the code ADR-073 D3 names. */
export const DECISION_REASONS = [
  'no-unmet-requirement',
  'requirement-not-met',
  'unevaluable',
  'no-requirements',
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

export interface RequirementRecord {
  readonly requirementId: ContentId;
  readonly text: string;
}

export const ASSUMPTION_ORIGINS = ['declared', 'stated-by-model'] as const;
export interface AssumptionRecord {
  readonly text: string;
  readonly origin: (typeof ASSUMPTION_ORIGINS)[number];
}

/** ADR-073 D2. Its content id is the `contractRef`, shared by every run that uses it. */
export interface ContractRecord {
  readonly schemaVersion: typeof INFERENCE_SCHEMA_VERSION;
  readonly role: string;
  readonly goal?: string;
  readonly requirements: readonly RequirementRecord[];
  /** Content id of the stored input. Absent only when it was withheld (see `withheld`). */
  readonly input?: ContentId;
  readonly assumptions: readonly AssumptionRecord[];
  /** Content id of the instruction text in force: a changed instruction is a different contract. */
  readonly instructionRef?: ContentId;
  /** Present only when a ref was replaced by redaction: ref name to reason. */
  readonly withheld?: Readonly<Record<string, string>>;
}

/** ADR-073 D3. */
export interface IterationRecord {
  readonly schemaVersion: typeof INFERENCE_SCHEMA_VERSION;
  readonly kind: 'inference-run';
  readonly contractRef: ContentId;
  readonly runId: string;
  /** 1-based. */
  readonly iteration: number;
  readonly outputRef?: ContentId;
  readonly evaluation: readonly EvaluationEntry[];
  readonly timestamp: string;
  readonly evaluationSummary: EvaluationSummary;
  readonly partial: boolean;
  readonly confidence?: Confidence;
  readonly decision: IterationDecision;
  readonly reason: DecisionReason;
  readonly withheld?: Readonly<Record<string, string>>;
}

/** ADR-073 D7a: the part of the completion record that lives in `detail`. */
export interface InferenceRunDetail {
  readonly contractRef: ContentId;
  readonly iterationRefs: readonly ContentId[];
  readonly iterationCeiling: number;
  readonly finalDecision: IterationDecision;
  readonly escalatedTo?: string;
  readonly contractComplete: boolean;
  /** That of the final iteration; omitted when no iteration ran. */
  readonly partial?: boolean;
  /** Token counts, present only when the harness reported them for a run outside our dispatch port (ADR-072 D8). Never `0` for "unknown". */
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}

export function summarizeEvaluation(
  entries: readonly EvaluationEntry[],
): EvaluationSummary {
  let met = 0;
  let notMet = 0;
  let notEvaluated = 0;
  for (const entry of entries) {
    if (entry.verdict === 'met') met += 1;
    else if (entry.verdict === 'not-met') notMet += 1;
    else notEvaluated += 1;
  }
  return { met, notMet, notEvaluated };
}

/** ADR-073 D6: `met / (met + notMet)`, omitted when that denominator is 0. */
export function derivedConfidence(
  summary: EvaluationSummary,
): number | undefined {
  const denominator = summary.met + summary.notMet;
  return denominator === 0 ? undefined : summary.met / denominator;
}

export interface IterationDecisionResult {
  readonly decision: IterationDecision;
  readonly reason: DecisionReason;
  readonly summary: EvaluationSummary;
  readonly partial: boolean;
  readonly confidence?: Confidence;
}

/**
 * ADR-073 D5a. Accepted when, and only when, no requirement is `not-met` and at least one is `met`. Anything else
 * is rejected: with every requirement `not-evaluated` the reason is `unevaluable`, and with no requirement at all
 * it is `no-requirements` (an incomplete contract, D8). `partial` is true for any `not-evaluated` entry.
 */
export function decideIteration(
  entries: readonly EvaluationEntry[],
): IterationDecisionResult {
  const summary = summarizeEvaluation(entries);
  const partial = summary.notEvaluated > 0;
  const derived = derivedConfidence(summary);
  const confidence = derived === undefined ? {} : { confidence: { derived } };
  if (summary.notMet > 0)
    return {
      decision: 'rejected',
      reason: 'requirement-not-met',
      summary,
      partial,
      ...confidence,
    };
  if (summary.met > 0)
    return {
      decision: 'accepted',
      reason: 'no-unmet-requirement',
      summary,
      partial,
      ...confidence,
    };
  return {
    decision: 'rejected',
    reason: entries.length === 0 ? 'no-requirements' : 'unevaluable',
    summary,
    partial,
    ...confidence,
  };
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';
const unknownFields = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): string[] =>
  Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${where}: unknown field ${key}`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;

function describeThrown(thrown: unknown): string {
  try {
    return thrown instanceof Error ? thrown.message : String(thrown);
  } catch {
    return 'a value that cannot be described';
  }
}

/** Run a collector and the final hashability check; never throws. */
function validated(
  input: unknown,
  collect: (input: unknown) => string[],
): readonly string[] {
  try {
    const problems = collect(input);
    if (problems.length === 0) {
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

function withheldProblems(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!isPlainRecord(value))
    return [`${where}.withheld must be an object of reasons`];
  return Object.entries(value)
    .filter(([, reason]) => !isNonEmpty(reason))
    .map(([name]) => `${where}.withheld.${name} must be a non-empty reason`);
}

const CONTRACT_FIELDS = [
  'schemaVersion',
  'role',
  'goal',
  'requirements',
  'input',
  'assumptions',
  'instructionRef',
  'withheld',
];

/** Every violation of the ADR-073 D2 rules a type cannot express; an empty list means valid and hashable. Never throws. */
export function validateContract(input: unknown): readonly string[] {
  return validated(input, (value) => {
    if (!isPlainRecord(value)) return ['the contract must be an object'];
    const problems = unknownFields(value, CONTRACT_FIELDS, 'contract');
    if (value['schemaVersion'] !== INFERENCE_SCHEMA_VERSION)
      problems.push(`schemaVersion must be ${INFERENCE_SCHEMA_VERSION}`);
    if (!isNonEmpty(value['role']))
      problems.push('role must be a non-empty string');
    if (value['goal'] !== undefined && !isNonEmpty(value['goal']))
      problems.push('goal must be a non-empty string, or omitted');
    for (const ref of ['input', 'instructionRef']) {
      if (value[ref] !== undefined && !isContentId(value[ref]))
        problems.push(`${ref} must be a content id, or omitted`);
    }
    problems.push(...withheldProblems(value['withheld'], 'contract'));
    const requirements = value['requirements'];
    if (!Array.isArray(requirements))
      problems.push('requirements must be an array');
    else {
      const seen = new Set<string>();
      requirements.forEach((item: unknown, index) => {
        if (!isPlainRecord(item)) {
          problems.push(`requirements[${index}] must be an object`);
          return;
        }
        problems.push(
          ...unknownFields(
            item,
            ['requirementId', 'text'],
            `requirements[${index}]`,
          ),
        );
        if (!isNonEmpty(item['text'])) {
          problems.push(
            `requirements[${index}].text must be a non-empty string`,
          );
          return;
        }
        if (!isContentId(item['requirementId']))
          problems.push(
            `requirements[${index}].requirementId must be a content id`,
          );
        else {
          if (seen.has(item['requirementId']))
            problems.push(
              `duplicate requirementId ${item['requirementId']} (ADR-073 D2)`,
            );
          seen.add(item['requirementId']);
          try {
            if (requirementId(item['text']) !== item['requirementId'])
              problems.push(
                `requirements[${index}].requirementId does not match the digest of its text`,
              );
          } catch {
            problems.push(`requirements[${index}].text is not well-formed`);
          }
        }
      });
    }
    const assumptions = value['assumptions'];
    if (!Array.isArray(assumptions))
      problems.push('assumptions must be an array');
    else {
      assumptions.forEach((item: unknown, index) => {
        if (!isPlainRecord(item))
          problems.push(`assumptions[${index}] must be an object`);
        else {
          problems.push(
            ...unknownFields(item, ['text', 'origin'], `assumptions[${index}]`),
          );
          if (!isNonEmpty(item['text']))
            problems.push(
              `assumptions[${index}].text must be a non-empty string`,
            );
          if (
            !(ASSUMPTION_ORIGINS as readonly unknown[]).includes(item['origin'])
          )
            problems.push(
              `assumptions[${index}].origin must be one of ${ASSUMPTION_ORIGINS.join(', ')}`,
            );
        }
      });
    }
    return problems;
  });
}

const ITERATION_FIELDS = [
  'schemaVersion',
  'kind',
  'contractRef',
  'runId',
  'iteration',
  'outputRef',
  'evaluation',
  'timestamp',
  'evaluationSummary',
  'partial',
  'confidence',
  'decision',
  'reason',
  'withheld',
];

function entryProblems(item: unknown, index: number): string[] {
  const where = `evaluation[${index}]`;
  if (!isPlainRecord(item)) return [`${where} must be an object`];
  const problems = unknownFields(
    item,
    ['requirementId', 'verdict', 'evidence', 'evaluator'],
    where,
  );
  if (!isContentId(item['requirementId']))
    problems.push(`${where}.requirementId must be a content id`);
  const verdict = item['verdict'];
  if (!(VERDICTS as readonly unknown[]).includes(verdict)) {
    problems.push(`${where}.verdict must be one of ${VERDICTS.join(', ')}`);
    return problems;
  }
  const evaluator = item['evaluator'];
  if (verdict === 'not-evaluated') {
    if (evaluator !== undefined)
      problems.push(
        `${where}.evaluator must be omitted for a not-evaluated entry (ADR-073 D3)`,
      );
    if (item['evidence'] !== undefined && !isNonEmpty(item['evidence']))
      problems.push(`${where}.evidence must be a non-empty string, or omitted`);
    return problems;
  }
  if (!isNonEmpty(item['evidence']))
    problems.push(
      `${where}.evidence is required for a ${String(verdict)} verdict (ADR-073 D4)`,
    );
  if (!isPlainRecord(evaluator))
    problems.push(
      `${where}.evaluator is required for a ${String(verdict)} verdict`,
    );
  else {
    problems.push(
      ...unknownFields(
        evaluator,
        ['kind', 'identity', 'selfEvaluated'],
        `${where}.evaluator`,
      ),
    );
    if (!(EVALUATOR_KINDS as readonly unknown[]).includes(evaluator['kind']))
      problems.push(
        `${where}.evaluator.kind must be one of ${EVALUATOR_KINDS.join(', ')}`,
      );
    if (!isNonEmpty(evaluator['identity']))
      problems.push(`${where}.evaluator.identity must be a non-empty string`);
    if (typeof evaluator['selfEvaluated'] !== 'boolean')
      problems.push(`${where}.evaluator.selfEvaluated must be a boolean`);
    else if (evaluator['selfEvaluated'] && evaluator['kind'] !== 'model')
      problems.push(
        `${where}.evaluator.selfEvaluated is true only when kind is model (ADR-073 D3)`,
      );
  }
  return problems;
}

/** Every violation of the ADR-073 D3 to D6 rules, including that the summary, partial flag, confidence and decision agree with the entries. Never throws. */
export function validateIteration(input: unknown): readonly string[] {
  return validated(input, (value) => {
    if (!isPlainRecord(value)) return ['the iteration must be an object'];
    const problems = unknownFields(value, ITERATION_FIELDS, 'iteration');
    if (value['schemaVersion'] !== INFERENCE_SCHEMA_VERSION)
      problems.push(`schemaVersion must be ${INFERENCE_SCHEMA_VERSION}`);
    if (value['kind'] !== 'inference-run')
      problems.push("kind must be 'inference-run'");
    if (!isContentId(value['contractRef']))
      problems.push('contractRef must be a content id');
    if (typeof value['runId'] !== 'string' || !UUID.test(value['runId']))
      problems.push('runId must be a lower-case UUID');
    if (
      !Number.isInteger(value['iteration']) ||
      (value['iteration'] as number) < 1
    )
      problems.push('iteration must be a whole number >= 1');
    if (value['outputRef'] !== undefined && !isContentId(value['outputRef']))
      problems.push('outputRef must be a content id, or omitted');
    if (typeof value['timestamp'] !== 'string' || !UTC.test(value['timestamp']))
      problems.push('timestamp must be a UTC ISO-8601 timestamp ending in Z');
    problems.push(...withheldProblems(value['withheld'], 'iteration'));
    if (
      !(ITERATION_DECISIONS as readonly unknown[]).includes(value['decision'])
    )
      problems.push(
        `decision must be one of ${ITERATION_DECISIONS.join(', ')}`,
      );
    if (!(DECISION_REASONS as readonly unknown[]).includes(value['reason']))
      problems.push(`reason must be one of ${DECISION_REASONS.join(', ')}`);
    const evaluation = value['evaluation'];
    if (!Array.isArray(evaluation)) {
      problems.push('evaluation must be an array');
      return problems;
    }
    const entryProblemsFound = evaluation.flatMap((item: unknown, index) =>
      entryProblems(item, index),
    );
    problems.push(...entryProblemsFound);
    if (entryProblemsFound.length > 0) return problems;
    const entries = evaluation as readonly EvaluationEntry[];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.requirementId))
        problems.push(
          `duplicate requirementId ${entry.requirementId} in evaluation (ADR-073 D2)`,
        );
      seen.add(entry.requirementId);
    }
    const expected = decideIteration(entries);
    const summary = value['evaluationSummary'];
    if (
      !isPlainRecord(summary) ||
      summary['met'] !== expected.summary.met ||
      summary['notMet'] !== expected.summary.notMet ||
      summary['notEvaluated'] !== expected.summary.notEvaluated
    ) {
      problems.push('evaluationSummary does not match the evaluation entries');
    }
    if (value['partial'] !== expected.partial)
      problems.push(
        'partial does not match the evaluation entries (true when any requirement is not-evaluated)',
      );
    if (value['decision'] !== expected.decision)
      problems.push(
        `decision must be ${expected.decision} for these entries (ADR-073 D5a)`,
      );
    if (value['reason'] !== expected.reason)
      problems.push(`reason must be ${expected.reason} for these entries`);
    const confidence = value['confidence'];
    if (
      JSON.stringify(confidence ?? null) !==
      JSON.stringify(expected.confidence ?? null)
    ) {
      problems.push(
        'confidence must be the derived ratio and nothing else (ADR-073 D6), omitted when nothing was decided',
      );
    }
    return problems;
  });
}

export interface CompleteRunInput {
  readonly contractRef: ContentId;
  readonly contractComplete: boolean;
  /** The `requirementId`s that appeared more than once in the step's requirements. */
  readonly duplicates: readonly string[];
  readonly iterationCeiling: number;
  readonly escalated: boolean;
  readonly escalatedTo?: string;
  /** The last iteration, with its stored content id; absent when no iteration ran. */
  readonly iteration?: IterationRecord;
  readonly iterationRef?: ContentId;
  /** An error class from dispatch itself (`dispatch-failed`, `tool-budget-exceeded`, ...). */
  readonly failureClass?: string;
}

export interface CompletedRun {
  readonly result: ResultRecord;
  readonly detail: InferenceRunDetail;
}

/**
 * ADR-073 D7a, D8: the overall result. An incomplete contract (or a duplicate requirement) can never be accepted, so
 * the run is a `failure` whose first evidence is the error class, whatever the iteration decided. Otherwise a run is a
 * `success` exactly when its last iteration was accepted. `iterations` and `partial` are omitted when no iteration ran.
 */
export function completeRun(input: CompleteRunInput): CompletedRun {
  const classes: string[] = [];
  if (input.duplicates.length > 0) classes.push('duplicate-requirement');
  else if (!input.contractComplete) classes.push('contract-incomplete');
  if (input.failureClass !== undefined) classes.push(input.failureClass);
  const { iteration } = input;
  const accepted = iteration?.decision === 'accepted' && classes.length === 0;
  const evidence = [...classes];
  if (
    iteration !== undefined &&
    classes.length === 0 &&
    iteration.decision === 'rejected'
  ) {
    if (iteration.reason === 'requirement-not-met') {
      evidence.push(
        ...iteration.evaluation
          .filter((entry) => entry.verdict === 'not-met')
          .map((entry) => `not-met:${entry.requirementId}`),
      );
    } else evidence.push(iteration.reason);
  }
  if (evidence.length === 0 && !accepted) {
    // Defensive: a rejected, classless run always carries a reason above; never an empty evidence for a failure.
    evidence.push('rejected');
  }
  const result: ResultRecord = {
    outcome: accepted ? 'success' : 'failure',
    evidence,
    ...(iteration !== undefined ? { iterations: iteration.iteration } : {}),
    escalated: input.escalated,
    ...(iteration?.confidence !== undefined
      ? { confidence: iteration.confidence }
      : {}),
  };
  const detail: InferenceRunDetail = {
    contractRef: input.contractRef,
    iterationRefs: input.iterationRef !== undefined ? [input.iterationRef] : [],
    iterationCeiling: input.iterationCeiling,
    finalDecision: accepted ? 'accepted' : 'rejected',
    ...(input.escalatedTo !== undefined
      ? { escalatedTo: input.escalatedTo }
      : {}),
    contractComplete: input.contractComplete,
    ...(iteration !== undefined ? { partial: iteration.partial } : {}),
  };
  return { result, detail };
}
