import { describe, expect, it } from 'vitest';

import { assertInputSchemaAgreesWithValidate } from './operation-input-schema.contract';
import { invalidInput, requiredString, optionalString } from './input';
import type { ToolOperationDescriptor } from './contracts';

const make = (over: Partial<ToolOperationDescriptor>): ToolOperationDescriptor => ({
  name: 'x.get',
  summary: 's',
  kind: 'query',
  createRequest: (i) => i,
  validate: (i) => ({ id: requiredString(i, 'id', 'x.get'), note: optionalString(i, 'note', 'x.get') }),
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, note: { type: 'string' } },
    required: ['id'],
  },
  ...over,
});

const example = { id: 'a', note: 'n' };

describe('assertInputSchemaAgreesWithValidate', () => {
  it('passes when required, optional and vocabulary all match what validate does', () => {
    expect(() => assertInputSchemaAgreesWithValidate(make({}), example)).not.toThrow();
  });

  it('fails when the descriptor has no inputSchema', () => {
    expect(() => assertInputSchemaAgreesWithValidate(make({ inputSchema: undefined }), example)).toThrow(/no inputSchema/);
  });

  it('fails when the schema marks a key required that validate treats as optional', () => {
    const d = make({ inputSchema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'note'] } });
    expect(() => assertInputSchemaAgreesWithValidate(d, example)).toThrow(/'note' is required by the schema but validate accepts its absence/);
  });

  it('fails when validate requires a key the schema leaves optional', () => {
    const d = make({ inputSchema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } } } });
    expect(() => assertInputSchemaAgreesWithValidate(d, example)).toThrow(/'id' is optional in the schema but validate refuses its absence/);
  });

  it('fails when validate reads a key the schema does not declare', () => {
    const d = make({ inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } });
    expect(() => assertInputSchemaAgreesWithValidate(d, example)).toThrow(/validate reads 'note', which the schema does not declare/);
  });

  it('fails when the schema declares a key validate never reads', () => {
    const d = make({ inputSchema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' }, ghost: { type: 'string' } }, required: ['id'] } });
    expect(() => assertInputSchemaAgreesWithValidate(d, { ...example, ghost: 'g' })).toThrow(/schema declares 'ghost', which validate never reads/);
  });

  it('fails when the example omits a declared property, since an unexercised key proves nothing', () => {
    expect(() => assertInputSchemaAgreesWithValidate(make({}), { id: 'a' })).toThrow(/example must supply every declared property/);
  });

  it('fails when validate rejects the valid example', () => {
    const d = make({ validate: () => invalidInput('nope') });
    expect(() => assertInputSchemaAgreesWithValidate(d, example)).toThrow(/rejected the valid example/);
  });
});
