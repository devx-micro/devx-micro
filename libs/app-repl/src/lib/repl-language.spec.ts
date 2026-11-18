import { describe, expect, it } from 'vitest';

import {
  bindOperationLine,
  describeVariable,
  parseReplCommand,
  referenceOf,
  type VariableLookup,
} from './repl-language';

const vars: Record<string, unknown> = {
  open: {
    hits: [{ id: 'd-1', title: 'a b "c" --force true' }, { id: 'd-2' }],
    total: 2,
    ok: true,
    none: null,
  },
  nasty: 'two words "quoted" --force true --json {"x":1}',
  list: ['x', 'y'],
  n: 5,
  'dash-name': 'dashed',
};
const lookup: VariableLookup = async (name) =>
  Object.prototype.hasOwnProperty.call(vars, name)
    ? { found: true, value: vars[name] }
    : { found: false };

const bind = (line: string) => bindOperationLine(line, lookup);
const refused = (line: string, message: RegExp) =>
  expect(bind(line)).rejects.toMatchObject({
    message: expect.stringMatching(message),
    exitCode: 2,
  });

describe('parseReplCommand', () => {
  it.each([
    ['vars', { kind: 'vars' }],
    ['unset $x', { kind: 'unset', name: 'x' }],
    ['board attach kept', { kind: 'attach', board: 'kept' }],
    ['board save kept', { kind: 'save', name: 'kept' }],
    [
      'set $x = defect.list --status open',
      { kind: 'set', name: 'x', line: 'defect.list --status open' },
    ],
    [
      'set $x={"operation":"a","input":{}}',
      { kind: 'set', name: 'x', line: '{"operation":"a","input":{}}' },
    ],
    [
      'defect.list --status open',
      { kind: 'operation', line: 'defect.list --status open' },
    ],
    [
      'board.entry.get --scope board:b --key k',
      { kind: 'operation', line: 'board.entry.get --scope board:b --key k' },
    ],
  ])('%s', (line, expected) => {
    expect(parseReplCommand(line)).toEqual(expected);
  });

  it.each([
    'vars now',
    'unset',
    'unset x',
    'unset $1x',
    'unset $a $b',
    'board attach',
    'board save a b',
    'set',
    'set x = a',
    'set $x',
    'set $x =',
  ])('refuses %j as a usage error', (line) => {
    expect(() => parseReplCommand(line)).toThrow(
      expect.objectContaining({ exitCode: 2 }),
    );
  });
});

describe('referenceOf', () => {
  it('parses names, fields and indexes', () => {
    expect(referenceOf('$open.hits[0].id')).toEqual({
      name: 'open',
      path: ['hits', 0, 'id'],
      text: '$open.hits[0].id',
    });
    expect(referenceOf('$dash-name')).toMatchObject({
      name: 'dash-name',
      path: [],
    });
  });
  it('leaves a word that is not a reference alone', () => {
    expect(referenceOf('plain')).toBeUndefined();
    expect(referenceOf('"$x"')).toBeUndefined();
  });
  it('$$ is a literal dollar', () => {
    expect(referenceOf('$$5.00')).toEqual({ literal: '$5.00' });
  });
  it.each([
    '$',
    '$1',
    '$x..y',
    '$x.',
    '$x[a]',
    '$x[-1]',
    '$x.a b',
    '$x[0',
    '$.x',
  ])('refuses the malformed %j', (word) => {
    expect(() => referenceOf(word)).toThrow(
      expect.objectContaining({ exitCode: 2 }),
    );
  });
});

