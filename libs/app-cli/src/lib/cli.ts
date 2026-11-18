import {
  TOOL_ENVELOPE_VERSION,
  TOOL_EXIT_CODES,
  parseToolArguments,
  type CqrsToolRuntime,
  type ToolEnvelope,
  type ToolIo,
} from '@devx-micro/app-runtime';

const defaultIo: ToolIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/**
 * The CLI transport: runs one operation from command-line arguments, prints its envelope as JSON
 * and resolves to the exit code the process should use.
 *
 * @param runtime - The runtime to dispatch through.
 * @param arguments_ - The arguments after the program name: `<operation> [--key value] [--json '{…}']`.
 * @param io - Where to write; the process's stdout and stderr by default.
 */
export async function runOneShot(
  runtime: CqrsToolRuntime,
  arguments_: readonly string[],
  io: ToolIo = defaultIo,
): Promise<number> {
  if (arguments_.includes('--help') || arguments_.includes('-h')) {
    io.stdout(runtime.help());
    return TOOL_EXIT_CODES.success;
  }
  if (arguments_[0] === 'help') {
    const envelope = runtime.helpEnvelope(undefined, arguments_[1]);
    io.stdout(JSON.stringify(envelope));
    return envelope.exitCode;
  }
  try {
    const { operation, input } = parseToolArguments(arguments_);
    const envelope = await runtime.dispatch(operation, input);
    io.stdout(JSON.stringify(envelope));
    return envelope.exitCode;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Invalid arguments';
    const envelope: ToolEnvelope = {
      schemaVersion: TOOL_ENVELOPE_VERSION,
      correlationId: 'argument-parsing',
      operation: 'parse',
      kind: 'system',
      status: 'error',
      exitCode: TOOL_EXIT_CODES.usage,
      error: { code: 'INVALID_ARGUMENTS', message },
    };
    io.stdout(JSON.stringify(envelope));
    return envelope.exitCode;
  }
}
