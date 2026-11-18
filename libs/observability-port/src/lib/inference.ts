/**
 * Inference run records. Pure: types, validators and the decision rule, no I/O.
 *
 * A run is a contract, a sequence of iterations and an overall result. The contract and every iteration are
 * stored by content id in the payload store; the overall result is an ordinary observation of kind
 * `inference-run` whose `detail` is `InferenceRunDetail`.
 */
import { canonicalJson } from './canonical-json';
import { isContentId, type ContentId } from './content-id';
import type { Confidence, ResultRecord } from './record';
import { requirementId } from './requirement';

/** The schema version of contract and iteration records. A changed field or meaning bumps it. */
export const INFERENCE_SCHEMA_VERSION = 1;

/**
 * 🔴 **The one switch for enforcement.** By design, a duplicate-requirement or contract-incomplete run is
 * refused before dispatch (`'refuse'`). The default is to OBSERVE those runs first: they still dispatch and are
 * recorded as `failure` with the error class as evidence.
 */
export type ContractEnforcement = 'observe' | 'refuse';
/** What enforcement a seam uses when none is configured: `'observe'`. */
export const DEFAULT_CONTRACT_ENFORCEMENT: ContractEnforcement = 'observe';

/** The verdicts an evaluator can give for one requirement. `not-evaluated` means nobody decided it. */
export const VERDICTS = ['met', 'not-met', 'not-evaluated'] as const;
/** One of {@link VERDICTS}. */
export type Verdict = (typeof VERDICTS)[number];

/** Who or what produced a verdict: a rule, a model or a person. */
export const EVALUATOR_KINDS = ['deterministic', 'model', 'human'] as const;
/** One of {@link EVALUATOR_KINDS}. */
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];

/** The party that gave a verdict. */
export interface Evaluator {
  /** Whether the verdict came from a rule, a model or a person. */
  readonly kind: EvaluatorKind;
  /** A stable name for the evaluator: a rule id, a model id, or a person's handle. */
  readonly identity: string;
  /** True only when `kind` is `model` and the identity is the model that produced the output. */
  readonly selfEvaluated: boolean;
}

/** The verdict on one requirement within one iteration. */
export interface EvaluationEntry {
  /** The requirement this entry decides. */
  readonly requirementId: ContentId;
  /** `met`, `not-met` or `not-evaluated`. */
  readonly verdict: Verdict;
  /** A content id or a short factual statement; required for `met` and `not-met`. */
  readonly evidence?: string;
  /** Omitted for `not-evaluated`. */
  readonly evaluator?: Evaluator;
}

/** Counts of each verdict across one iteration's entries; see {@link summarizeEvaluation}. */
export interface EvaluationSummary {
  /** Entries with verdict `met`. */
  readonly met: number;
  /** Entries with verdict `not-met`. */
  readonly notMet: number;
  /** Entries with verdict `not-evaluated`. */
  readonly notEvaluated: number;
}

/** The two outcomes of deciding an iteration. */
export const ITERATION_DECISIONS = ['accepted', 'rejected'] as const;
/** One of {@link ITERATION_DECISIONS}. */
export type IterationDecision = (typeof ITERATION_DECISIONS)[number];

/** Why an iteration was decided as it was; `unevaluable` is the code for a run with nothing evaluable. */
export const DECISION_REASONS = [
  'no-unmet-requirement',
  'requirement-not-met',
  'unevaluable',
  'no-requirements',
] as const;
/** One of {@link DECISION_REASONS}. */
export type DecisionReason = (typeof DECISION_REASONS)[number];

/** One requirement of a contract. */
export interface RequirementRecord {
  /** The identity of the claim; see `requirementId()`. */
  readonly requirementId: ContentId;
  /** The requirement text as written. */
  readonly text: string;
}

/** Where an assumption came from: written in the step (`declared`) or added by the model (`stated-by-model`). */
export const ASSUMPTION_ORIGINS = ['declared', 'stated-by-model'] as const;
/** An assumption the run proceeded on. */
export interface AssumptionRecord {
  /** The assumption as stated. */
  readonly text: string;
  /** Who stated it. */
  readonly origin: (typeof ASSUMPTION_ORIGINS)[number];
}

/** Its content id is the `contractRef`, shared by every run that uses it. */
export interface ContractRecord {
  /** The record schema version; always {@link INFERENCE_SCHEMA_VERSION}. */
  readonly schemaVersion: typeof INFERENCE_SCHEMA_VERSION;
  /** The role the model was asked to take. */
  readonly role: string;
  /** What the step is for. Omitted when the step states none. */
  readonly goal?: string;
  /** What the output must satisfy, in order of first appearance. */
  readonly requirements: readonly RequirementRecord[];
  /** Content id of the stored input. Absent only when it was withheld (see `withheld`). */
  readonly input?: ContentId;
  /** Assumptions the run proceeded on. */
  readonly assumptions: readonly AssumptionRecord[];
  /** Content id of the instruction text in force: a changed instruction is a different contract. */
  readonly instructionRef?: ContentId;
  /** Present only when a ref was replaced by redaction: ref name to reason. */
  readonly withheld?: Readonly<Record<string, string>>;
}

