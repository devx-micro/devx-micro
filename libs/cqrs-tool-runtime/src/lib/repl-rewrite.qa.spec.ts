import { describe, expect, it } from 'vitest';

import { bindOperationLine } from './repl-language';

/** QA probe (Whiteboard Phase 02 re-pass): placeholders are `<nonce><index>`, so index 1 is a prefix of index 10. */
describe('QA: parse-error rewriting of placeholders', () => {
  it('QR-1 the message names the reference the person typed, even with 11+ references on the line', async () => {
    const vars: Record<string, unknown> = {};
    for (let i = 0; i < 11; i += 1) vars[`v${i}`] = `x${i}`;
    const lookup = async (n: string) =>
      n in vars ? { found: true, value: vars[n] } : { found: false };
    // The 11th reference (placeholder index 10) is the stray argument, and the person typed `$v1`.
    const line = `demo.list ${Array.from({ length: 10 }, (_, i) => `--k${i} $v${i}`).join(' ')} $v1`;
    const message = await bindOperationLine(line, lookup).then(
      () => '',
      (e: Error) => e.message,
    );
    expect(message).toBe("Unexpected argument '$v1'");
  });
});
