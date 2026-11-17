import { describe, expect, it } from 'vitest';

import { contentIdOfText } from './content-id';
import {
  completeRun,
  decideIteration,
  derivedConfidence,
  summarizeEvaluation,
  validateContract,
  validateIteration,
  type ContractRecord,
  type EvaluationEntry,
  type IterationRecord,
  type Verdict,
} from './inference';
import { requirementId } from './requirement';

const id = (text: string) => requirementId(text);
const entry = (
  text: string,
  verdict: Verdict,
  extra: Partial<EvaluationEntry> = {},
): EvaluationEntry => ({
  requirementId: id(text),
  verdict,
  ...(verdict === 'not-evaluated'
    ? {}
    : {
        evidence: 'schema check: valid',
        evaluator: {
          kind: 'deterministic',
          identity: 'json-schema',
          selfEvaluated: false,
        },
      }),
  ...extra,
});

describe('the decision rule (ADR-073 D5a), over the whole verdict matrix', () => {
  // [verdicts, decision, reason, partial]
  const matrix: ReadonlyArray<
    [readonly Verdict[], 'accepted' | 'rejected', string, boolean]
  > = [
    [['met'], 'accepted', 'no-unmet-requirement', false],
    [['met', 'met'], 'accepted', 'no-unmet-requirement', false],
    [['met', 'not-evaluated'], 'accepted', 'no-unmet-requirement', true],
    [['not-met'], 'rejected', 'requirement-not-met', false],
    [['met', 'not-met'], 'rejected', 'requirement-not-met', false],
    [['not-met', 'not-evaluated'], 'rejected', 'requirement-not-met', true],
    [
      ['met', 'not-met', 'not-evaluated'],
      'rejected',
      'requirement-not-met',
      true,
    ],
    [['not-evaluated'], 'rejected', 'unevaluable', true],
    [['not-evaluated', 'not-evaluated'], 'rejected', 'unevaluable', true],
    [[], 'rejected', 'no-requirements', false],
  ];
  it.each(matrix)(
    '%j is %s (%s, partial %s)',
    (verdicts, decision, reason, partial) => {
      const entries = verdicts.map((verdict, index) =>
        entry(`requirement ${index}`, verdict),
      );
      const result = decideIteration(entries);
      expect(result.decision).toBe(decision);
      expect(result.reason).toBe(reason);
      expect(result.partial).toBe(partial);
    },
  );

  it('counts the three verdicts', () => {
    expect(
      summarizeEvaluation([
        entry('a', 'met'),
        entry('b', 'met'),
        entry('c', 'not-met'),
        entry('d', 'not-evaluated'),
      ]),
    ).toEqual({ met: 2, notMet: 1, notEvaluated: 1 });
  });
});

describe('derived confidence (ADR-073 D6)', () => {
  it('is met / (met + not-met)', () => {
    expect(derivedConfidence({ met: 3, notMet: 1, notEvaluated: 9 })).toBe(
      0.75,
    );
  });
  it('is omitted when nothing was decided, never 0', () => {
    expect(
      derivedConfidence({ met: 0, notMet: 0, notEvaluated: 4 }),
    ).toBeUndefined();
    expect(
      decideIteration([entry('a', 'not-evaluated')]).confidence,
    ).toBeUndefined();
  });
  it('is always 1 for an accepted iteration', () => {
    expect(
      decideIteration([entry('a', 'met'), entry('b', 'not-evaluated')])
        .confidence,
    ).toEqual({ derived: 1 });
  });
});

const contract: ContractRecord = {
  schemaVersion: 1,
  role: 'developer',
  goal: 'Do the thing',
  requirements: [{ requirementId: id('Must be JSON'), text: 'Must be JSON' }],
  input: contentIdOfText('input'),
  assumptions: [],
  instructionRef: contentIdOfText('input'),
};
const contractRef = contentIdOfText('contract');
const iteration = (
  overrides: Partial<IterationRecord> = {},
): IterationRecord => ({
  schemaVersion: 1,
  kind: 'inference-run',
  contractRef,
  runId: '11111111-1111-4111-8111-111111111111',
  iteration: 1,
  outputRef: contentIdOfText('output'),
  evaluation: [entry('Must be JSON', 'not-evaluated')],
  timestamp: '2026-10-10T00:00:00.000Z',
  evaluationSummary: { met: 0, notMet: 0, notEvaluated: 1 },
  partial: true,
  decision: 'rejected',
  reason: 'unevaluable',
  ...overrides,
});

