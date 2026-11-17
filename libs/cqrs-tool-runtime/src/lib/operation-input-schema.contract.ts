import assert from 'node:assert/strict';

import { ToolRuntimeError, type ToolOperationDescriptor } from './contracts';
import { probeInput } from './input';

const refuses = (
  descriptor: ToolOperationDescriptor,
  input: Record<string, unknown>,
): boolean => {
  try {
    descriptor.validate?.(input);
    return false;
  } catch (error) {
    if (error instanceof ToolRuntimeError && error.code === 'INVALID_INPUT')
      return true;
    throw error;
  }
};

/**
 * Proves a descriptor's `inputSchema` agrees with the `validate` hook that actually governs it
 * (ADR-064 D7). Framework-agnostic (`node:assert`), exported like the repository's other
 * `*.contract.ts` suites so each bounded context can run it against its own descriptors without
 * depending on the others.
 *
 * 🔴 **The schema is a second statement of what `validate` already enforces, so it can drift from
 * it silently** — a tool schema that marks a key optional while `validate` refuses its absence
 * hands the model a call that always fails, and the reverse hands it a refusal that is not real.
 * Both directions, and the key vocabulary, are checked here rather than trusted: the vocabulary is
 * what `validate` READ (via `probeInput`, the same definition the runtime's own unknown-key refusal
 * uses), and requiredness is what removing each key from a valid example actually does.
 *
 * `validExample` must supply every declared property, so no key goes unexercised.
 */
export function assertInputSchemaAgreesWithValidate(
  descriptor: ToolOperationDescriptor,
  validExample: Record<string, unknown>,
): void {
  const name = descriptor.name;
  const schema = descriptor.inputSchema;
  assert.ok(schema !== undefined, `${name} has no inputSchema`);
  assert.equal(
    schema.type,
    'object',
    `${name}'s root schema must be an object`,
  );
  assert.ok(
    descriptor.validate !== undefined,
    `${name} has no validate hook to agree with`,
  );

  const declared = Object.keys(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  for (const key of declared) {
    assert.ok(
      key in validExample,
      `${name}: the example must supply every declared property, missing '${key}'`,
    );
  }

  const probe = probeInput(validExample);
  try {
    descriptor.validate(probe.input);
  } catch (error) {
    assert.fail(
      `${name}: validate rejected the valid example: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const read = new Set(probe.readKeys());
  for (const key of read) {
    assert.ok(
      declared.includes(key),
      `${name}: validate reads '${key}', which the schema does not declare`,
    );
  }
  for (const key of declared) {
    assert.ok(
      read.has(key),
      `${name}: the schema declares '${key}', which validate never reads`,
    );
  }

  for (const key of declared) {
    const without = { ...validExample };
    delete without[key];
    const refused = refuses(descriptor, without);
    if (required.has(key)) {
      assert.ok(
        refused,
        `${name}: '${key}' is required by the schema but validate accepts its absence`,
      );
    } else {
      assert.ok(
        !refused,
        `${name}: '${key}' is optional in the schema but validate refuses its absence`,
      );
    }
  }
}
