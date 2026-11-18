import type { ObservationKind } from '@devx-micro/observability-port';

/** The `schemaVersion` carried by every {@link ToolEnvelope}. */
export const TOOL_ENVELOPE_VERSION = '1.0.0' as const;

/** `command` goes to the command bus, `query` to the query bus. */
export type ToolOperationKind = 'command' | 'query';

/** Satisfied by NestJS's real `CommandBus`/`QueryBus` as well as any test double. */
export interface ToolBus {
  /** Runs a command or query object and resolves to the handler's result. */
  execute(request: unknown): Promise<unknown>;
}

/**
 * A JSON Schema node in the subset allowed — declared structurally HERE because this
 * library is shared and must not import the agent layer, which owns the validator.
 * The consumer, not this type, is the gate: it should prove its tool-definition validator accepts
 * every real schema.
 *
 * ⚠️ A `type` alias, not an `interface`: only an alias is assignable to `Record<string, unknown>`,
 * which is how the consumer types a schema.
 */
export type OperationInputSchema = {
  /** The JSON type of the value. A root schema must be `object`. */
  readonly type:
    | 'object'
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'array';
  /** For an `object`: the schema of each named property. */
  readonly properties?: { readonly [name: string]: OperationInputSchema };
  /** For an `object`: the property names that must be present. */
  readonly required?: readonly string[];
  /** The only values allowed. */
  readonly enum?: readonly (string | number)[];
  /** For an `array`: the schema of every element. */
  readonly items?: OperationInputSchema;
  /** For a `string`: the fewest characters allowed. */
  readonly minLength?: number;
  /** For a `string`: the most characters allowed. */
  readonly maxLength?: number;
  /** For a `number` or `integer`: the smallest value allowed. */
  readonly minimum?: number;
  /** For a `number` or `integer`: the largest value allowed. */
  readonly maximum?: number;
};

/**
 * One operation a {@link CqrsToolRuntime} serves, described once and reachable from every transport.
 *
 * @typeParam TInput - The validated input handed to `createRequest`.
 */
export interface ToolOperationDescriptor<TInput = Record<string, unknown>> {
  /** The unique name callers use, e.g. `note.get`. */
  readonly name: string;
  /** One line shown in `help` output. */
  readonly summary: string;
  /** Selects the bus: `command` or `query`. */
  readonly kind: ToolOperationKind;
  /** Builds the command or query object to execute from the validated input. */
  readonly createRequest: (input: TInput) => unknown;
  /**
   * Parses raw caller input into `TInput`, throwing `INVALID_INPUT` (see `invalidInput`) to refuse it.
   * The runtime refuses any input key this hook never read. Without it the input passes through
   * unchecked.
   */
  readonly validate?: (input: Record<string, unknown>) => TInput;
  /**
   * The shape of this operation's input, for exposing it as an agent tool (a first
   * slice of a declarative operation schema).
   *
   * 🔴 **Optional, and the only thing that makes an operation eligible to become a tool.** It is
   * documentation of what `validate` already accepts, not a second validator: `CqrsToolRuntime` never
   * reads it, so CLI/REPL/sidecar/HTTP behaviour is unchanged. Nothing lacking one can be exposed.
   */
  readonly inputSchema?: OperationInputSchema;
  /**
   * The `kind` this operation is observed as. Absent means `operation`. An operation that is really a
   * workflow step can set `workflow-step`: it is still a CQRS operation, but a more specific kind replaces the runtime seam's
   * `operation` event rather than adding a second one.
   */
  readonly observationKind?: ObservationKind;
  /**
   * The handler writes this operation's one completion record itself (the harness operation: a
   * more specific `inference-run` record, which D4a says replaces the runtime seam's `operation` event and never
   * adds a second one). The runtime then records nothing for a call that succeeded. A call that was refused or that
   * failed still gets the runtime's failure record, because then no completion was written.
   */
  readonly recordsItself?: true;
}

/** The failure half of an envelope. Branch on `code`; `message` is for humans. */
export interface ToolErrorBody {
  /** A stable, machine-readable code such as `INVALID_INPUT` or `UNKNOWN_OPERATION`. */
  readonly code: string;
  /** A human-readable explanation. Do not branch on it. */
  readonly message: string;
  /** Optional structured context for the failure. */
  readonly details?: unknown;
}