describe('validateContract', () => {
  it('accepts a well-formed contract', () => {
    expect(validateContract(contract)).toEqual([]);
  });
  it('refuses two requirements that share a requirementId (D2)', () => {
    const dup = {
      ...contract,
      requirements: [contract.requirements[0], contract.requirements[0]],
    };
    expect(validateContract(dup).join()).toMatch(/duplicate requirementId/);
  });
  it('refuses a requirementId that is not the digest of its text', () => {
    const bad = {
      ...contract,
      requirements: [
        { requirementId: id('something else'), text: 'Must be JSON' },
      ],
    };
    expect(validateContract(bad).join()).toMatch(/does not match/);
  });
  it('refuses unknown fields and a missing role', () => {
    expect(validateContract({ ...contract, extra: 1 }).join()).toMatch(
      /unknown field extra/,
    );
    expect(validateContract({ ...contract, role: '' }).join()).toMatch(/role/);
  });
  it('refuses an assumption with an unknown origin', () => {
    expect(
      validateContract({
        ...contract,
        assumptions: [{ text: 'x', origin: 'guessed' }],
      }).join(),
    ).toMatch(/origin/);
  });
  it('never throws on junk', () => {
    expect(validateContract(null)).not.toEqual([]);
    expect(validateContract('x')).not.toEqual([]);
  });
});

describe('validateIteration', () => {
  it('accepts the unevaluable shape', () => {
    expect(validateIteration(iteration())).toEqual([]);
  });
  it('requires evidence for met and not-met (D4)', () => {
    const noEvidence = {
      requirementId: id('Must be JSON'),
      verdict: 'met',
      evaluator: { kind: 'deterministic', identity: 'x', selfEvaluated: false },
    };
    expect(
      validateIteration(
        iteration({
          evaluation: [noEvidence as EvaluationEntry],
          evaluationSummary: { met: 1, notMet: 0, notEvaluated: 0 },
          partial: false,
          decision: 'accepted',
          reason: 'no-unmet-requirement',
        }),
      ).join(),
    ).toMatch(/evidence/);
  });
  it('omits the evaluator for a not-evaluated entry and demands one otherwise', () => {
    const withEvaluator: EvaluationEntry = {
      ...entry('Must be JSON', 'not-evaluated'),
      evaluator: { kind: 'human', identity: 'dave', selfEvaluated: false },
    };
    expect(
      validateIteration(iteration({ evaluation: [withEvaluator] })).join(),
    ).toMatch(/evaluator/);
    const missing = {
      requirementId: id('Must be JSON'),
      verdict: 'met',
      evidence: 'x',
    };
    expect(
      validateIteration(
        iteration({
          evaluation: [missing as EvaluationEntry],
          evaluationSummary: { met: 1, notMet: 0, notEvaluated: 0 },
          partial: false,
          decision: 'accepted',
          reason: 'no-unmet-requirement',
        }),
      ).join(),
    ).toMatch(/evaluator/);
  });
  it('allows selfEvaluated only for a model evaluator', () => {
    const bad = entry('Must be JSON', 'met', {
      evaluator: { kind: 'deterministic', identity: 'x', selfEvaluated: true },
    });
    expect(
      validateIteration(
        iteration({
          evaluation: [bad],
          evaluationSummary: { met: 1, notMet: 0, notEvaluated: 0 },
          partial: false,
          decision: 'accepted',
          reason: 'no-unmet-requirement',
        }),
      ).join(),
    ).toMatch(/selfEvaluated/);
  });
  it('refuses two entries for one requirementId', () => {
    const two = [
      entry('Must be JSON', 'not-evaluated'),
      entry('Must be JSON', 'not-evaluated'),
    ];
    expect(
      validateIteration(
        iteration({
          evaluation: two,
          evaluationSummary: { met: 0, notMet: 0, notEvaluated: 2 },
        }),
      ).join(),
    ).toMatch(/duplicate requirementId/);
  });
  it('refuses a summary, partial flag, decision or confidence that disagrees with the entries', () => {
    expect(
      validateIteration(
        iteration({
          evaluationSummary: { met: 1, notMet: 0, notEvaluated: 0 },
        }),
      ).join(),
    ).toMatch(/evaluationSummary/);
    expect(validateIteration(iteration({ partial: false })).join()).toMatch(
      /partial/,
    );
    expect(
      validateIteration(iteration({ decision: 'accepted' })).join(),
    ).toMatch(/decision/);
    expect(
      validateIteration(iteration({ reason: 'requirement-not-met' })).join(),
    ).toMatch(/reason/);
    expect(
      validateIteration(iteration({ confidence: { derived: 0.5 } })).join(),
    ).toMatch(/confidence/);
  });
  it('refuses an iteration number that is not a whole number >= 1 and a runId that is not a UUID', () => {
    expect(validateIteration(iteration({ iteration: 0 })).join()).toMatch(
      /iteration/,
    );
    expect(
      validateIteration(iteration({ runId: 'not-a-uuid' })).join(),
    ).toMatch(/runId/);
  });
  it('never throws on junk', () => {
    expect(validateIteration(undefined)).not.toEqual([]);
  });
});

