import { describe, expect, it, vi } from 'vitest';

vi.mock('mdast-util-from-markdown', () => ({
  fromMarkdown: () => {
    throw new RangeError('Maximum call stack size exceeded');
  },
}));

import { blankCodeBlocks, extractContract } from './contract-extraction';

describe('a parser that throws', () => {
  it('is reported as an incomplete contract with the reason, never thrown', () => {
    const result = extractContract('## Rules\n- a\n', { role: 'developer' });
    expect(result.requirements).toEqual([]);
    expect(result.contractComplete).toBe(false);
    expect(result.incompleteReason).toBe(
      'document could not be parsed (RangeError)',
    );
    expect(result.role).toBe('developer');
  });

  it('hands the reason to the caller of blankCodeBlocks and returns undefined', () => {
    const reasons: string[] = [];
    expect(blankCodeBlocks('x', (why) => reasons.push(why))).toBeUndefined();
    expect(reasons).toEqual(['document could not be parsed (RangeError)']);
  });
});
