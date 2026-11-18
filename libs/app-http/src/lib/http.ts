import { HttpException } from '@nestjs/common';

import {
  TOOL_EXIT_CODES,
  type ToolEnvelope,
} from '@devx-micro/app-runtime';

/**
 * The HTTP half of the transport contract: an envelope, as a response or a thrown status.
 *
 * 🔴 **One copy, in a Nest-dependent library of its own**. Duplicating the HTTP
 * rendering across apps is how one transport comes to answer 500 where the CLI answers exit code 2.
 * It is not in `app-runtime`, which stays Nest-free on purpose.
 */

/** The envelope's `exitCode`, as an HTTP status. */
export function statusForExitCode(exitCode: number): number {
  switch (exitCode) {
    case TOOL_EXIT_CODES.usage:
      return 400;
    case TOOL_EXIT_CODES.conflict:
      return 409;
    case TOOL_EXIT_CODES.blocked:
      return 409;
    case TOOL_EXIT_CODES.notFound:
      return 404;
    case TOOL_EXIT_CODES.infrastructure:
      return 503;
    default:
      return 500;
  }
}

/**
 * Unwrap, or throw the failure as an HTTP error.
 *
 * 🔴 An unknown operation is **404**, not 400. A caller that asked for something this app does not
 * have has the wrong URL, and a 400 would read as "your input was malformed" — sending the reader
 * to check their body rather than their route.
 */
export function unwrap(envelope: ToolEnvelope): unknown {
  // 🔴 **A stopped sequence is neither of the other two, and must not fall through to either.**
  // Returning it as success would restate over HTTP the exact defect the third status was added to
  // end; letting it reach the error branch below would throw a 409 whose `code` and `message` are
  // both `undefined`, because an incomplete envelope carries no error body — and would discard
  // `data`, which is the half naming the step it stopped at and everything that ran before it.
  // That payload is how a caller resumes rather than starts again.
  if (envelope.status === 'incomplete') {
    throw new HttpException(
      {
        statusCode: statusForExitCode(envelope.exitCode),
        operation: envelope.operation,
        code: 'INCOMPLETE',
        message:
          'The sequence stopped before completing. `data` names the step it stopped at and the ' +
          'steps that ran; re-running the operation resumes from there.',
        data: envelope.data ?? {},
      },
      statusForExitCode(envelope.exitCode),
    );
  }
  if (envelope.status === 'success') {
    // `data` is genuinely absent for a command, and `undefined` would serialise to an empty body.
    // `{}` says "it worked and there is nothing to read", which is what the exit code says on the
    // CLI.
    return envelope.data ?? {};
  }
  const status =
    envelope.error?.code === 'UNKNOWN_OPERATION'
      ? 404
      : statusForExitCode(envelope.exitCode);
  throw new HttpException(
    {
      statusCode: status,
      operation: envelope.operation,
      code: envelope.error?.code,
      message: envelope.error?.message,
      ...(envelope.error?.details ? { details: envelope.error.details } : {}),
    },
    status,
  );
}
