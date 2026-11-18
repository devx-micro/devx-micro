import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import {
  TOOL_ENVELOPE_VERSION,
  TOOL_EXIT_CODES,
  type CqrsToolRuntime,
  type ToolEnvelope,
} from '@devx-micro/app-runtime';

/** One request line of the JSON-lines sidecar protocol. */
export interface DriverRequest {
  /** The operation to run, or `help`. */
  readonly operation: string;
  /** The operation's input; `{}` when omitted. */
  readonly input?: Record<string, unknown>;
  /** Echoed in the response envelope; generated when omitted. */
  readonly correlationId?: string;
}

/** Newline-delimited JSON transport — used by sidecar integrations such as editor extensions. */
export async function runJsonLinesDriver(
  runtime: CqrsToolRuntime,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line) as DriverRequest;
      if (request.operation === 'help') {
        const topic = request.input?.['topic'];
        output.write(
          `${JSON.stringify(
            runtime.helpEnvelope(
              request.correlationId,
              typeof topic === 'string' ? topic : undefined,
            ),
          )}\n`,
        );
        continue;
      }
      const envelope = await runtime.dispatch(
        request.operation,
        request.input ?? {},
        request.correlationId,
      );
      output.write(`${JSON.stringify(envelope)}\n`);
    } catch {
      const envelope: ToolEnvelope = {
        schemaVersion: TOOL_ENVELOPE_VERSION,
        correlationId: 'invalid-json-line',
        operation: 'driver',
        kind: 'system',
        status: 'error',
        exitCode: TOOL_EXIT_CODES.usage,
        error: {
          code: 'INVALID_JSON_LINE',
          message: 'Each input line must be valid JSON',
        },
      };
      output.write(`${JSON.stringify(envelope)}\n`);
    }
  }
}
