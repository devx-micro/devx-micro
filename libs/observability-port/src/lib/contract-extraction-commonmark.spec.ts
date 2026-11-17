import { fromMarkdown } from 'mdast-util-from-markdown';
import { describe, expect, it } from 'vitest';

import {
  blankCodeBlocks,
  extractContract,
  MAX_PARSE_CHARS,
} from './contract-extraction';

/**
 * Code blocks are whatever a CommonMark parser says they are (ADR-073 D2, Phase 04 QA). Four hand-written patches to a
 * fence scanner each diverged from CommonMark in a new way, so the scanner was retired for `mdast-util-from-markdown`;
 * this spec holds the extractor to that parser, fenced AND indented code alike.
 */
const texts = (doc: string): string[] =>
  extractContract(doc).requirements.map((r) => r.text);

describe('code blocks are read by a CommonMark parser', () => {
  it('QA regressions: a fence inside an indented/nested context is read exactly as CommonMark reads it', () => {
    expect(
      texts('## Rules\n\n    ~~~\n  - item0\n    ~~~\n  - item1\n'),
    ).toEqual(['item0']);
    expect(texts('## Rules\n\n  ```\n- item0\n    ```\n- item1\n')).toEqual([]);
    expect(texts('````\n```\n````\n## Rules\n- real\n')).toEqual(['real']);
    expect(texts('~~~\n## Rules\n- fake\n~~~\n')).toEqual([]);
  });

  it('keeps the list-item fence, the 4-backtick fence and the top-level 4-space cases', () => {
    expect(
      texts('## Rules\n\n- a\n\n    ```\n    code\n    ```\n\n- b\n- c'),
    ).toEqual(['a', 'b', 'c']);
    expect(
      texts('## Rules\n\n```\n- code1\n    ```\n- after\n```\n\n- real\n'),
    ).toEqual(['real']);
  });

  it('treats indented code (4 spaces, no fence) as non-content, which the fence scanner never could', () => {
    expect(
      texts(
        '## Rules\n\nPara.\n\n    - indented code, not a bullet\n\n- real\n',
      ),
    ).toEqual(['real']);
    expect(
      texts('## Rules\n\nPara.\n\n\t- tab-indented code\n\n- real\n'),
    ).toEqual(['real']);
    // ...but four spaces continuing a paragraph is not code (a lazy continuation).
    expect(texts('## Rules\n\n- first\n    wrapped\n- second\n')).toEqual([
      'first\nwrapped',
      'second',
    ]);
  });

  it('keeps line positions: blanked code leaves the same number of lines', () => {
    const doc = '# t\n\n```\ncode\n```\n\n    indented\n\n## Rules\n- x\n';
    const lines = blankCodeBlocks(doc);
    expect(lines).toBeDefined();
    expect(lines).toHaveLength(doc.split('\n').length);
    expect(lines?.[3]).toBe('');
    expect(lines?.[6]).toBe('');
    expect(lines?.[9]).toBe('- x');
  });

  it('reports an unparseable document as incomplete with a reason instead of throwing', () => {
    const big = extractContract('## Rules\n' + '- a\n'.repeat(MAX_PARSE_CHARS));
    expect(big.contractComplete).toBe(false);
    expect(big.requirements).toEqual([]);
    expect(big.incompleteReason).toMatch(/too large/);
    const deep = extractContract('## Rules\n' + '> '.repeat(500) + 'x\n');
    expect(deep.contractComplete).toBe(false);
    expect(deep.incompleteReason).toMatch(/nested/);
    expect(extractContract('## Rules\n- a\n').incompleteReason).toBeUndefined();
  });
});

