import { TOOL_EXIT_CODES, ToolRuntimeError } from './contracts';

/**
 * Input validation for a `ToolOperationDescriptor`'s `validate` hook.
 *
 * 🔴 **These exist because several contexts coerced instead of validating.** Each carried a local
 * `str(input, key, fallback)` that returned the fallback for a missing key — so
 * `str(input, 'promotionId', '')` turned *"you forgot the promotion id"* into an empty string that
 * failed somewhere downstream, in a message naming neither the key nor the operation. An empty
 * fallback was the author's way of writing "required", and nothing enforced it.
 *
 * Later modules hand-rolled these same helpers again. Many copies of one idea is the trigger to extract it.
 *
 * 🔴 **Every failure is `INVALID_INPUT` at exit 2.** A caller branching on `error.code` must be able
 * to tell "you typed it wrong" from "the store broke", and a usage error must not look like a
 * failure.
 */

/** Says what arrived **without echoing it** — payloads replicate, and some carry attribute values. */
export function describeValue(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

export function invalidInput(message: string): never {
  throw new ToolRuntimeError('INVALID_INPUT', message, TOOL_EXIT_CODES.usage);
}

/**
 * Read a number from input **by parsing it**, never by coercing it. `null` means "not a number".
 *
 * 🔴 **`Number()` answers a different question from "is this a number".** `Number(true)` is 1,
 * `Number('   ')` and `Number([])` are 0, and `Number(['7'])` is 7, because a one-element array
 * stringifies to its element. An `Number.isInteger` check downstream then passes all four, so every
 * validator built on `Number()` turned malformed input into a plausible value instead of refusing
 * it. The audit found that exact shape in four validators across four bounded contexts —
 * `requiredExitCode`, `optionalCount`, `optionalTemperature` and `positiveInteger` — which is why
 * the parse lives here now rather than being written a fifth time.
 *
 * The CLI transport hands over strings — and an array when a flag is repeated — so a numeric string
 * is the normal case and must be accepted; what must not be accepted is a value that merely
 * *coerces* to a number, an array's one element included.
 */
export function parsedNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // Deliberately stricter than `Number`: no hex, no exponent, no infinity, no empty string.
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `parsedNumber` restricted to whole numbers. `null` means "not a whole number". */
export function parsedWholeNumber(value: unknown): number | null {
  const parsed = parsedNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

/**
 * What a `validate` hook looked at, so the runtime can tell an unknown key from a known one.
 *
 * 🔴 **An input key is accepted if and only if `validate` read it.** The first attempt derived the
 * accepted names from `validate`'s *output* instead, and that is wrong: `prompt.create` accepts
 * `--text` and `--file` and folds them into a single `source` field, so an output-key rule refuses
 * a working argument. What a hook *reads* is the honest definition of what it accepts, and it
 * cannot drift from the hook the way a hand-maintained list beside it would.
 *
 * Optional arguments are read even when absent — `optionalString(input, 'parentStep', …)` looks
 * the key up either way — so after a successful `validate` the recorded set is also the operation's
 * argument vocabulary, which is what makes the error message able to list it.
 *
 * 🔴 **`ownKeys` marks everything read, on purpose.** A hook that spreads or enumerates the whole
 * object has, in effect, looked at all of it, and this fails *open*: accepting a key we cannot
 * attribute is a far smaller harm than refusing an argument that works.
 */
export interface InputProbe {
  /** Hand this to `validate`, not the original. */
  readonly input: Record<string, unknown>;
  readonly wasRead: (key: string) => boolean;
  /** Every key the hook looked at — its argument vocabulary, absent optionals included. */
  readonly readKeys: () => readonly string[];
}

export function probeInput(received: Record<string, unknown>): InputProbe {
  const read = new Set<string>();

  const input = new Proxy(received, {
    get(target, property, receiver) {
      if (typeof property === 'string') read.add(property);
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      if (typeof property === 'string') read.add(property);
      return Reflect.has(target, property);
    },
    ownKeys(target) {
      for (const key of Object.keys(target)) read.add(key);
      return Reflect.ownKeys(target);
    },
  });

  return {
    input,
    wasRead: (key) => read.has(key),
    readKeys: () => [...read],
  };
}

/**
 * Refuse input keys the operation never looked at.
 *
 * 🔴 **Silently dropping an unknown key lets a typo change what the command does.** `validate`
 * builds a fresh object from the keys it knows, so anything else the caller typed was discarded
 * without a word: `item.push --item x --parentId w`
 * (the *command class's* field names, not the *operation's* argument names) ran as a **root** push
 * and reported success. That reads exactly like the nesting check failing to fire, and it cost a
 * debugging pass before the flags — not the code — turned out to be wrong.
 *
 * 🔴 Runs only after `validate` **succeeded**. A hook that threw has already said something more
 * useful, and a missing required argument is the better message when both are true.
 */
export function assertNoUnknownInput(
  operation: string,
  received: Record<string, unknown>,
  probe: InputProbe,
): void {
  const unknown = Object.keys(received).filter((key) => !probe.wasRead(key));
  if (unknown.length === 0) return;

  const quote = (key: string): string => `'${key}'`;
  // The vocabulary, not the intersection with what arrived: a caller who mistyped `parentStep`
  // needs to be told the name exists, and it is absent from their own input by definition.
  const accepted = probe.readKeys().filter((key) => !unknown.includes(key));

  invalidInput(
    `${operation} does not accept ${unknown.map(quote).join(', ')}. ` +
      (accepted.length > 0
        ? `It accepts ${accepted.sort().map(quote).join(', ')}.`
        : 'It takes no arguments.'),
  );
}

/**
 * A required, non-empty string.
 *
 * `path` is the key as the **caller** typed it — `'document.title'`, not `title` — so a message is
 * actionable by someone who cannot see this source.
 */
export function requiredString(
  input: Record<string, unknown>,
  key: string,
  operation: string,
  path: string = key,
): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') {
    invalidInput(
      `${operation} needs a non-empty string '${path}'; received ${describeValue(value)}.`,
    );
  }
  return value as string;
}

