import { describe, expect, it } from 'vitest';

import { evaluateRequirements, type RequirementEvaluator } from './evaluation';
import { requirementId } from './requirement';

const reqs = ['Must be JSON', 'Has a title'].map((text) => ({
  requirementId: requirementId(text),
  text,
}));
const subject = { outputText: '{"title":"x"}' };

describe('evaluateRequirements: the scaffolding, with no evaluator registered by default', () => {
  it('with no evaluators every requirement is not-evaluated, with no evidence and no evaluator, never omitted and never met', () => {
    const entries = evaluateRequirements(reqs, subject, []);
    expect(entries).toEqual(
      reqs.map((r) => ({
        requirementId: r.requirementId,
        verdict: 'not-evaluated',
      })),
    );
  });

  it('takes the first evaluator that can decide a requirement, and asks the later ones only for the rest', () => {
    const asked: string[] = [];
    const json: RequirementEvaluator = {
      evaluate: (requirement) => {
        asked.push(`json:${requirement.text}`);
        return requirement.text === 'Must be JSON'
          ? {
              requirementId: requirement.requirementId,
              verdict: 'met',
              evidence: 'JSON.parse succeeded',
              evaluator: {
                kind: 'deterministic',
                identity: 'json-parse',
                selfEvaluated: false,
              },
            }
          : undefined;
      },
    };
    const never: RequirementEvaluator = {
      evaluate: (requirement) => {
        asked.push(`second:${requirement.text}`);
        return undefined;
      },
    };
    const entries = evaluateRequirements(reqs, subject, [json, never]);
    expect(entries.map((e) => e.verdict)).toEqual(['met', 'not-evaluated']);
    expect(asked).toEqual([
      'json:Must be JSON',
      'json:Has a title',
      'second:Has a title',
    ]);
  });

  it('an evaluator that throws leaves the requirement not-evaluated: a broken check is a coverage gap, not a verdict', () => {
    const boom: RequirementEvaluator = {
      evaluate: () => {
        throw new Error('boom');
      },
    };
    expect(
      evaluateRequirements(reqs, subject, [boom]).map((e) => e.verdict),
    ).toEqual(['not-evaluated', 'not-evaluated']);
  });

  it('refuses an entry about another requirement, or a met with no evidence, instead of recording it', () => {
    const wrongId: RequirementEvaluator = {
      evaluate: () => ({
        requirementId: requirementId('something else'),
        verdict: 'met',
        evidence: 'x',
        evaluator: {
          kind: 'deterministic',
          identity: 'x',
          selfEvaluated: false,
        },
      }),
    };
    const noEvidence: RequirementEvaluator = {
      evaluate: (r) => ({
        requirementId: r.requirementId,
        verdict: 'met',
        evaluator: {
          kind: 'deterministic',
          identity: 'x',
          selfEvaluated: false,
        },
      }),
    };
    expect(
      evaluateRequirements(reqs, subject, [wrongId]).map((e) => e.verdict),
    ).toEqual(['not-evaluated', 'not-evaluated']);
    expect(
      evaluateRequirements(reqs, subject, [noEvidence]).map((e) => e.verdict),
    ).toEqual(['not-evaluated', 'not-evaluated']);
  });

  it('returns no entries for no requirements', () => {
    expect(evaluateRequirements([], subject, [])).toEqual([]);
  });
});
