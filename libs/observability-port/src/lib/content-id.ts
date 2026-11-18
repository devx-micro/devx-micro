/**
 * Content IDs.
 *
 * `1-<32 hex>`: the first 32 hex characters of SHA-256. The leading `1` is the **format version of
 * the ID scheme**, not a record revision — an event log is append-only, so a record is never
 * revised. The shape matches a `generation-digest` revision string, but the hash input differs (see `canonical-json.ts`).
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

/** `1-` followed by 32 hex characters: the leading SHA-256 digest of some content. Names bytes, not a type. */
export type ContentId = string;

const DIGEST_LENGTH = 32;
const CONTENT_ID = /^1-[0-9a-f]{32}$/;
const ANY_GENERATION = /^(\d+)-([0-9a-f]{32})$/;

/** The content id of raw bytes: `1-` plus the first 32 hex characters of their SHA-256. */
export function contentIdOfBytes(bytes: Uint8Array): ContentId {
  const digest = createHash('sha256')
    .update(bytes)
    .digest('hex')
    .slice(0, DIGEST_LENGTH);
  return `1-${digest}`;
}

/** The content id of the exact UTF-8 bytes of `text`. Throws on text with a lone surrogate. */
export function contentIdOfText(text: string): ContentId {
  assertWellFormedText(text);
  return contentIdOfBytes(new TextEncoder().encode(text));
}

/** The content id of a value's RFC 8785 canonical JSON. Throws on a value with no JSON form. */
export function contentIdOfRecord(value: unknown): ContentId {
  return contentIdOfText(canonicalJson(value));
}

/** True for a string of the form `1-<32 lowercase hex>`. */
export function isContentId(value: unknown): value is ContentId {
  return typeof value === 'string' && CONTENT_ID.test(value);
}

/** Splits a content id into its scheme `generation` and its `digest`. Throws on an unsupported generation or a malformed id. */
export function parseContentId(id: string): {
  /** The ID scheme version; only `1` exists. */
  readonly generation: 1;
  /** The 32 hex characters of the digest. */
  readonly digest: string;
} {
  const match = ANY_GENERATION.exec(id);
  if (!match)
    throw new Error(
      `Malformed content id, expected 1-<32 lowercase hex>: ${id}`,
    );
  if (match[1] !== '1') {
    throw new Error(
      `Unsupported content id generation ${match[1]}: only generation 1 exists`,
    );
  }
  return { generation: 1, digest: match[2] };
}

/**
 * The outcome of {@link verifyContentId}: `ok`, or not ok with a `reason` of `malformed` (not a
 * content id) or `digest-mismatch` (a well-formed id that names different content).
 */
export type ContentIdVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'malformed' | 'digest-mismatch' };

/** Compare a stored id with the id recomputed from the stored content. */
export function verifyContentId(
  stored: string,
  recomputed: string,
): ContentIdVerification {
  if (!isContentId(stored) || !isContentId(recomputed))
    return { ok: false, reason: 'malformed' };
  return stored === recomputed
    ? { ok: true }
    : { ok: false, reason: 'digest-mismatch' };
}
