import { canonicalJson, wellFormed } from './canonical-json';

describe('canonicalJson (RFC 8785)', () => {
  it('reproduces the RFC 8785 section 3.2.2 example byte for byte', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    );
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts keys by UTF-16 code units, so a surrogate pair sorts before U+FB33', () => {
    const input = {
      '\ufb33': 6,
      '\ud83d\ude00': 5,
      '\u20ac': 4,
      '\u0080': 3,
      '1': 2,
      '\r': 1,
    };
    // Assert on the canonical STRING: parsing it back would let JavaScript hoist the integer-like key "1".
    const expectedOrder = [
      '\r',
      '1',
      '\u0080',
      '\u20ac',
      '\ud83d\ude00',
      '\ufb33',
    ];
    const expected = `{${expectedOrder.map((key) => `${JSON.stringify(key)}:${(input as Record<string, number>)[key]}`).join(',')}}`;
    expect(canonicalJson(input)).toBe(expected);
  });

  it('is independent of property insertion order', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(
      canonicalJson({ a: { c: 2, d: 1 }, b: 1 }),
    );
  });

  it('omits undefined properties like an absent field, but refuses undefined in an array', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson([1, undefined])).toThrow(/undefined/);
  });

  it('writes -0 as 0 and refuses non-finite numbers, functions, symbols and bigint', () => {
    expect(canonicalJson([-0])).toBe('[0]');
    for (const bad of [
      Number.NaN,
      Infinity,
      -Infinity,
      () => 1,
      Symbol('x'),
      BigInt(1),
    ]) {
      expect(() => canonicalJson({ v: bad })).toThrow(/cannot be represented/);
    }
  });

  it('refuses a lone surrogate, which has no well-formed UTF-8', () => {
    expect(() => canonicalJson('\ud800')).toThrow(/surrogate/);
    expect(() => canonicalJson({ ['\ud800']: 1 })).toThrow(/surrogate/);
  });

  it('refuses a cycle and non-plain objects', () => {
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect(() => canonicalJson(loop)).toThrow(/cycle/);
    expect(() => canonicalJson(new Date(0))).toThrow(/plain/);
    expect(() => canonicalJson(new Map())).toThrow(/plain/);
  });

  it('refuses what JSON.stringify would silently reshape: holes, extra array properties, symbol keys, non-enumerable properties', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalJson([1, , 3])).toThrow(/hole/);
    const extra: unknown[] = [1, 2];
    (extra as unknown as Record<string, number>)['x'] = 5;
    expect(() => canonicalJson(extra)).toThrow(/non-index/);
    expect(() => canonicalJson({ [Symbol('s')]: 1, b: 2 })).toThrow(/symbol/);
    const symbolic: unknown[] = [1];
    (symbolic as unknown as Record<symbol, number>)[Symbol('s')] = 2;
    expect(() => canonicalJson(symbolic)).toThrow(/symbol/);
    const hiddenIndex: unknown[] = [1];
    Object.defineProperty(hiddenIndex, 'extra', {
      value: 2,
      enumerable: false,
    });
    expect(() => canonicalJson(hiddenIndex)).toThrow(/non-index/);
    const hidden = { b: 2 };
    Object.defineProperty(hidden, 'a', { value: 1, enumerable: false });
    expect(() => canonicalJson(hidden)).toThrow(/non-enumerable/);
  });

  it('names a nesting limit instead of overflowing the stack', () => {
    let deep: unknown = 1;
    for (let level = 0; level < 5000; level++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(/nested deeper than/);
  });

  it('wellFormed replaces each lone surrogate with U+FFFD and leaves valid text, including pairs, untouched', () => {
    expect(wellFormed('abc')).toBe('abc');
    expect(wellFormed('')).toBe('');
    expect(wellFormed('a\ud800b')).toBe('a\ufffdb');
    expect(wellFormed('a\udc00b')).toBe('a\ufffdb');
    expect(wellFormed('\ud83d\ude00')).toBe('\ud83d\ude00');
    expect(wellFormed('x\ud83d')).toBe('x\ufffd');
    expect(wellFormed('\ude00\ud83d')).toBe('\ufffd\ufffd');
    expect(() => canonicalJson(wellFormed('\ud800'))).not.toThrow();
  });
});
