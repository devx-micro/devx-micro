import { describe, expect, it } from 'vitest';

import { CqrsToolRuntime } from './cqrs-tool-runtime';
import type {
  OperationInputSchema,
  ToolOperationDescriptor,
} from './contracts';

/**
 * ADR-064 D7: `ToolOperationDescriptor` gains an OPTIONAL `inputSchema` — a plain structural type, so
 * this `scope:shared` library imports nothing from `agents-application`. Compile-time claims here are
 * checked by `tsc -p tsconfig.spec.json`; the runtime claims by vitest.
 */
describe('ToolOperationDescriptor.inputSchema', () => {
  const schema: OperationInputSchema = {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 },
      tags: { type: 'array', items: { type: 'string' } },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
      state: { type: 'string', enum: ['open', 'resolved'] },
    },
    required: ['id'],
  };

  it('is optional: a descriptor with none still type-checks, so no existing operation changes', () => {
    const plain: ToolOperationDescriptor = {
      name: 'x.y',
      summary: 's',
      kind: 'query',
      createRequest: () => ({}),
    };
    expect(plain.inputSchema).toBeUndefined();
  });

  it('is assignable to a Record<string, unknown>, which is how the consumer types a schema', () => {
    const asRecord: Readonly<Record<string, unknown>> = schema;
    expect(asRecord['type']).toBe('object');
  });

  it('is carried untouched by the descriptor', () => {
    const d: ToolOperationDescriptor = {
      name: 'x.y',
      summary: 's',
      kind: 'query',
      createRequest: () => ({}),
      inputSchema: schema,
    };
    expect(d.inputSchema).toBe(schema);
  });

  it('does not change dispatch or the help listing: the runtime never reads it', async () => {
    const seen: unknown[] = [];
    const descriptor: ToolOperationDescriptor = {
      name: 'x.y',
      summary: 's',
      kind: 'query',
      inputSchema: schema,
      createRequest: (input) => ({ ...input }),
    };
    const runtime = new CqrsToolRuntime({
      commandBus: { execute: async () => 'command' },
      queryBus: { execute: async (request) => (seen.push(request), 'ok') },
      operations: [descriptor],
    });
    const envelope = await runtime.dispatch('x.y', { id: 'a', extra: 1 });
    // An input the SCHEMA would refuse (`extra`) still reaches the bus: schema enforcement belongs to
    // the tool executor, not to the CLI/HTTP runtime, whose behaviour must stay byte-identical.
    expect(envelope.status).toBe('success');
    expect(seen).toEqual([{ id: 'a', extra: 1 }]);
    expect(runtime.listOperations()).toEqual([
      { kind: 'query', name: 'x.y', summary: 's' },
    ]);
  });
});