/** The evaluated result of one attempt within an inference run. */
export interface IterationRecord {
  /** The record schema version; always {@link INFERENCE_SCHEMA_VERSION}. */
  readonly schemaVersion: typeof INFERENCE_SCHEMA_VERSION;
  /** Always `inference-run`. */
  readonly kind: 'inference-run';
  /** The content id of the run's {@link ContractRecord}. */
  readonly contractRef: ContentId;
  /** Identifies the run; also the correlation id of its events. */
  readonly runId: string;
  /** 1-based. */
  readonly iteration: number;
  /** Content id of the stored output. Absent when it was withheld (see `withheld`). */
  readonly outputRef?: ContentId;
  /** One entry per requirement, in contract order. */
  readonly evaluation: readonly EvaluationEntry[];
  /** When the iteration was evaluated, as UTC ISO-8601. */
  readonly timestamp: string;
  /** The verdict counts of `evaluation`. */
  readonly evaluationSummary: EvaluationSummary;
  /** True when any requirement is `not-evaluated`. */
  readonly partial: boolean;
  /** Present only when it can be derived; see {@link derivedConfidence}. */
  readonly confidence?: Confidence;
  /** Whether this iteration was accepted. */
  readonly decision: IterationDecision;
  /** Why it was decided that way. */
  readonly reason: DecisionReason;
  /** Present only when a ref was replaced by redaction: ref name to reason. */
  readonly withheld?: Readonly<Record<string, string>>;
}

/** The part of the completion record that lives in `detail`. */
export interface InferenceRunDetail {
  /** The content id of the run's contract. */
  readonly contractRef: ContentId;
  /** The content ids of the stored iteration records. */
  readonly iterationRefs: readonly ContentId[];
  /** The most iterations the run was allowed. */
  readonly iterationCeiling: number;
  /** Whether the last iteration was accepted. */
  readonly finalDecision: IterationDecision;
  /** Who the run was escalated to, if it was. */
  readonly escalatedTo?: string;
  /** False for a contract with no requirements or a duplicate one. */
  readonly contractComplete: boolean;
  /** That of the final iteration; omitted when no iteration ran. */
  readonly partial?: boolean;
  /** Token counts, present only when the harness reported them for a run outside our dispatch port. Never `0` for "unknown". */
  readonly usage?: {
    /** Tokens the model read. */
    readonly inputTokens?: number;
    /** Tokens the model wrote. */
    readonly outputTokens?: number;
  };
}

/** Counts the verdicts in `entries`. */
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

/** `met / (met + notMet)`, omitted when that denominator is 0. */
export function derivedConfidence(
  summary: EvaluationSummary,
): number | undefined {
  const denominator = summary.met + summary.notMet;
  return denominator === 0 ? undefined : summary.met / denominator;
}

/** What {@link decideIteration} answers. */
export interface IterationDecisionResult {
  /** Accepted or rejected. */
  readonly decision: IterationDecision;
  /** Why. */
  readonly reason: DecisionReason;
  /** The verdict counts the decision was made from. */
  readonly summary: EvaluationSummary;
  /** True when any entry is `not-evaluated`. */
  readonly partial: boolean;
  /** `{ derived }` when it can be computed; omitted otherwise. */
  readonly confidence?: Confidence;
}

/**
 * Accepted when, and only when, no requirement is `not-met` and at least one is `met`. Anything else
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

/** Every violation of the contract rules a type cannot express; an empty list means valid and hashable. Never throws. */
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
            problems.push(`duplicate requirementId ${item['requirementId']}`);
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
        `${where}.evaluator must be omitted for a not-evaluated entry`,
      );
    if (item['evidence'] !== undefined && !isNonEmpty(item['evidence']))
      problems.push(`${where}.evidence must be a non-empty string, or omitted`);
    return problems;
  }
  if (!isNonEmpty(item['evidence']))
    problems.push(
      `${where}.evidence is required for a ${String(verdict)} verdict`,
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
        `${where}.evaluator.selfEvaluated is true only when kind is model`,
      );
  }
  return problems;
}

/** Every violation of the iteration rules, including that the summary, partial flag, confidence and decision agree with the entries. Never throws. */
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
          `duplicate requirementId ${entry.requirementId} in evaluation`,
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
      problems.push(`decision must be ${expected.decision} for these entries`);
    if (value['reason'] !== expected.reason)
      problems.push(`reason must be ${expected.reason} for these entries`);
    const confidence = value['confidence'];
    if (
      JSON.stringify(confidence ?? null) !==
      JSON.stringify(expected.confidence ?? null)
    ) {
      problems.push(
        'confidence must be the derived ratio and nothing else, omitted when nothing was decided',
      );
    }
    return problems;
  });
}

/** The facts {@link completeRun} turns into an overall result. */
export interface CompleteRunInput {
  /** The content id of the run's contract. */
  readonly contractRef: ContentId;
  /** Whether the contract was complete (had requirements, none duplicated). */
  readonly contractComplete: boolean;
  /** The `requirementId`s that appeared more than once in the step's requirements. */
  readonly duplicates: readonly string[];
  /** The most iterations the run was allowed. */
  readonly iterationCeiling: number;
  /** Whether the run was escalated. */
  readonly escalated: boolean;
  /** Who it was escalated to. */
  readonly escalatedTo?: string;
  /** The last iteration, with its stored content id; absent when no iteration ran. */
  readonly iteration?: IterationRecord;
  /** The content id under which `iteration` was stored. */
  readonly iterationRef?: ContentId;
  /** An error class from dispatch itself (`dispatch-failed`, `tool-budget-exceeded`, ...). */
  readonly failureClass?: string;
}

/** What {@link completeRun} answers: the two halves of the run's completion observation. */
export interface CompletedRun {
  /** The observation's `result`. */
  readonly result: ResultRecord;
  /** The observation's `detail`. */
  readonly detail: InferenceRunDetail;
}

/**
 * the overall result. An incomplete contract (or a duplicate requirement) can never be accepted, so
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
