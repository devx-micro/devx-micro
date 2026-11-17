import { TOOL_EXIT_CODES, ToolRuntimeError } from './contracts';
import { parseToolArguments } from './cqrs-tool-runtime';
import { VARIABLE_NAME } from './session-board';

/**
 * The REPL's line language (ADR-066 D7), kept apart from the readline loop so it can be tested
 * without a terminal.
 *
 * 🔴 **References are resolved AFTER the line is tokenised, and each becomes exactly one value.**
 * A reference token is swapped for an opaque placeholder *before* argument parsing, and the real
 * value is put in *after* it. So a value that contains spaces, quotes or `--force true` arrives as
 * one literal argument: it is never re-tokenised, and it can never become a flag, because by the
 * time it is substituted the flags have already been decided. In a JSON line the substitution
 * happens on the parsed object, so it is the JSON value itself.
 */

export type ReplCommand =
  | { readonly kind: 'vars' }
  | { readonly kind: 'unset'; readonly name: string }
  | { readonly kind: 'attach'; readonly board: string }
  | { readonly kind: 'save'; readonly name: string }
  | { readonly kind: 'set'; readonly name: string; readonly line: string }
  | { readonly kind: 'operation'; readonly line: string };

const usage = (message: string): never => {
  throw new ToolRuntimeError('INVALID_INPUT', message, TOOL_EXIT_CODES.usage);
};

const variableToken = (token: string | undefined, command: string): string => {
  const match = /^\$(.+)$/.exec(token ?? '');
  const name = match?.[1];
  if (name === undefined || !VARIABLE_NAME.test(name)) {
    return usage(
      `${command} needs a variable written $name (letters, digits, _ and -; not starting with a digit).`,
    );
  }
  return name;
};

/** Classifies a line. `help`, `exit` and an empty line are the caller's. */
export function parseReplCommand(
  line: string,
  isOperation: (name: string) => boolean = () => false,
): ReplCommand {
  const trimmed = line.trim();
  const words = trimmed.split(/\s+/);
  // A registered operation always wins: an app's own `set` or `vars` must stay reachable.
  if (isOperation(words[0])) return { kind: 'operation', line: trimmed };
  if (words[0] === 'vars') {
    if (words.length > 1) usage('vars takes no arguments.');
    return { kind: 'vars' };
  }
  if (words[0] === 'unset') {
    if (words.length !== 2) usage('unset needs one variable: unset $name.');
    return { kind: 'unset', name: variableToken(words[1], 'unset') };
  }
  if (words[0] === 'board' && (words[1] === 'attach' || words[1] === 'save')) {
    if (words.length !== 3)
      usage(
        `board ${words[1]} needs one board name: board ${words[1]} <name>.`,
      );
    return words[1] === 'attach'
      ? { kind: 'attach', board: words[2] }
      : { kind: 'save', name: words[2] };
  }
  if (words[0] === 'set') {
    const match = /^set\s+(\$\S+)\s*=\s*([\s\S]+)$/.exec(trimmed);
    if (!match)
      return usage(
        'set needs a variable and an operation: set $name = <operation line>.',
      );
    return {
      kind: 'set',
      name: variableToken(match[1], 'set'),
      line: match[2].trim(),
    };
  }
  return { kind: 'operation', line: trimmed };
}

/** `$name`, then any `.segment` or `[index]` (ADR-066 D7: dot and index segments only). */
const REFERENCE = new RegExp(
  `^\\$(${VARIABLE_NAME.source.slice(1, -1)})((?:\\.[A-Za-z0-9_-]+|\\[\\d+\\])*)$`,
);

export interface Reference {
  readonly name: string;
  readonly path: readonly (string | number)[];
  /** As typed, for messages. */
  readonly text: string;
}

/**
 * What a bare word starting with `$` means. `undefined`: not a reference attempt (a literal).
 * `$$x` is the literal `$x`. Anything else starting with `$` that does not parse is refused rather
 * than passed through, because `$x..y` is a typo and passing it on would send a literal nobody meant.
 */