/**
 * The one result shape every transport renders: what {@link CqrsToolRuntime.dispatch} resolves to.
 *
 * @typeParam T - The type of `data`.
 */
export interface ToolEnvelope<T = unknown> {
  /** Always {@link TOOL_ENVELOPE_VERSION}. */
  readonly schemaVersion: typeof TOOL_ENVELOPE_VERSION;
  /** Groups the envelopes of one request or session; echoed from the caller or generated. */
  readonly correlationId: string;
  /** The operation name as requested (also for an unknown one). */
  readonly operation: string;
  /** `system` for help and transport-level errors that belong to no operation. */
  readonly kind: ToolOperationKind | 'system';
  /**
   * 🔴 **Three values, because there are three outcomes.**
   *
   * `success` and `error` alone made a resumable sequence that stopped part-way indistinguishable
   * from one that finished: the runtime derived `success` from *"the handler did not throw"*, and a
   * refused step returns normally. A nine-step close-out that ran three steps and refused the
   * fourth reported `success` with exit code 0, on two different operations.
   *
   * ⚠️ **`incomplete` is not a softer `error`, and that distinction is the point.** A failure wants
   * diagnosis; a stop wants **resumption**, from the step named in `data`. Collapsing the two would
   * be the same fault in the other direction.
   */
  readonly status: 'success' | 'incomplete' | 'error';
  /** A {@link TOOL_EXIT_CODES} value (or a domain error's own integer). The CLI exits with it. */
  readonly exitCode: number;
  /** The handler's result. Present on `success` and `incomplete`; may be absent for a command. */
  readonly data?: T;
  /** Present only when `status` is `error`. */
  readonly error?: ToolErrorBody;
}

/**
 * What a handler returns when it runs a **resumable sequence** rather than a single action.
 *
 * `complete` is the opt-in: an operation that is not a sequence returns a payload without it and is
 * reported exactly as before. 🔴 **The key is the contract, not a convention** — every
 * resumable sequence already returned it, and the runtime was simply not reading it.
 */
export interface ResumableRun {
  /** `false` when the sequence stopped before finishing; the payload says where, so a caller can resume. */
  readonly complete: boolean;
}

/**
 * Did this payload come back from a sequence that stopped part-way?
 *
 * ⚠️ **Absence is not a stop.** Most operations make no completeness claim, and treating a missing
 * `complete` as `false` would report every query in the repository incomplete — a rule worse than
 * the defect it replaces, which is why `runtime.spec.ts` asserts the untouched case as a negative
 * control alongside the two positive ones.
 */
export function isIncompleteRun(data: unknown): data is ResumableRun {
  return (
    typeof data === 'object' &&
    data !== null &&
    'complete' in data &&
    (data as ResumableRun).complete === false
  );
}

/** Where the CLI transport writes: injectable so it can be tested without a process. */
export interface ToolIo {
  /** Writes one line to standard output. */
  readonly stdout: (line: string) => void;
  /** Writes one line to standard error. */
  readonly stderr: (line: string) => void;
}

/**
 * The exit codes an envelope can carry. `usage` means the caller's input was wrong, `blocked` means
 * a resumable sequence stopped part-way, and `infrastructure` means a backing service is unavailable.
 * The HTTP transport maps each to a status.
 */
export const TOOL_EXIT_CODES = {
  /** The operation completed. */
  success: 0,
  /** An unclassified handler failure. */
  failure: 1,
  /** The caller's input was wrong. */
  usage: 2,
  /** The request conflicts with current state. */
  conflict: 3,
  /** A resumable sequence stopped part-way, or a step was refused. */
  blocked: 4,
  /** The thing asked for does not exist. */
  notFound: 5,
  /** A backing store or service is unavailable. */
  infrastructure: 10,
} as const;

/**
 * Throw this from a `validate` hook or handler to choose the envelope's error `code` and `exitCode`.
 * Any other thrown error becomes `HANDLER_FAILURE` at exit 1, unless it carries its own string `code`.
 */
export class ToolRuntimeError extends Error {
  public constructor(
    /** A stable, machine-readable code, carried into the envelope's `error.code`. */
    public readonly code: string,
    message: string,
    /** The exit code the envelope reports; `1` unless given. */
    public readonly exitCode: number = TOOL_EXIT_CODES.failure,
    /** Optional structured context, carried into `error.details`. */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ToolRuntimeError';
  }
}
