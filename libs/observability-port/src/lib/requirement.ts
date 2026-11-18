/**
 * Requirement identity.
 *
 * A `requirementId` identifies the claim, not its layout, so requirement text — and only requirement
 * text — is hashed in a normal form: NFC; CRLF and CR to LF; each line stripped of leading and trailing
 * whitespace; runs of spaces and tabs inside a line collapsed to one space; blank lines at the start
 * and end removed. Line breaks are kept: they are structure, so `a\nb` and `a b` stay different.
 *
 * ⚠️ **Only ASCII space and tab collapse inside a line**, as specified, while `trim()` at a
 * line's edges strips any Unicode whitespace. So `a b` and `a\u00a0b` are different claims and a
 * leading or trailing NBSP is layout. Widening the collapse changes every requirement id, so it is a versioned change, not an edit here.
 */
import { contentIdOfText, type ContentId } from './content-id';

export function normalizeRequirementText(text: string): string {
  const lines = text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]+/g, ' '));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Throws on text with a lone surrogate (no well-formed UTF-8), like every content-id function. A caller
 * deriving ids from untrusted or truncated text validates it first.
 */
export function requirementId(text: string): ContentId {
  return contentIdOfText(normalizeRequirementText(text));
}