describe('completeRun maps the run onto ADR-072 D6 (ADR-073 D7a, D8)', () => {
  const base = {
    contractRef,
    contractComplete: true,
    duplicates: [] as string[],
    iterationCeiling: 1,
    escalated: false,
  };

  it('an accepted iteration is a success with the last iteration confidence', () => {
    const accepted = iteration({
      evaluation: [entry('Must be JSON', 'met')],
      evaluationSummary: { met: 1, notMet: 0, notEvaluated: 0 },
      partial: false,
      decision: 'accepted',
      reason: 'no-unmet-requirement',
      confidence: { derived: 1 },
    });
    const done = completeRun({
      ...base,
      iteration: accepted,
      iterationRef: contentIdOfText('it1'),
    });
    expect(done.result).toEqual({
      outcome: 'success',
      evidence: [],
      iterations: 1,
      escalated: false,
      confidence: { derived: 1 },
    });
    expect(done.detail).toEqual({
      contractRef,
      iterationRefs: [contentIdOfText('it1')],
      iterationCeiling: 1,
      finalDecision: 'accepted',
      contractComplete: true,
      partial: false,
    });
  });

  it('an all-not-evaluated iteration is a failure with the class unevaluable, and no confidence', () => {
    const done = completeRun({
      ...base,
      iteration: iteration(),
      iterationRef: contentIdOfText('it1'),
    });
    expect(done.result).toEqual({
      outcome: 'failure',
      evidence: ['unevaluable'],
      iterations: 1,
      escalated: false,
    });
    expect(done.detail).toMatchObject({
      finalDecision: 'rejected',
      partial: true,
    });
  });

  it('a not-met requirement is named in the evidence', () => {
    const notMet = iteration({
      evaluation: [entry('Must be JSON', 'not-met')],
      evaluationSummary: { met: 0, notMet: 1, notEvaluated: 0 },
      partial: false,
      reason: 'requirement-not-met',
      confidence: { derived: 0 },
    });
    const done = completeRun({
      ...base,
      iteration: notMet,
      iterationRef: contentIdOfText('it1'),
    });
    expect(done.result.outcome).toBe('failure');
    expect(done.result.evidence).toEqual([`not-met:${id('Must be JSON')}`]);
    expect(done.result.confidence).toEqual({ derived: 0 });
  });

  it('an incomplete contract can never be accepted: failure with contract-incomplete, even if the iteration was accepted', () => {
    const accepted = iteration({
      evaluation: [entry('Must be JSON', 'met')],
      evaluationSummary: { met: 1, notMet: 0, notEvaluated: 0 },
      partial: false,
      decision: 'accepted',
      reason: 'no-unmet-requirement',
      confidence: { derived: 1 },
    });
    const done = completeRun({
      ...base,
      contractComplete: false,
      iteration: accepted,
      iterationRef: contentIdOfText('it1'),
    });
    expect(done.result.outcome).toBe('failure');
    expect(done.result.evidence[0]).toBe('contract-incomplete');
    expect(done.detail).toMatchObject({
      finalDecision: 'rejected',
      contractComplete: false,
    });
  });

  it('a duplicate requirement is its own class and wins over contract-incomplete', () => {
    const done = completeRun({
      ...base,
      contractComplete: false,
      duplicates: [id('a')],
      iteration: iteration(),
      iterationRef: contentIdOfText('it1'),
    });
    expect(done.result.evidence[0]).toBe('duplicate-requirement');
  });

  it('no iteration: iterations and partial are omitted, not written as 0 or false (D8)', () => {
    const done = completeRun({
      ...base,
      contractComplete: false,
      failureClass: 'dispatch-failed',
    });
    expect(done.result.iterations).toBeUndefined();
    expect('iterations' in done.result).toBe(false);
    expect('partial' in done.detail).toBe(false);
    expect(done.detail.iterationRefs).toEqual([]);
    expect(done.result.evidence).toEqual([
      'contract-incomplete',
      'dispatch-failed',
    ]);
    expect(done.result.escalated).toBe(false);
  });

  it('a dispatch failure on a complete contract is a failure carrying its class', () => {
    const done = completeRun({
      ...base,
      failureClass: 'tool-budget-exceeded',
      escalated: true,
    });
    expect(done.result).toEqual({
      outcome: 'failure',
      evidence: ['tool-budget-exceeded'],
      escalated: true,
    });
    expect(done.detail).toMatchObject({
      finalDecision: 'rejected',
      contractComplete: true,
    });
  });

  it('records escalatedTo only when known', () => {
    const done = completeRun({
      ...base,
      failureClass: 'x',
      escalated: true,
      escalatedTo: 'founder',
    });
    expect(done.detail.escalatedTo).toBe('founder');
    expect(
      'escalatedTo' in completeRun({ ...base, failureClass: 'x' }).detail,
    ).toBe(false);
  });
});
