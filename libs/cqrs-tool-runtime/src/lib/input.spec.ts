import { CqrsToolRuntime } from './cqrs-tool-runtime';
import { TOOL_EXIT_CODES, type ToolBus } from './contracts';
import {
  describeValue,
  invalidInput,
  nonEmptyStringElement,
  optionalArray,
  optionalObject,
  optionalString,
  parsedNumber,
  parsedWholeNumber,
  requiredObject,
  requiredString,
} from './input';

/**
 * 🔴 These helpers exist because four contexts **coerced instead of validating**.
 *
 * `str(input, 'promotionId', '')` turned a forgotten id into an empty string that failed somewhere
 * downstream, in a message naming neither the key nor the operation — and an empty fallback was the
 * only signal that the key was required at all.
 */
describe('input validation', () => {
  describe('requiredString', () => {
    it('returns the value when it is a non-empty string', () => {
      expect(requiredString({ id: 'x' }, 'id', 'op')).toBe('x');
    });

    it.each([
      ['nothing', {}],
      ['null', { id: null }],
      ['a number', { id: 7 }],
      ['an array', { id: ['x'] }],
    ])('refuses %s', (described, input) => {
      expect(() =>
        requiredString(input as Record<string, unknown>, 'id', 'op'),
      ).toThrow(
        new RegExp(`op needs a non-empty string 'id'; received ${described}`),
      );
    });

    // 🔴 The case the old `str(…, '')` produced by design: whitespace is not a value.
    it('refuses a blank string rather than passing it through', () => {
      expect(() => requiredString({ id: '   ' }, 'id', 'op')).toThrow(
        /non-empty string 'id'/,
      );
    });

    // The message names the key as the *caller* typed it, not the domain field it becomes.
    it('names a nested path when one is given', () => {
      expect(() =>
        requiredString({}, 'title', 'document.add', 'document.title'),
      ).toThrow(/'document\.title'/);
    });
  });

  describe('optionalString', () => {
    it('passes undefined through, so a message class applies its own default', () => {
      expect(optionalString({}, 'remote', 'op')).toBeUndefined();
      expect(optionalString({ remote: null }, 'remote', 'op')).toBeUndefined();
    });

    // 🔴 Absent is fine; present-but-wrong is not. That distinction is the whole point.
    it('refuses a present value of the wrong type', () => {
      expect(() => optionalString({ remote: 7 }, 'remote', 'op')).toThrow(
        /'remote' must be a non-empty string when given; received a number/,
      );
    });
  });

  describe('objects', () => {
    it('refuses an array where an object is required', () => {
      expect(() => requiredObject({ doc: [] }, 'doc', 'op')).toThrow(
        /needs an object 'doc'; received an array/,
      );
    });

    it('refuses null, which typeof calls an object', () => {
      expect(() => requiredObject({ doc: null }, 'doc', 'op')).toThrow(
        /received null/,
      );
    });

    it('defaults an absent optional object to {}', () => {
      expect(optionalObject({}, 'artifacts', 'op')).toEqual({});
    });
  });

  describe('arrays', () => {
    it('defaults an absent array to []', () => {
      expect(
        optionalArray({}, 'evidence', 'op', nonEmptyStringElement('op')),
      ).toEqual([]);
    });

    /**
     * 🔴 The failure this replaces. `Array.isArray(input['evidence']) ? … : []` turned a string into
     * an empty array — which reads exactly like "the caller passed none", and `[]` is the shape a
     * caller reaches for when it wants to skip a requirement.
     */
    it('refuses a non-array rather than silently returning []', () => {
      expect(() =>
        optionalArray(
          { evidence: 'certified' },
          'evidence',
          'op',
          nonEmptyStringElement('op'),
        ),
      ).toThrow(/needs an array 'evidence'; received a string/);
    });

    it('names the index of a bad element', () => {
      expect(() =>
        optionalArray(
          { evidence: ['ok', ''] },
          'evidence',
          'op',
          nonEmptyStringElement('op'),
        ),
      ).toThrow(/'evidence\[1\]' must be a non-empty string/);
    });
  });

  describe('describeValue', () => {
    // 🔴 Says what arrived without echoing it — payloads replicate, and some carry attribute values.
    it('never quotes the value itself', () => {
      expect(describeValue('super-secret')).toBe('a string');
      expect(describeValue(undefined)).toBe('nothing');
      expect(describeValue(null)).toBe('null');
      expect(describeValue([1])).toBe('an array');
    });
  });

  /**
   * 🔴 The contract a caller branches on: a usage error must be `INVALID_INPUT` at exit **2**, and
   * must not look like a handler failure.
   */
  describe('through a real runtime', () => {
    class SilentBus implements ToolBus {
      public async execute(): Promise<unknown> {
        return null;
      }
    }

    const runtime = () =>
      new CqrsToolRuntime({
        commandBus: new SilentBus(),
        queryBus: new SilentBus(),
        operations: [
          {
            name: 'demo.op',
            summary: 'demo',
            kind: 'query',
            validate: (input) => ({
              id: requiredString(input, 'id', 'demo.op'),
            }),
            createRequest: (input) => ({ id: input['id'] }),
          },
        ],
      });

    it('reports a missing input as INVALID_INPUT at exit 2', async () => {
      const envelope = await runtime().dispatch('demo.op', {});

      expect(envelope.status).toBe('error');
      expect(envelope.error?.code).toBe('INVALID_INPUT');
      expect(envelope.exitCode).toBe(TOOL_EXIT_CODES.usage);
    });

    it('dispatches when the input is valid', async () => {
      expect((await runtime().dispatch('demo.op', { id: 'x' })).status).toBe(
        'success',
      );
    });

    // 🔴 A caller error, not a server error. A string or array where the input object should be —
    // `{"input": "nope"}` over HTTP or the sidecar — used to reach `probeInput`'s Proxy and surface
    // as HANDLER_FAILURE at exit 1 / HTTP 500 (d-20260912-cqrstoolruntime-dispatch-answers-a-non-object).
    it.each([
      ['a string', 'nope'],
      ['an array', ['nope']],
      ['null', null],
      ['a number', 7],
    ])(
      'reports %s as the input as INVALID_INPUT at exit 2, before any hook runs',
      async (_label, input) => {
        const envelope = await runtime().dispatch('demo.op', input as never);

        expect(envelope.status).toBe('error');
        expect(envelope.error?.code).toBe('INVALID_INPUT');
        expect(envelope.exitCode).toBe(TOOL_EXIT_CODES.usage);
        expect(envelope.error?.message).toMatch(/demo\.op.*object/);
      },
    );
  });

  describe('invalidInput', () => {
    it('is a ToolRuntimeError, so dispatch keeps its code rather than flattening it', async () => {
      expect(() => invalidInput('nope')).toThrow(/nope/);
    });
  });
});

