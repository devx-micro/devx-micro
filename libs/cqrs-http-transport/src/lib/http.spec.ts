import { HttpException } from '@nestjs/common';
import {
  TOOL_ENVELOPE_VERSION,
  TOOL_EXIT_CODES,
  type ToolEnvelope,
} from '@devx-micro/cqrs-tool-runtime';

import { statusForExitCode, unwrap } from './http';

/**
 * 🔴 These two functions were app-private copies with no test in either app; promoting them to a
 * shared contract is what makes a test owed. The `incomplete` branch is the one that matters most:
 * it was added to end a defect where a stopped sequence read as success, and nothing asserted it.
 */
const envelope = (over: Partial<ToolEnvelope>): ToolEnvelope => ({
  schemaVersion: TOOL_ENVELOPE_VERSION,
  correlationId: 'c-1',
  operation: 'x.op',
  kind: 'command',
  status: 'success',
  exitCode: TOOL_EXIT_CODES.success,
  ...over,
});

const thrown = (run: () => unknown): HttpException => {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('nothing was thrown');
};

describe('statusForExitCode', () => {
  it.each([
    [TOOL_EXIT_CODES.usage, 400],
    [TOOL_EXIT_CODES.conflict, 409],
    [TOOL_EXIT_CODES.blocked, 409],
    [TOOL_EXIT_CODES.notFound, 404],
    [TOOL_EXIT_CODES.infrastructure, 503],
    [TOOL_EXIT_CODES.failure, 500],
    [99, 500],
  ])('maps exit code %i to %i', (exitCode, status) => {
    expect(statusForExitCode(exitCode)).toBe(status);
  });
});

describe('unwrap', () => {
  it('answers a success with its data alone, and {} for a command with none', () => {
    expect(unwrap(envelope({ data: { rows: [1] } }))).toEqual({ rows: [1] });
    expect(unwrap(envelope({}))).toEqual({});
  });

  it('throws an error envelope as the status its exit code maps to, carrying code, message and details', () => {
    const error = thrown(() =>
      unwrap(
        envelope({
          status: 'error',
          exitCode: TOOL_EXIT_CODES.usage,
          error: {
            code: 'INVALID_INPUT',
            message: 'needs a title',
            details: { missing: ['title'] },
          },
        }),
      ),
    );

    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({
      statusCode: 400,
      operation: 'x.op',
      code: 'INVALID_INPUT',
      message: 'needs a title',
      details: { missing: ['title'] },
    });
  });

  it('answers an unknown operation as 404, whatever its exit code says — the wrong route, not a bad body', () => {
    const error = thrown(() =>
      unwrap(
        envelope({
          status: 'error',
          kind: 'system',
          exitCode: TOOL_EXIT_CODES.usage,
          error: {
            code: 'UNKNOWN_OPERATION',
            message: "Unknown operation 'x.op'",
          },
        }),
      ),
    );

    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).not.toHaveProperty('details');
  });

  // 🔴 Neither success nor error: the payload names the step it stopped at, and a caller resumes
  // from it. Falling into the error branch would throw a 409 with an undefined code and no data.
  it('throws an incomplete sequence as 409 INCOMPLETE with its data, never as success or as a bare error', () => {
    const data = {
      stoppedAt: 'exit-gate',
      steps: [{ step: 'commit', outcome: 'done' }],
    };
    const error = thrown(() =>
      unwrap(
        envelope({
          status: 'incomplete',
          exitCode: TOOL_EXIT_CODES.blocked,
          data,
        }),
      ),
    );

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual({
      statusCode: 409,
      operation: 'x.op',
      code: 'INCOMPLETE',
      message: expect.stringMatching(/stopped before completing/),
      data,
    });
  });
});
