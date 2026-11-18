import { describe, expect, it } from 'vitest';

import { extractContract, extractFromLines } from './contract-extraction';
import { requirementId } from './requirement';

describe('extractContract', () => {
  it('reads the bullets under a Requirements heading, with a stable id each', () => {
    const contract = extractContract(
      '# `s` — does a thing\n\n## Requirements\n\n- The output is JSON.\n- Every key is kebab-case.\n\n## Other\n\n- not a requirement\n',
    );
    expect(contract.requirements.map((r) => r.text)).toEqual([
      'The output is JSON.',
      'Every key is kebab-case.',
    ]);
    expect(contract.requirements[0]?.requirementId).toBe(
      requirementId('The output is JSON.'),
    );
    expect(contract.duplicates).toEqual([]);
    expect(contract.contractComplete).toBe(true);
  });

  it('joins a wrapped bullet and reads numbered items', () => {
    const contract = extractContract(
      '## Requirements\n\n1. First line\n   continues here.\n2) Second\n',
    );
    expect(contract.requirements.map((r) => r.text)).toEqual([
      'First line\ncontinues here.',
      'Second',
    ]);
  });

  it('reads each paragraph when the section has no bullets', () => {
    const contract = extractContract(
      '## Constraints\n\nOne claim.\n\nAnother claim.\n',
    );
    expect(contract.requirements.map((r) => r.text)).toEqual([
      'One claim.',
      'Another claim.',
    ]);
  });

  it('reads the house callouts (red circle, warning) as requirements, one paragraph each', () => {
    const contract = extractContract(
      'Intro.\n\n🔴 **Never edit files.** Reason follows\non a second line.\n\n⚠️ **Be brief.**\n\ntext\n',
    );
    expect(contract.requirements.map((r) => r.text)).toEqual([
      '🔴 **Never edit files.** Reason follows\non a second line.',
      '⚠️ **Be brief.**',
    ]);
  });

  it('does not count a callout inside a Requirements bullet twice', () => {
    const contract = extractContract(
      '## Requirements\n\n- 🔴 **Never edit files.**\n',
    );
    expect(contract.requirements).toHaveLength(1);
  });

  it('does not count a callout paragraph inside a Requirements section twice', () => {
    const contract = extractContract('## Requirements\n\n🔴 **Only one.**\n');
    expect(contract.requirements).toHaveLength(1);
    expect(contract.duplicates).toEqual([]); // counted twice, it would be reported as its own duplicate
    expect(contract.contractComplete).toBe(true);
  });

  it('ignores fenced code, which is an example and not a claim', () => {
    const contract = extractContract(
      '## Requirements\n\n- Real one.\n\n```\n## Requirements\n- fenced\n🔴 **fenced callout**\n```\n',
    );
    expect(contract.requirements.map((r) => r.text)).toEqual(['Real one.']);
  });

  it('a section ends at the next heading of the same or a higher level, not a deeper one', () => {
    const contract = extractContract(
      '## Requirements\n\n- A\n\n### Detail\n\n- B\n\n## Next\n\n- C\n',
    );
    expect(contract.requirements.map((r) => r.text)).toEqual(['A', 'B']);
  });

  it('reports a duplicate requirement once and keeps the first, and the contract is incomplete', () => {
    const contract = extractContract(
      '## Requirements\n\n- Must be JSON.\n-   Must   be JSON.\n- Another.\n',
    );
    expect(contract.requirements.map((r) => r.text)).toEqual([
      'Must be JSON.',
      'Another.',
    ]);
    expect(contract.duplicates).toEqual([requirementId('Must be JSON.')]);
    expect(contract.contractComplete).toBe(false);
  });

  it('a step with no requirements has requirements [] and contractComplete false', () => {
    const contract = extractContract(
      '# `s` — does a thing\n\nJust some prose.\n',
    );
    expect(contract.requirements).toEqual([]);
    expect(contract.contractComplete).toBe(false);
  });

  it('reads a goal from a Goal heading, a Goal: line or the step title, in that order', () => {
    expect(extractContract('## Goal\n\nShip it.\nMore.\n\nx').goal).toBe(
      'Ship it.\nMore.',
    );
    expect(extractContract('Goal: Ship it\n').goal).toBe('Ship it');
    expect(extractContract('# `s` — Ship it\n').goal).toBe('Ship it');
    expect(
      extractContract('# `s` — Title goal\n\n## Goal\n\nHeading goal.\n').goal,
    ).toBe('Heading goal.');
    expect(extractContract('nothing here\n').goal).toBeUndefined();
  });

  it('takes the role from the caller (the step performer) and never invents one', () => {
    expect(extractContract('x', { role: 'developer' }).role).toBe('developer');
    expect(extractContract('x').role).toBeUndefined();
  });

  it('reads declared assumptions under an Assumptions heading', () => {
    expect(
      extractContract('## Assumptions\n\n- The repo is clean.\n').assumptions,
    ).toEqual([{ text: 'The repo is clean.', origin: 'declared' }]);
  });

  it('is bounded: a pathological line does not hang, and a huge item is cut', () => {
    const started = Date.now();
    const contract = extractContract(
      `## Requirements\n\n- ${'a '.repeat(50_000)}\n${'-'.repeat(100_000)}\n`,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(contract.requirements.length).toBeLessThanOrEqual(1);
    expect(contract.requirements.every((r) => r.text.length <= 4000)).toBe(
      true,
    );
  });

  it('caps the number of requirements', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `- claim ${i}`).join(
      '\n',
    );
    expect(
      extractContract(`## Requirements\n\n${lines}\n`).requirements,
    ).toHaveLength(200);
  });

  it('repairs ill-formed text (a lone surrogate) instead of dropping the requirement or throwing a hash error later', () => {
    const contract = extractContract(
      '## Requirements\n\n- ok \ud800 broken\n- fine\n',
    );
    expect(contract.requirements.map((r) => r.text)).toEqual([
      'ok \ufffd broken',
      'fine',
    ]);
  });

  it('is not quadratic in the number of duplicated requirements (100k lines in well under a second)', () => {
    const text =
      '## Rules\n' +
      Array.from({ length: 100_000 }, (_, i) => `- ${i >> 1}`).join('\n');
    const started = Date.now();
    // Past the parse cap `extractContract` reports the document unparseable, so the duplicate scan is driven directly.
    const contract = extractFromLines(text.split('\n'));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(contract.requirements).toHaveLength(200);
    expect(contract.duplicates).toHaveLength(50_000);
  });

  it('ignores a ~~~ fenced block, and a shorter or different fence inside a longer one is content', () => {
    expect(
      extractContract('~~~\n## Rules\n- fake\n~~~\n').requirements,
    ).toEqual([]);
    expect(
      extractContract('````\n```\n````\n## Rules\n- real\n').requirements.map(
        (r) => r.text,
      ),
    ).toEqual(['real']);
    expect(
      extractContract('```\n~~~\n## Rules\n- fake\n```\n').requirements,
    ).toEqual([]);
    expect(
      extractContract(
        '~~~~\n~~~\n## Rules\n- fake\n~~~~\n## Rules\n- real\n',
      ).requirements.map((r) => r.text),
    ).toEqual(['real']);
  });

  it('a heading longer than 300 characters is still a heading, so it ends the section before it', () => {
    const contract = extractContract(
      '## Requirements ' + 'x'.repeat(400) + '\n- a\n\n## Other\n- zzz\n',
    );
    expect(contract.requirements.map((r) => r.text)).toEqual(['a']);
    const ended = extractContract(
      '## Requirements\n- a\n\n## Other ' + 'y'.repeat(400) + '\n- zzz\n',
    );
    expect(ended.requirements.map((r) => r.text)).toEqual(['a']);
  });

  it('pairs an indented fence opener with its indented closer, so a fence inside a list item does not blank the rest', () => {
    const list = extractContract(
      '## Rules\n\n- a\n\n    ```\n    code\n    ```\n\n- b\n- c\n',
    );
    expect(list.requirements.map((r) => r.text)).toEqual(['a', 'b', 'c']);
    const top = extractContract(
      '## Rules\n\n    ```\n    x\n    ```\n\n- b\n- c\n',
    );
    expect(top.requirements.map((r) => r.text)).toEqual(['b', 'c']);
  });

  it('survives a section with a very large number of items without overflowing the stack', () => {
    // Past the parse cap `extractContract` reports the document unparseable, so the post-parse scan is driven directly.
    const result = extractFromLines(
      ('## Rules\n' + '- a\n'.repeat(250_000)).split('\n'),
    );
    expect(result.requirements.length).toBeGreaterThan(0);
  });

  it('does not let a 4-space-indented backtick line close a top-level fence (it is content there)', () => {
    const r = extractContract(
      '## Rules\n\n```\n- code1\n    ```\n- after\n```\n\n- real\n',
    );
    expect(r.requirements.map((x) => x.text)).toEqual(['real']);
  });

  it('does not let a closer indented 4+ close a fence opened at indent 1-3 (absolute CommonMark rule)', () => {
    expect(
      extractContract('## Rules\n\n  ```\n- item0\n    ```\n- item1\n')
        .requirements,
    ).toEqual([]);
  });
});
