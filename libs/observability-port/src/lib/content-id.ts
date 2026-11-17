/**
 * Content IDs — ADR-072 D3.
 *
 * `1-<32 hex>`: the first 32 hex characters of SHA-256. The leading `1` is the **format version of
 * the ID scheme**, not a record revision — the Domain Event log is append-only, so a record is never
 * revised. The shape is that of `Revision` in `@typedblite/content-revision`, so `generationOf`
 * and `digestOf` parse it, but the hash input differs (see `canonical-json.ts`).
 *
 * Text is hashed over its exact UTF-8 bytes, with no JSON quoting and no normalisation: Markdown
 * whitespace can be significant, and an ID must identify the text a model actually received. The one
 * exception is requirement text — see `requirement.ts`.
 *
 * ⚠️ **An ID names bytes, not a type.** `contentIdOfText('"x"')` and `contentIdOfRecord('x')` are the
 * same ID, because a string record's canonical JSON is the quoted string. A text artifact whose bytes
 * happen to equal some record's canonical JSON therefore shares that record's ID. Callers store the
 * kind beside the ID; the ID alone does not carry it.
 */
import { createHash } from 'node:crypto';

import { assertWellFormedText, canonicalJson } from './canonical-json';

export type ContentId = string;

const DIGEST_LENGTH = 32;
const CONTENT_ID = /^1-[0-9a-f]{32}$/;
const ANY_GENERATION = /^(\d+)-([0-9a-f]{32})$/;

export function contentIdOfBytes(bytes: Uint8Array): ContentId {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, DIGEST_LENGTH);
  return `1-${digest}`;
}

export function contentIdOfText(text: string): ContentId {
  assertWellFormedText(text);
  return contentIdOfBytes(new TextEncoder().encode(text));
}

export function contentIdOfRecord(value: unknown): ContentId {
  return contentIdOfText(canonicalJson(value));
}

export function isContentId(value: unknown): value is ContentId {
  return typeof value === 'string' && CONTENT_ID.test(value);
}

export function parseContentId(id: string): { readonly generation: 1; readonly digest: string } {
  const match = ANY_GENERATION.exec(id);
  if (!match) throw new Error(`Malformed content id, expected 1-<32 lowercase hex>: ${id}`);
  if (match[1] !== '1') {
    throw new Error(`Unsupported content id generation ${match[1]}: only generation 1 exists (ADR-072 D3)`);
  }
  return { generation: 1, digest: match[2] };
}

export type ContentIdVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'malformed' | 'digest-mismatch' };

/** Compare a stored id with the id recomputed from the stored content. */
export function verifyContentId(stored: string, recomputed: string): ContentIdVerification {
  if (!isContentId(stored) || !isContentId(recomputed)) return { ok: false, reason: 'malformed' };
  return stored === recomputed ? { ok: true } : { ok: false, reason: 'digest-mismatch' };
}