describe('bindOperationLine', () => {
  it('replaces a reference with the value, typed', async () => {
    expect(
      await bind(
        'board.entry.get --scope board:b --key $open.hits[1].id --n $n --flag $open.ok --nothing $open.none',
      ),
    ).toEqual({
      operation: 'board.entry.get',
      input: { scope: 'board:b', key: 'd-2', n: 5, flag: true, nothing: null },
    });
  });

  it('passes objects and arrays through whole', async () => {
    const { input } = await bind('op --v $open.hits[1] --l $list');
    expect(input).toEqual({ v: { id: 'd-2' }, l: ['x', 'y'] });
  });

  // 🔴 The probe the checklist asks for: spaces, quotes and `--force true` in a value.
  it('a value with spaces, quotes and --force true arrives as ONE literal argument, never extra arguments or a flag', async () => {
    const { operation, input } = await bind('op --title $nasty --after done');
    expect(operation).toBe('op');
    expect(input).toEqual({
      title: 'two words "quoted" --force true --json {"x":1}',
      after: 'done',
    });
    expect(Object.keys(input)).toEqual(['title', 'after']);
  });

  it('a value that is itself a flag name cannot become one', async () => {
    const lookup2: VariableLookup = async () => ({
      found: true,
      value: '--scope',
    });
    const { input } = await bindOperationLine('op --key $x --other y', lookup2);
    expect(input).toEqual({ key: '--scope', other: 'y' });
  });

  it('a value used as a positional where a flag is expected is still just refused as an unexpected argument', async () => {
    await expect(bind('op $nasty')).rejects.toMatchObject({
      code: 'UNEXPECTED_ARGUMENT',
    });
  });

  it('a repeated flag accumulates resolved values in order', async () => {
    expect((await bind('op --a $list[0] --a $list[1]')).input).toEqual({
      a: ['x', 'y'],
    });
  });

  it('$$x is the literal $x and a quoted word is literal', async () => {
    expect((await bind('op --a $$open --b "$open"')).input).toEqual({
      a: '$open',
      b: '"$open"',
    });
  });

  it('refuses an operation name that is a variable', async () => {
    await refused('$open --x 1', /operation name cannot be a variable/);
  });

  describe('an unresolved reference is refused with its path, and nothing is dispatched', () => {
    it('an unset variable', async () =>
      refused(
        'op --x $missing.a',
        /Unresolved reference \$missing\.a: \$missing is not set/,
      ));
    it('a missing field', async () =>
      refused('op --x $open.nope', /\$open\.nope: there is no field "nope"/));
    it('an index out of range', async () =>
      refused(
        'op --x $open.hits[9].id',
        /\$open\.hits\[9\]\.id: there is no element \[9\]/,
      ));
    it('a field of a scalar', async () =>
      refused('op --x $n.a', /there is no field "a"/));
    it('an index into an object', async () =>
      refused('op --x $open[0]', /there is no element \[0\]/));
    it('an inherited property is not a field', async () =>
      refused('op --x $open.constructor', /there is no field "constructor"/));
    it('__proto__ is not a field', async () =>
      refused('op --x $open.__proto__', /there is no field "__proto__"/));
  });

  describe('a JSON line', () => {
    it('replaces a whole-string reference with the JSON value itself', async () => {
      const { operation, input } = await bind(
        '{"operation":"op","input":{"id":"$open.hits[0].id","all":"$open.hits","t":"$nasty","keep":"$5 fee","lit":"$$x"}}',
      );
      expect(operation).toBe('op');
      expect(input['id']).toBe('d-1');
      expect(input['all']).toEqual((vars['open'] as { hits: unknown }).hits);
      expect(input['t']).toBe(vars['nasty']);
      expect(input['keep']).toBe('$5 fee');
      expect(input['lit']).toBe('$x');
    });

    it('refuses an unresolved reference in a JSON line', async () =>
      refused('{"operation":"op","input":{"a":"$nope"}}', /\$nope is not set/));

    it('a variable containing JSON syntax stays a string and cannot add members', async () => {
      const lookup3: VariableLookup = async () => ({
        found: true,
        value: '","injected":"yes',
      });
      const { input } = await bindOperationLine(
        '{"operation":"op","input":{"a":"$x"}}',
        lookup3,
      );
      expect(input).toEqual({ a: '","injected":"yes' });
    });

    it('needs a string operation', async () => {
      await refused('{"input":{}}', /needs a string "operation"/);
    });
  });
});

describe('describeVariable', () => {
  it.each([
    [null, 'null'],
    [[1, 2], 'array(2)'],
    [{ a: 1, b: 2 }, 'object{a, b}'],
    ['hi', 'string "hi"'],
    [5, 'number 5'],
  ])('%j', (value, expected) => {
    expect(describeVariable(value)).toBe(expected);
  });
  it('shortens a long string', () => {
    expect(describeVariable('x'.repeat(100)).length).toBeLessThan(60);
  });
});