/**
 * 🔴 The parse that replaced four separate `Number()` coercions (see `parsedNumber`).
 *
 * Each case below is one a coercion accepted and a parse must not: the audit observed
 * `Number(true) === 1`, `Number('   ') === 0`, `Number([]) === 0` and `Number(['7']) === 7`
 * reaching validators as exit codes, page sizes, temperatures and ancestor counts.
 */
describe('parsedNumber and parsedWholeNumber', () => {
  it.each([
    ['a number', 7, 7],
    ['zero', 0, 0],
    ['a negative number', -1, -1],
    ['the string form the CLI delivers', '7', 7],
    ['a string with surrounding space', ' 7 ', 7],
    ['a negative string', '-1', -1],
  ])('parses %s', (_label, given, expected) => {
    expect(parsedNumber(given)).toBe(expected);
    expect(parsedWholeNumber(given)).toBe(expected);
  });

  it('parses a decimal, which is a number but not a whole one', () => {
    expect(parsedNumber('0.5')).toBe(0.5);
    expect(parsedWholeNumber('0.5')).toBeNull();
  });

  it.each([
    ['true, which is what a valueless flag becomes', true],
    ['false', false],
    ['whitespace', '   '],
    ['an empty string', ''],
    ['an empty array', []],
    ['a single-element array', ['7']],
    ['an object', {}],
    ['null', null],
    ['undefined', undefined],
    ['a word', 'abc'],
    ['a hex string', '0x10'],
    ['an exponent', '1e3'],
    ['Infinity as a number', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('refuses %s', (_label, given) => {
    expect(parsedNumber(given)).toBeNull();
    expect(parsedWholeNumber(given)).toBeNull();
  });
});
