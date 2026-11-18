/**
 * Requirement evaluation scaffolding. Pure.
 *
 * 🔴 **No deterministic evaluator exists yet**, so the
 * registry that seams use by default is empty and every requirement comes out `not-evaluated`. That is the honest
 * answer, and an iteration with nothing but `not-evaluated` is `unevaluable`. Nothing here ever guesses a `met`.
 */
import type { EvaluationEntry, RequirementRecord } from './inference';
import { validateIteration } from './inference';

export interface EvaluationSubject {
  readonly outputText: string;
}

export interface RequirementEvaluator {
  /** A verdict for this requirement, or `undefined` when this evaluator cannot decide it. */
  evaluate(
    requirement: RequirementRecord,
    subject: EvaluationSubject,
  ): EvaluationEntry | undefined;
}

/** A well-formed entry for exactly this requirement, or `undefined`. Uses the iteration validator's own entry rules. */
function acceptable(
  requirement: RequirementRecord,
  entry: EvaluationEntry | undefined,
): EvaluationEntry | undefined {
  if (entry === undefined || entry.requirementId !== requirement.requirementId)
    return undefined;
  if (entry.verdict === 'not-evaluated') return undefined;
  // Reuse the one definition of a valid entry: wrap it in a minimal iteration and look only at the entry's own problems.
  const problems = validateIteration({
    schemaVersion: 1,
    kind: 'inference-run',
    contractRef: '1-' + '0'.repeat(32),
    runId: '00000000-0000-4000-8000-000000000000',
    iteration: 1,
    evaluation: [entry],
    timestamp: '2026-01-01T00:00:00.000Z',
    evaluationSummary: {
      met: entry.verdict === 'met' ? 1 : 0,
      notMet: entry.verdict === 'not-met' ? 1 : 0,
      notEvaluated: 0,
    },
    partial: false,
    decision: entry.verdict === 'met' ? 'accepted' : 'rejected',
    reason:
      entry.verdict === 'met' ? 'no-unmet-requirement' : 'requirement-not-met',
    ...(entry.verdict === 'met'
      ? { confidence: { derived: 1 } }
      : { confidence: { derived: 0 } }),
  });
  return problems.length === 0 ? entry : undefined;
}

/**
 * One entry per requirement, in order. The first evaluator to return a valid entry decides it; an evaluator that
 * throws, answers about another requirement, or answers `met`/`not-met` without evidence or evaluator decides nothing.
 */
export function evaluateRequirements(
  requirements: readonly RequirementRecord[],
  subject: EvaluationSubject,
  evaluators: readonly RequirementEvaluator[],
): readonly EvaluationEntry[] {
  return requirements.map((requirement): EvaluationEntry => {
    for (const evaluator of evaluators) {
      try {
        const decided = acceptable(
          requirement,
          evaluator.evaluate(requirement, subject),
        );
        if (decided) return decided;
      } catch {
        // A broken check is a coverage gap, not a verdict.
      }
    }
    return {
      requirementId: requirement.requirementId,
      verdict: 'not-evaluated',
    };
  });
}