export function referenceOf(
  word: string,
): Reference | { readonly literal: string } | undefined {
  if (!word.startsWith('$')) return undefined;
  if (word.startsWith('$$')) return { literal: word.slice(1) };
  const match = REFERENCE.exec(word);
  if (!match)
    return usage(
      `'${word}' is not a valid reference. Write $name, $name.field or $name[0]; write $$ for a literal $.`,
    );
  const path: (string | number)[] = [];
  for (const segment of match[2].matchAll(/\.([A-Za-z0-9_-]+)|\[(\d+)\]/g)) {
    path.push(segment[1] !== undefined ? segment[1] : Number(segment[2]));
  }
  return { name: match[1], path, text: word };
}

const isReference = (
  value: Reference | { literal: string } | undefined,
): value is Reference => value !== undefined && 'name' in value;

/** Follows `path` into `value`. Throws, naming the reference, when a step is missing. */
export function followPath(reference: Reference, value: unknown): unknown {
  let current = value;
  for (const segment of reference.path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) {
        return usage(
          `Unresolved reference ${reference.text}: there is no element [${segment}].`,
        );
      }
      current = current[segment];
    } else {
      if (
        typeof current !== 'object' ||
        current === null ||
        Array.isArray(current) ||
        !Object.prototype.hasOwnProperty.call(current, segment)
      ) {
        return usage(
          `Unresolved reference ${reference.text}: there is no field "${segment}".`,
        );
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

export type VariableLookup = (
  name: string,
) => Promise<{ readonly found: boolean; readonly value?: unknown }>;

async function resolve(
  reference: Reference,
  lookup: VariableLookup,
): Promise<unknown> {
  const variable = await lookup(reference.name);
  if (!variable.found)
    return usage(
      `Unresolved reference ${reference.text}: $${reference.name} is not set.`,
    );
  return followPath(reference, variable.value);
}

/** Walks a parsed JSON value, replacing each whole-string reference with the JSON value it names. */
async function substituteJson(
  value: unknown,
  lookup: VariableLookup,
  depth = 0,
): Promise<unknown> {
  if (depth > 64) return usage('The request is nested too deeply.');
  if (typeof value === 'string') {
    // A string with whitespace is prose, not a reference attempt.
    if (!value.startsWith('$') || /\s/.test(value)) return value;
    const ref = referenceOf(value);
    if (ref === undefined) return value;
    return isReference(ref) ? resolve(ref, lookup) : ref.literal;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value)
      out.push(await substituteJson(item, lookup, depth + 1));
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      Object.defineProperty(out, key, {
        value: await substituteJson(member, lookup, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/** A malformed JSON request line is the person's mistake (INVALID_INPUT), and only this parse is. */
function parseJsonLine(line: string): Record<string, unknown> {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    throw new ToolRuntimeError(
      'INVALID_INPUT',
      error instanceof Error
        ? error.message
        : 'Each input line must be valid JSON',
      TOOL_EXIT_CODES.usage,
    );
  }
}

/** The same tokenisation the REPL has always used: bare words and double-quoted runs. */
export const tokenise = (line: string): string[] =>
  line.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];

/**
 * Turns one operation line into `{ operation, input }`, with every reference replaced.
 * Throws a `ToolRuntimeError` (exit 2) naming an unresolved reference; nothing is dispatched then.
 */
export async function bindOperationLine(
  line: string,
  lookup: VariableLookup | undefined,
): Promise<{
  readonly operation: string;
  readonly input: Record<string, unknown>;
}> {
  // 🔴 With no session board bound there are no variables, so no word is a reference: a `$5` or a
  // `$HOME/bin` stays the literal it always was in an app that never had this feature.
  if (lookup === undefined) {
    if (line.startsWith('{')) {
      const request = parseJsonLine(line) as {
        operation?: unknown;
        input?: Record<string, unknown>;
      };
      if (typeof request.operation !== 'string')
        return usage('A JSON request needs a string "operation".');
      return { operation: request.operation, input: request.input ?? {} };
    }
    return parseToolArguments(tokenise(line));
  }
  if (line.startsWith('{')) {
    const raw = parseJsonLine(line) as { operation?: unknown };
    if (
      typeof raw.operation === 'string' &&
      raw.operation.startsWith('$') &&
      !raw.operation.startsWith('$$')
    ) {
      return usage('An operation name cannot be a variable.');
    }
    const request = (await substituteJson(raw, lookup)) as {
      operation?: unknown;
      input?: Record<string, unknown>;
    };
    if (typeof request.operation !== 'string')
      return usage('A JSON request needs a string "operation".');
    return { operation: request.operation, input: request.input ?? {} };
  }

  // A nonce the line cannot contain, so a typed word can never collide with a placeholder.
  const nonce = `\u0000ref-${Math.random().toString(36).slice(2)}-`;
  const resolved = new Map<string, unknown>();
  const words = tokenise(line);
  const prepared: string[] = [];
  const typedAs = new Map<string, string>();
  for (const [index, word] of words.entries()) {
    const ref = referenceOf(word);
    if (ref === undefined) {
      prepared.push(word);
    } else if (!isReference(ref)) {
      prepared.push(ref.literal);
    } else {
      if (index === 0) return usage('An operation name cannot be a variable.');
      if (words[index - 1] === '--json' || words[index - 1] === '--json-file') {
        return usage(
          `${words[index - 1]} takes JSON text or a path, not a variable (${word}).`,
        );
      }
      // A terminator after the index: `…1` must not be a prefix of `…10`.
      const placeholder = `${nonce}${resolved.size}~`;
      typedAs.set(placeholder, word);
      resolved.set(placeholder, await resolve(ref, lookup));
      prepared.push(placeholder);
    }
  }
  let parsed: ReturnType<typeof parseToolArguments>;
  try {
    parsed = parseToolArguments(prepared);
  } catch (error) {
    // The parser saw placeholders; the person typed references. Say what they typed.
    if (error instanceof ToolRuntimeError && typedAs.size > 0) {
      let message = error.message;
      for (const [placeholder, typed] of typedAs)
        message = message.split(placeholder).join(typed);
      throw new ToolRuntimeError(error.code, message, error.exitCode);
    }
    throw error;
  }
  const swap = (value: unknown): unknown => {
    if (typeof value === 'string')
      return resolved.has(value) ? resolved.get(value) : value;
    // A repeated flag is a list of values; a reference in it that is itself a list contributes its
    // elements, exactly as repeated literals accumulate (`--scope a --scope b` is ['a', 'b']).
    if (Array.isArray(value)) {
      return value.flatMap((item) => {
        const swapped = swap(item);
        return typeof item === 'string' &&
          resolved.has(item) &&
          Array.isArray(swapped)
          ? swapped
          : [swapped];
      });
    }
    return value;
  };
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.input)) {
    // 🔴 A placeholder in a flag NAME position cannot exist: it does not start with `--`, so the parser
    // reads it as a value or refuses it as an unexpected argument.
    Object.defineProperty(input, key, {
      value: swap(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { operation: parsed.operation, input };
}

/** Control and line-separator characters shown as escapes, so data cannot forge output lines or carry terminal escapes. */
export const printable = (text: string): string =>
  text.replace(
    /[\p{Cc}\p{Zl}\p{Zp}]/gu,
    (c) => `\\u{${c.codePointAt(0)?.toString(16)}}`,
  );

/** A short rendering of a variable for `vars`: its type, and its top-level fields. */
export function describeVariable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object')
    return `object{${Object.keys(value).slice(0, 8).map(printable).join(', ')}}`;
  const text = printable(JSON.stringify(value));
  return `${typeof value} ${text.length > 40 ? `${text.slice(0, 37)}...` : text}`;
}