/** A string that may be absent, but must be a non-empty string when present. */
export function optionalString(
  input: Record<string, unknown>,
  key: string,
  operation: string,
  path: string = key,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    invalidInput(
      `${operation}'s '${path}' must be a non-empty string when given; received ${describeValue(value)}.`,
    );
  }
  return value as string;
}

/** A required object — not an array, not null. */
export function requiredObject(
  input: Record<string, unknown>,
  key: string,
  operation: string,
  path: string = key,
): Record<string, unknown> {
  const value = input[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidInput(
      `${operation} needs an object '${path}'; received ${describeValue(value)}.`,
    );
  }
  return value as Record<string, unknown>;
}

/** An object that may be absent, defaulting to `{}`. */
export function optionalObject(
  input: Record<string, unknown>,
  key: string,
  operation: string,
  path: string = key,
): Record<string, unknown> {
  if (input[key] === undefined || input[key] === null) return {};
  return requiredObject(input, key, operation, path);
}

/**
 * An array that may be absent, defaulting to `[]`, validated element by element.
 *
 * 🔴 The index is named. `'evidence[1]'` is actionable; *"invalid input"* is not.
 */
export function optionalArray<T>(
  input: Record<string, unknown>,
  key: string,
  operation: string,
  element: (value: unknown, path: string) => T,
  path: string = key,
): T[] {
  const value = input[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    invalidInput(
      `${operation} needs an array '${path}'; received ${describeValue(value)}.`,
    );
  }
  return (value as unknown[]).map((entry, index) =>
    element(entry, `${path}[${index}]`),
  );
}

/** An element validator for `optionalArray`: a non-empty string. */
export const nonEmptyStringElement =
  (operation: string) =>
  (value: unknown, path: string): string => {
    if (typeof value !== 'string' || value.trim() === '') {
      invalidInput(
        `${operation}: '${path}' must be a non-empty string; received ${describeValue(value)}.`,
      );
    }
    return value as string;
  };
