import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  CqrsToolRuntime,
  type ToolBus,
  type ToolOperationDescriptor,
} from '@devx-micro/app-runtime';

import { runJsonLinesDriver } from './driver';

class RecordingBus implements ToolBus {
  public readonly received: unknown[] = [];
  constructor(private readonly handler: (request: unknown) => unknown) {}
  async execute(request: unknown): Promise<unknown> {
    this.received.push(request);
    return this.handler(request);
  }
}

function createCapturingWritable(): { output: Writable; text: () => string } {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { output, text: () => chunks.join('') };
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

describe('runJsonLinesDriver (sidecar)', () => {
  it('drives the sidecar JSON-lines transport, including an invalid line', async () => {
    const { runtime } = createRuntime();
    const input = Readable.from([
      '{"operation":"remember","input":{"value":"sidecar"}}\n',
      'not-json\n',
      '{"operation":"recall"}\n',
    ]);
    const { output, text } = createCapturingWritable();
    await runJsonLinesDriver(runtime, input, output);
    const lines = text()
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    expect(lines[0].status).toBe('success');
    expect(lines[1].error.code).toBe('INVALID_JSON_LINE');
    expect(lines[2].data).toBe('sidecar');
  });
});