describe('limits and thematic breaks', () => {
  const doc = (length: number): string => {
    const head = '## Rules\n- a\n';
    return head + '\n'.repeat(length - head.length);
  };

  it('parses a document of exactly 8192 characters and refuses one character more, saying why', () => {
    const cap = 8_192; // literal on purpose: the cap itself is what is under test
    expect(MAX_PARSE_CHARS).toBe(cap);
    const at = extractContract(doc(cap));
    expect(at.incompleteReason).toBeUndefined();
    expect(at.requirements.map((r) => r.text)).toEqual(['a']);
    const over = extractContract(doc(cap + 1));
    expect(over.contractComplete).toBe(false);
    expect(over.requirements).toEqual([]);
    expect(over.incompleteReason).toBe(
      `document too large to parse (more than 8192 characters)`,
    );
  });

  it('a thematic break is not a stack of containers: "* * * *" does not make a document "nested too deeply"', () => {
    for (const rule of [
      '* '.repeat(40),
      '- '.repeat(40),
      '_ '.repeat(40),
      '  ' + '* '.repeat(40),
      '*\t'.repeat(40),
    ]) {
      const result = extractContract(
        '## Requirements\n- keep it\n\n' +
          rule +
          '\n\n## Other\n\n⚠️ **after the rule**\n',
      );
      expect(result.incompleteReason).toBeUndefined();
      expect(result.requirements.map((r) => r.text)).toEqual([
        'keep it',
        '⚠️ **after the rule**',
      ]);
    }
  });

  it('a real stack of list markers is still refused (4 spaces is not a rule, and "- - a" has text)', () => {
    expect(
      extractContract('## Rules\n' + '- '.repeat(40) + 'a\n').incompleteReason,
    ).toMatch(/nested/);
  });
});

describe('hostile inputs (1 MiB and at the parse cap) neither throw nor take long', () => {
  const MiB = 1 << 20;
  const cases: Record<string, string> = {
    hashes: '#'.repeat(MiB),
    backticks: '`'.repeat(MiB),
    tildes: '~'.repeat(MiB),
    spaces: ' '.repeat(MiB),
    '250k bullets': '- a\n'.repeat(250_000),
    '250k fences': '```\n'.repeat(250_000),
    '250k tilde fences': '~~~\n'.repeat(250_000),
    '1 MiB of >': '>'.repeat(MiB),
    'a line of "> " repeated': '> '.repeat(MiB / 2),
    '2000 nested block quotes on one line': '> '.repeat(2000) + 'x',
    '1500 levels of list nesting by indentation': Array.from(
      { length: 1500 },
      (_, i) => ' '.repeat(i * 2) + '- a',
    ).join('\n'),
    'a line of "- " repeated': '- '.repeat(MiB / 2),
    'a line of "> - " repeated': '> - '.repeat(MiB / 4),
    brackets: '['.repeat(MiB),
    'at the cap: > on one line': '>'.repeat(MAX_PARSE_CHARS),
    'at the cap: "> - " on one line': '> - '.repeat(MAX_PARSE_CHARS / 4),
    'at the cap: bare dashes': '-\n'.repeat(MAX_PARSE_CHARS / 2),
    'at the cap: bullets': '- a\n'.repeat(MAX_PARSE_CHARS / 4),
    'at the cap: link openers': '[a]('.repeat(MAX_PARSE_CHARS / 4),
    'at the cap: emphasis, "*_" x100 per line': ('*_'.repeat(100) + '\n')
      .repeat(Math.ceil(MAX_PARSE_CHARS / 201))
      .slice(0, MAX_PARSE_CHARS),
    'at the cap: emphasis, "*_" per line': '*_\n'
      .repeat(Math.ceil(MAX_PARSE_CHARS / 3))
      .slice(0, MAX_PARSE_CHARS),
    'at the cap: emphasis, "_*" per line': '_*\n'
      .repeat(Math.ceil(MAX_PARSE_CHARS / 3))
      .slice(0, MAX_PARSE_CHARS),
    'at the cap: emphasis, one "*_" line': '*_'.repeat(MAX_PARSE_CHARS / 2),
    'at the cap: emphasis, "*_*_*_*_"': '*_*_*_*_'.repeat(MAX_PARSE_CHARS / 8),
    'at the cap: lazy continuation after a bullet':
      '- a\n' + 'b\n'.repeat(MAX_PARSE_CHARS / 2 - 2),
    'at the cap: lazy continuation after a quote':
      '> a\n' + 'b\n'.repeat(MAX_PARSE_CHARS / 2 - 2),
    'at the cap: lazy continuation after nested quote+bullets':
      '> - a\n> - b\n' + 'c\n'.repeat(MAX_PARSE_CHARS / 2 - 6),
    'at the cap: lazy continuation after an ordered item':
      '1. a\n' + 'b\n'.repeat(MAX_PARSE_CHARS / 2 - 3),
    'at the cap: runs of closing brackets': ']'.repeat(MAX_PARSE_CHARS),
    'at the cap: 250 deep quotes per line': ('>'.repeat(250) + '\n').repeat(
      MAX_PARSE_CHARS / 251,
    ),
  };
  for (const [name, doc] of Object.entries(cases)) {
    it(`${name}`, () => {
      const started = Date.now();
      const contract = extractContract(doc);
      expect(Date.now() - started).toBeLessThan(
        name.startsWith('at the cap: emphasis') ? 1000 : 3000,
      );
      expect(typeof contract.contractComplete).toBe('boolean');
      if (doc.length > MAX_PARSE_CHARS)
        expect(contract.incompleteReason).toBeDefined();
    });
  }
});

