import {
  contentIdOfBytes,
  contentIdOfRecord,
  contentIdOfText,
  isContentId,
  parseContentId,
  verifyContentId,
} from './content-id';

describe('content ids (ADR-072 D3)', () => {
  it('hashes the RFC 8785 canonical JSON: an independently computed golden vector', () => {
    const rfc = {
      numbers: [333333333.3333333, 1e30, 4.5, 2e-3, 1e-27],
      string: '€$\u000F\u000aA\'B"\\\\"/',
      literals: [null, true, false],
    };
    expect(contentIdOfRecord(rfc)).toBe('1-2d5e01a318d0f0879ab568c4be289c8b');
    expect(contentIdOfRecord({ a: 1 })).toBe(
      '1-015abd7f5cc57a2dd94b7590f04ad808',
    );
  });

  it('hashes text over its exact UTF-8 bytes, with no JSON quoting and no normalisation', () => {
    expect(contentIdOfText('hello')).toBe('1-2cf24dba5fb0a30e26e83b2ac5b9e29e');
    expect(contentIdOfText('a b\nc')).toBe(
      '1-24b366cf6891c1a7ba83804c7632b71c',
    );
    expect(contentIdOfText('a \nb')).not.toBe(contentIdOfText('a\nb'));
    expect(contentIdOfText('x\r\ny')).not.toBe(contentIdOfText('x\ny'));
    expect(contentIdOfBytes(new TextEncoder().encode('hello'))).toBe(
      contentIdOfText('hello'),
    );
  });

  it('carries generation 1 and a 32 hex digest, and parses back', () => {
    const id = contentIdOfText('x');
    expect(isContentId(id)).toBe(true);
    expect(parseContentId(id)).toEqual({ generation: 1, digest: id.slice(2) });
    expect(id).toMatch(/^1-[0-9a-f]{32}$/);
  });

  it('rejects any other generation, uppercase, a short digest and a non-string', () => {
    for (const bad of [
      '2-' + 'a'.repeat(32),
      '0-' + 'a'.repeat(32),
      '1-' + 'A'.repeat(32),
      '1-' + 'a'.repeat(31),
      '1-' + 'a'.repeat(33),
      '1' + 'a'.repeat(32),
      '',
      7,
      undefined,
    ]) {
      expect(isContentId(bad)).toBe(false);
    }
    expect(() => parseContentId('2-' + 'a'.repeat(32))).toThrow(/generation/);
  });

  it('verifies an id against the recomputed one and names which side failed', () => {
    const id = contentIdOfRecord({ a: 1 });
    expect(verifyContentId(id, contentIdOfRecord({ a: 1 }))).toEqual({
      ok: true,
    });
    expect(verifyContentId(id, contentIdOfRecord({ a: 2 }))).toEqual({
      ok: false,
      reason: 'digest-mismatch',
    });
    expect(verifyContentId('2-' + 'a'.repeat(32), id)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
