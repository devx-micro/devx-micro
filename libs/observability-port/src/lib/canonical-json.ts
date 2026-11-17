/**
 * RFC 8785 JSON Canonicalization Scheme — ADR-072 D3.
 *
 * Why this exists rather than `computeRevision`: that function hashes an `EntityState`, which
 * `canonical.ts` restricts to string attributes and roles, so a nested observation record (arrays,
 * numbers, booleans, null) would first need a lossy flattening. The ID shape is shared with
 * `Revision`; the hash input is not.
 *
 * ECMAScript's own `JSON.stringify` is what RFC 8785 specifies for numbers (the ES Number-to-string
 * algorithm) and for string escaping, so those are delegated to it. What it does not give is the key
 * order (UTF-16 code units, which is exactly what `Array.prototype.sort()` with no comparator uses),
 * and a refusal of everything that has no JSON form: this function throws where `JSON.stringify` would
 * silently coerce or emit `null` (NaN, Infinity, `undefined` in an array, holes), because a hash input that quietly changes shape is an
 * integrity hole, not a convenience. The one deliberate exception is an object member whose value is
 * `undefined`: it is an absent field (ADR-072 D5, "absent is not zero") and is omitted, so `{a: undefined}`
 * and `{}` are the same record.
 */

function assertWellFormed(text: string, what: string): void {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index++;
        continue;
      }
      throw new Error(
        `${what} contains a lone surrogate, which has no well-formed UTF-8`,
      );
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error(
        `${what} contains a lone surrogate, which has no well-formed UTF-8`,
      );
    }
  }
}

/**
 * Replace each lone surrogate with U+FFFD, leaving valid text and valid pairs alone. For text that comes from a caller
 * and must still be recordable: the hasher refuses ill-formed Unicode, so an ill-formed name would otherwise suppress the
 * caller's own observation. (`String.prototype.toWellFormed` does this, but the repo's TypeScript lib predates it.)
 */
export function wellFormed(text: string): string {
  return text.replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    '\ufffd',
  );
}

/** Throws unless `text` is well-formed Unicode. Exported for the content-id functions. */
export function assertWellFormedText(text: string, what = 'text'): void {
  assertWellFormed(text, what);
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const MAX_DEPTH = 256;

function serialize(value: unknown, stack: object[]): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      assertWellFormed(value, 'a string');
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`The number ${value} cannot be represented in JSON`);
      }
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new Error(
        `A value of type ${typeof value} cannot be represented in JSON`,
      );
  }
  const object = value as object;
  if (stack.includes(object))
    throw new Error('A cycle cannot be represented in JSON');
  if (stack.length >= MAX_DEPTH)
    throw new Error(
      `Values nested deeper than ${MAX_DEPTH} levels are refused`,
    );
  stack.push(object);
  try {
    if (Array.isArray(object)) {
      if (Object.getOwnPropertySymbols(object).length > 0) {
        throw new Error(
          'An array with a symbol key cannot be represented in JSON',
        );
      }
      // `length` is the one own, non-enumerable property an array always has.
      if (
        Object.getOwnPropertyNames(object).length !==
        Object.keys(object).length + 1
      ) {
        throw new Error(
          'An array with a non-index property cannot be represented in JSON',
        );
      }
      if (Object.keys(object).length !== object.length) {
        throw new Error(
          Object.keys(object).some((key) => !/^(0|[1-9]\d*)$/.test(key))
            ? 'An array with a non-index property cannot be represented in JSON'
            : 'An array with a hole cannot be represented in JSON',
        );
      }
      const items: string[] = [];
      for (let index = 0; index < object.length; index++) {
        if (!(index in object))
          throw new Error(`The array has a hole at index ${index}`);
        const item: unknown = object[index];
        if (item === undefined)
          throw new Error(`undefined at index ${index} of an array`);
        items.push(serialize(item, stack));
      }
      return `[${items.join(',')}]`;
    }
    if (!isPlainObject(object)) {
      throw new Error(
        'Only plain objects, arrays and JSON scalars are canonicalised',
      );
    }
    const record = object as Record<string, unknown>;
    if (Object.getOwnPropertySymbols(record).length > 0) {
      throw new Error(
        'An object with a symbol key cannot be represented in JSON',
      );
    }
    if (
      Object.getOwnPropertyNames(record).length !== Object.keys(record).length
    ) {
      throw new Error(
        'An object with a non-enumerable property cannot be represented in JSON',
      );
    }
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => {
        assertWellFormed(key, 'a property name');
        return `${JSON.stringify(key)}:${serialize(record[key], stack)}`;
      });
    return `{${members.join(',')}}`;
  } finally {
    stack.pop();
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, []);
}
