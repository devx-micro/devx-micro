import type { ObservationKind } from '@devx-micro/observability-port';

export const TOOL_ENVELOPE_VERSION = '1.0.0' as const;

export type ToolOperationKind = 'command' | 'query';

/** Satisfied by NestJS's real `CommandBus`/`QueryBus` as well as any test double. */
export interface ToolBus {
  execute(request: unknown): Promise<unknown>;
}

/**
 * A JSON Schema node in the subset ADR-064 D7 allows — declared structurally HERE because this
 * library is `scope:shared` and must not import `agents-application`, which owns the validator
 * (`validateToolInputSchema`). The consumer, not this type, is the gate: a spec in `mvp` proves
 * `validateToolDefinition` accepts every real schema.
 *
 * ⚠️ A `type` alias, not an `interface`: only an alias is assignable to `Record<string, unknown>`,
 * which is how the consumer types a schema.
 */
export type OperationInputSchema = {
  readonly type:
    | 'object'
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'array';
  readonly properties?: { readonly [name: string]: OperationInputSchema };
  readonly required?: readonly string[];
  readonly enum?: readonly (string | number)[];
  readonly items?: OperationInputSchema;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
};

export interface ToolOperationDescriptor<TInput = Record<string, unknown>> {
  readonly name: string;
  readonly summary: string;
  readonly kind: ToolOperationKind;
  readonly createRequest: (input: TInput) => unknown;
  readonly validate?: (input: Record<string, unknown>) => TInput;
  /**
   * The shape of this operation's input, for exposing it as an agent tool (ADR-064 D7 — the first
   * slice of the parking-lot row "Declarative operation schema").
   *
   * 🔴 **Optional, and the only thing that makes an operation eligible to become a tool.** It is
   * documentation of what `validate` already accepts, not a second validator: `CqrsToolRuntime` never
   * reads it, so CLI/REPL/sidecar/HTTP behaviour is unchanged. Nothing lacking one can be exposed.
   */
  readonly inputSchema?: OperationInputSchema;
  /**
   * The ADR-072 `kind` this operation is observed as. Absent means `operation`. The `skill.step.*` verbs set
   * `workflow-step`: they are CQRS operations too, but a more specific kind replaces the runtime seam's
   * `operation` event rather than adding a second one (ADR-072 D4a).
   */
  readonly observationKind?: ObservationKind;
  /**
   * The handler writes this operation's one completion record itself (the ADR-072 D8 harness operation: a
   * more specific `inference-run` record, which D4a says replaces the runtime seam's `operation` event and never
   * adds a second one). The runtime then records nothing for a call that succeeded. A call that was refused or that
   * failed still gets the runtime's failure record, because then no completion was written.
   */
  readonly recordsItself?: true;
}

export interface ToolErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface ToolEnvelope<T = unknown> {
  readonly schemaVersion: typeof TOOL_ENVELOPE_VERSION;
  readonly correlationId: string;
  readonly operation: string;
  readonly kind: ToolOperationKind | 'system';
  /**
   * 🔴 **Three values, because there are three outcomes.**
   *
   * `success` and `error` alone made a resumable sequence that stopped part-way indistinguishable
   * from one that finished: the runtime derived `success` from *"the handler did not throw"*, and a
   * refused step returns normally. A nine-step close-out that ran three steps and refused the
   * fourth reported `success` with exit code 0 — observed on two different operations on
   * 2026-09-08 (`d-20260908-cqrstoolruntime-reports-status-success-for-any`).
   *
   * ⚠️ **`incomplete` is not a softer `error`, and that distinction is the point.** A failure wants
   * diagnosis; a stop wants **resumption**, from the step named in `data`. Collapsing the two would
   * be the same fault in the other direction.
   */
  readonly status: 'success' | 'incomplete' | 'error';
  readonly exitCode: number;
  readonly data?: T;
  readonly error?: ToolErrorBody;
}

/**
 * What a handler returns when it runs a **resumable sequence** rather than a single action.
 *
 * `complete` is the opt-in: an operation that is not a sequence returns a payload without it and is
 * reported exactly as before. 🔴 **The key is the contract, not a convention** — every `scm`
 * close-out already returned it, and the runtime was simply not reading it.
 */
export interface ResumableRun {
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

export interface ToolIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export const TOOL_EXIT_CODES = {
  success: 0,
  failure: 1,
  usage: 2,
  conflict: 3,
  blocked: 4,
  notFound: 5,
  infrastructure: 10,
} as const;

export class ToolRuntimeError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: number = TOOL_EXIT_CODES.failure,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ToolRuntimeError';
  }
}
