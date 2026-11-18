import { describe, expect, it } from 'vitest';

import {
  CqrsToolRuntime,
  type ToolBus,
  type ToolOperationDescriptor,
} from '@devx-micro/app-runtime';

import { runOneShot } from './cli';

class RecordingBus implements ToolBus {
  public readonly received: unknown[] = [];
  constructor(private readonly handler: (request: unknown) => unknown) {}
  async execute(request: unknown): Promise<unknown> {
    this.received.push(request);
    return this.handler(request);
  }
}

function createRuntime(store = { value: undefined as unknown }) {
  const rememberOperation: ToolOperationDescriptor = {
    name: 'remember',
    summary: 'Remember a value',
    kind: 'command',
    createRequest: (input) => ({ type: 'remember', value: input['value'] }),
  };
  const recallOperation: ToolOperationDescriptor = {
    name: 'recall',
    summary: 'Recall the remembered value',
    kind: 'query',
    createRequest: () => ({ type: 'recall' }),
  };
  const commandBus = new RecordingBus((request) => {
    const command = request as { type: string; value: unknown };
    store.value = command.value;
    return { stored: true };
  });
  const queryBus = new RecordingBus(() => store.value ?? null);
  return {
    runtime: new CqrsToolRuntime({
      commandBus,
      queryBus,
      operations: [rememberOperation, recallOperation],
    }),
    commandBus,
    queryBus,
    store,
  };
}

describe('runOneShot (CLI)', () => {
  it('runs a stateless one-shot command/query round trip via runOneShot', async () => {
    const { runtime } = createRuntime();
    const stdout: string[] = [];
    const io = {
      stdout: (line: string) => stdout.push(line),
      stderr: () => undefined,
    };
    await runOneShot(runtime, ['remember', '--value', 'stateless'], io);
    const exitCode = await runOneShot(runtime, ['recall'], io);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout[1]).data).toBe('stateless');
  });

  it('prints CLI help and exits successfully for --help', async () => {
    const { runtime } = createRuntime();
    const stdout: string[] = [];
    const exitCode = await runOneShot(runtime, ['--help'], {
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(stdout[0]).toContain('Usage:');
  });
});