// A small deterministic generator (mulberry32), so a failure replays.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  '```',
  '````',
  '~~~',
  '~~~~',
  '``` js',
  '```x`y',
  '    ```',
  '  ```',
  ' ~~~',
  '\t```',
  '        ```',
  '## Rules',
  '## Requirements',
  '### Deeper',
  '# Top',
  '- item',
  '  - nested',
  '    - deeper',
  '* star',
  '1. one',
  '   2) two',
  '> quote',
  '> ```',
  '> - in quote',
  '- ```',
  '- a\n\n    ```\n    code\n    ```',
  '    indented',
  '\tindented',
  '        more indented',
  'plain text',
  '🔴 **claim**',
  '',
  '',
  '',
  '   ',
  '- ',
  '>',
  '    - listish',
];

function document(next: () => number): string {
  const count = 2 + Math.floor(next() * 14);
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1)
    lines.push(PIECES[Math.floor(next() * PIECES.length)] ?? '');
  const ending = next() < 0.15 ? '\r\n' : next() < 0.1 ? '\r' : '\n';
  return lines.join(ending) + (next() < 0.5 ? ending : '');
}

/** The oracle: the parser's own `code` nodes, found by an independent recursive walk. */
function oracleCodeLines(doc: string): Set<number> {
  const lines = doc.split(/\r\n?|\n/);
  const found = new Set<number>();
  const walk = (node: {
    type: string;
    position?: { start: { line: number }; end: { line: number } };
    children?: unknown[];
  }): void => {
    if (node.type === 'code' && node.position) {
      for (
        let line = node.position.start.line;
        line <= node.position.end.line;
        line += 1
      )
        if ((lines[line - 1] ?? '').trim() !== '') found.add(line - 1);
    }
    for (const child of node.children ?? []) walk(child as typeof node);
  };
  walk(fromMarkdown(doc) as unknown as Parameters<typeof walk>[0]);
  return found;
}

describe("oracle agreement: the lines the extractor blanks are the parser's code nodes", () => {
  it('agrees on every one of 3000 seeded random documents', () => {
    const next = rng(20261011);
    let withCode = 0;
    let withIndentedOnly = 0;
    const disagreements: string[] = [];
    for (let n = 0; n < 3000; n += 1) {
      const doc = document(next);
      const raw = doc.split(/\r\n?|\n/);
      const blanked = blankCodeBlocks(doc);
      if (blanked === undefined) {
        disagreements.push(`unparseable: ${JSON.stringify(doc)}`);
        continue;
      }
      const mine = new Set<number>();
      blanked.forEach((line, index) => {
        if (line === '' && (raw[index] ?? '').trim() !== '') mine.add(index);
      });
      // Nothing outside a code node may change (a whitespace-only line inside one is blanked too, and reads the same).
      blanked.forEach((line, index) => {
        if (
          !mine.has(index) &&
          line !== raw[index] &&
          (raw[index] ?? '').trim() !== ''
        )
          disagreements.push(`altered line ${index}: ${JSON.stringify(doc)}`);
      });
      const oracle = oracleCodeLines(doc);
      if (oracle.size > 0) withCode += 1;
      if (oracle.size > 0 && !raw.some((l) => /^\s{0,3}(```|~~~)/.test(l)))
        withIndentedOnly += 1;
      if ([...mine].sort().join() !== [...oracle].sort().join())
        disagreements.push(JSON.stringify(doc));
    }
    expect(disagreements.slice(0, 5)).toEqual([]);
    // A fuzz that never produced code would agree with everything.
    expect(withCode).toBeGreaterThan(600);
    expect(withIndentedOnly).toBeGreaterThan(50);
  });
});
