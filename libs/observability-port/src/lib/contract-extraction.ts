/**
 * Contract extraction. Pure: step text in, role/goal/requirements/assumptions out.
 *
 * 🔴 **It follows the heading conventions of the step-file format it reads** (`goal`, `requirements`,
 * `assumptions` sections), which are defined by the consuming repository. This library cannot import its
 * consumer, so the conventions are restated here and can drift from the source format.
 *
 * What counts as a requirement (in the order the facet tests them):
 *  - each bullet (or, with no bullets, each paragraph) under a `##+ Requirements|Acceptance|Non-negotiables|Rules|
 *    Output Integrity Rules|Do not skip|Core Principles|Constraints` heading;
 *  - each paragraph that opens with the house callout `🔴 **` or `⚠️ **`, which is how 178 of 180 steps state one.
 * Code (fenced or indented) is an example, not a claim, and is ignored; what is code is decided by the CommonMark
 * parser `mdast-util-from-markdown` (four hand-written fence scanners each diverged from CommonMark and were retired), run
 * only on a document within MAX_PARSE_CHARS and MAX_CONTAINER_DEPTH, since the parser is not linear on every input; any
 * other document is reported unparseable (`incompleteReason`) rather than guessed at. Every pattern here has bounded
 * quantifiers, a heading is recognised by its leading `#`s whatever its length (only the work is bounded, never the
 * recognition), and the scan is line by line with duplicates tracked in a Set, so work is linear in the input size.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';

import { wellFormed } from './canonical-json';
import type { ContentId } from './content-id';
import { requirementId } from './requirement';

/** A requirement read out of step text. */
export interface ExtractedRequirement {
  /** The identity of the claim; see `requirementId()`. */
  readonly requirementId: ContentId;
  /** The requirement text with its list marker or callout stripped. */
  readonly text: string;
}

/** What {@link extractContract} reads from step text. */
export interface ExtractedContract {
  /** The role passed in `options.role`, if any. */
  readonly role?: string;
  /** The goal the step states, if any. */
  readonly goal?: string;
  /** In order of first appearance, with a repeated `requirementId` kept once. */
  readonly requirements: readonly ExtractedRequirement[];
  /** Assumptions the step declares. */
  readonly assumptions: readonly {
    /** The assumption as written. */
    readonly text: string;
    /** Always `declared`: extraction cannot know a model's own assumptions. */
    readonly origin: 'declared';
  }[];
  /** The `requirementId`s that appeared more than once. */
  readonly duplicates: readonly ContentId[];
  /** false for a step with no requirements, and for a duplicate. */
  readonly contractComplete: boolean;
  /** Present only when the document was not parsed at all (too large, too deeply nested, or the parser threw). */
  readonly incompleteReason?: string;
}

/** The most requirements read from one document; the rest are dropped. */
export const MAX_REQUIREMENTS = 200;
/** The longest a single requirement may be, in characters; longer text is cut. */
export const MAX_ITEM_CHARS = 4000;
const MAX_ASSUMPTIONS = 50;
const MAX_LINE_CHARS = 20_000;

// Mirrors of the FACETS patterns, with the quantifiers bounded.
const HEADING = /^(#{1,6})/;
const REQUIREMENTS_HEADING =
  /^#{2,6}[ \t]{0,10}(?:Requirements|Acceptance|Non-negotiables|Rules|Output Integrity Rules|Do not skip|Core Principles|Constraints)\b/i;
const GOAL_HEADING =
  /^#{2,6}[ \t]{0,10}(?:Goal|Mission|Purpose|Objective|Summary|Role and Identity|What this)\b/i;
const GOAL_LINE = /^(?:Goal|Mission|Purpose):[ \t]{0,10}(\S.{0,2000})$/i;
const STEP_TITLE =
  /^#[ \t]{1,10}`[^`\n]{1,200}`[ \t]{1,10}—[ \t]{1,10}(\S.{0,2000})$/;
const ASSUMPTIONS_HEADING = /^#{2,6}[ \t]{0,10}Assumptions\b/i;
const CALLOUT = /^[ \t]{0,6}(?:🔴|⚠️)[ \t]{0,6}\*\*/;
/** A thematic break: three or more of one of `-` `*` `_`, only spaces and tabs between. It separates; it is never an item. */
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^[ \t]{0,6}(?:[-*]|\d{1,3}[.)])[ \t]{1,6}(\S.{0,20000})$/;

/**
 * 🔴 **Largest document handed to the parser, in characters.** `micromark` is not linear on every input: a 64 KiB run of
 * bullets took about a second and a 64 KiB line of `> - ` over fifty. The biggest real step is about 6 KB, so 8 KiB leaves
 * nearly three times the headroom; above it the document is reported unparseable (`incompleteReason`), never guessed at.
 */
export const MAX_PARSE_CHARS = 8 * 1024;
/** Block-quote and list-marker prefixes allowed on one line; `> ` repeated thousands of times is quadratic in the parser. */
const MAX_CONTAINER_DEPTH = 32;

/** How many container markers (`>`, `-`, `*`, `+`, `1.`, `1)`) open one line, counted in a single pass over its prefix. */
function containerDepth(line: string): number {
  let depth = 0;
  let i = 0;
  const n = line.length;
  // A thematic break (`* * *`, `- - -`: three or more of one of - * _, spaces and tabs between) opens no container. Its
  // run is the line's trailing run of one marker character, found once from the end so the scan stays linear.
  let end = n;
  while (
    end > 0 &&
    (line.charAt(end - 1) === ' ' || line.charAt(end - 1) === '\t')
  )
    end -= 1;
  const rule = end > 0 ? line.charAt(end - 1) : '';
  let ruleStart = n;
  let ruleCount = 0;
  if (rule === '-' || rule === '*' || rule === '_') {
    for (let k = end - 1; k >= 0; k -= 1) {
      const ch = line.charAt(k);
      if (ch === rule) {
        ruleStart = k;
        ruleCount += 1;
      } else if (ch !== ' ' && ch !== '\t') break;
    }
  }
  while (i < n) {
    const c = line.charAt(i);
    if (c === ' ' || c === '\t') i += 1;
    else if (c === '>') {
      depth += 1;
      i += 1;
    } else if (c === rule && i >= ruleStart && ruleCount >= 3) {
      return depth; // the rest of the line is a thematic break
    } else if (
      (c === '-' || c === '*' || c === '+') &&
      (i + 1 >= n || line.charAt(i + 1) === ' ' || line.charAt(i + 1) === '\t')
    ) {
      depth += 1;
      i += 1;
    } else if (c >= '0' && c <= '9') {
      let j = i;
      while (
        j < n &&
        j - i < 10 &&
        line.charAt(j) >= '0' &&
        line.charAt(j) <= '9'
      )
        j += 1;
      const d = line.charAt(j);
      if (
        (d !== '.' && d !== ')') ||
        (j + 1 < n && line.charAt(j + 1) !== ' ' && line.charAt(j + 1) !== '\t')
      )
        break;
      depth += 1;
      i = j + 1;
    } else break;
    if (depth > MAX_CONTAINER_DEPTH) return depth;
  }
  return depth;
}

/** Why a document is not handed to the parser, or `undefined` when it is safe to. */
function unparseableReason(
  text: string,
  lines: readonly string[],
): string | undefined {
  if (text.length > MAX_PARSE_CHARS)
    return `document too large to parse (more than ${MAX_PARSE_CHARS} characters)`;
  for (const line of lines)
    if (containerDepth(line) > MAX_CONTAINER_DEPTH)
      return `document nested too deeply to parse (more than ${MAX_CONTAINER_DEPTH} block-quote or list markers on a line)`;
  return undefined;
}

/**
 * 🔴 **Only block structure is read, never inline syntax**, and micromark's inline resolution is quadratic (`*_` repeated to
 * 32 KiB took 19 s). These micromark constructs are every inline one; disabling them leaves paragraphs as plain text and
 * the block constructs (fences, indented code, containers, headings, definitions, html blocks) untouched. A name that
 * micromark does not know is silently ignored, so a spec measures the hostile inputs rather than trusting this list.
 */
const BLOCK_ONLY = {
  disable: {
    null: [
      'attention',
      'autolink',
      'characterEscape',
      'characterReference',
      'codeText',
      'hardBreakEscape',
      'htmlText',
      'labelEnd',
      'labelStartImage',
      'labelStartLink',
    ],
  },
};

type MdNode = {
  readonly type: string;
  readonly position?: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  };
  readonly children?: readonly MdNode[];
};

/**
 * Lines with every code block (fenced AND indented) blanked to an empty line, so positions are stable. What is a code block
 * is decided by `mdast-util-from-markdown`, the CommonMark parser, not by a scanner of ours. `undefined` means the document
 * is unparseable (see `unparseableReason`); `reason` receives why. Never throws.
 * @internal exported for the oracle-agreement spec.
 */
export function blankCodeBlocks(
  text: string,
  reason?: (why: string) => void,
): string[] | undefined {
  const lines = text
    .split(/\r\n?|\n/)
    .map((raw) =>
      raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw,
    );
  const why = unparseableReason(text, lines);
  if (why !== undefined) {
    reason?.(why);
    return undefined;
  }
  try {
    const tree = fromMarkdown(lines.join('\n'), {
      extensions: [BLOCK_ONLY],
    }) as unknown as MdNode;
    const stack: MdNode[] = [tree]; // iterative: a deeply nested tree must not cost stack depth
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      if (node.type === 'code' && node.position) {
        const to = Math.min(node.position.end.line, lines.length);
        for (
          let line = Math.max(node.position.start.line, 1);
          line <= to;
          line += 1
        )
          lines[line - 1] = '';
      } else if (node.children) {
        for (const child of node.children) stack.push(child);
      }
    }
    return lines;
  } catch (error) {
    reason?.(
      `document could not be parsed (${error instanceof Error ? error.constructor.name : 'error'})`,
    );
    return undefined;
  }
}

const levelOf = (line: string): number =>
  (HEADING.exec(line)?.[1] ?? '').length;
const isBlank = (line: string): boolean => line.trim() === '';

/** The half-open range of lines after `start` up to the next heading of the same or a higher level. */
function sectionEnd(lines: readonly string[], start: number): number {
  const level = levelOf(lines[start] ?? '');
  for (let i = start + 1; i < lines.length; i += 1) {
    const found = levelOf(lines[i] ?? '');
    if (found > 0 && found <= level) return i;
  }
  return lines.length;
}

const clean = (text: string): string =>
  Array.from(wellFormed(text.trim())).slice(0, MAX_ITEM_CHARS).join('');

/** Items of a section: bullets with their indented continuation lines, else blank-separated paragraphs. Reports consumed line indexes. */
function sectionItems(
  lines: readonly string[],
  from: number,
  to: number,
  consumed: Set<number>,
): string[] {
  const bullets: string[] = [];
  const paragraphs: string[] = [];
  let bullet: string[] | undefined;
  let paragraph: string[] | undefined;
  const closeBullet = (): void => {
    if (bullet) bullets.push(bullet.join('\n'));
    bullet = undefined;
  };
  const closeParagraph = (): void => {
    if (paragraph) paragraphs.push(paragraph.join('\n'));
    paragraph = undefined;
  };
  for (let i = from; i < to; i += 1) {
    const line = lines[i] ?? '';
    if (isBlank(line) || THEMATIC_BREAK.test(line)) {
      closeBullet();
      closeParagraph();
      continue;
    }
    if (HEADING.test(line)) {
      closeBullet();
      closeParagraph();
      continue;
    }
    const match = BULLET.exec(line);
    if (match) {
      closeBullet();
      closeParagraph();
      bullet = [(match[1] ?? '').trim()];
      consumed.add(i);
    } else if (bullet && /^[ \t]/.test(line)) {
      bullet.push(line.trim());
      consumed.add(i);
    } else {
      closeBullet();
      paragraph = [...(paragraph ?? []), line.trim()];
      consumed.add(i);
    }
  }
  closeBullet();
  closeParagraph();
  // A callout paragraph is a claim in its own right; only bullets mean "the section is a list".
  return bullets.length > 0 ? bullets : paragraphs;
}

function firstParagraph(
  lines: readonly string[],
  from: number,
  to: number,
): string | undefined {
  const collected: string[] = [];
  for (let i = from; i < to; i += 1) {
    const line = lines[i] ?? '';
    if (isBlank(line)) {
      if (collected.length > 0) break;
      continue;
    }
    if (HEADING.test(line)) break;
    collected.push(line.trim());
  }
  return collected.length > 0 ? clean(collected.join('\n')) : undefined;
}

/**
 * Reads role, goal, requirements and assumptions out of step text. Pure and never throws: a
 * document that cannot be parsed yields an incomplete contract with an `incompleteReason`.
 *
 * @param text - The step's Markdown.
 * @param options - `role` is passed through to the result.
 */
export function extractContract(
  text: string,
  options: { readonly role?: string } = {},
): ExtractedContract {
  let reason: string | undefined;
  const lines = blankCodeBlocks(text, (why) => (reason = why));
  const role = options.role !== undefined ? { role: options.role } : {};
  // Unparseable is not "no requirements found": it says so, and the contract is incomplete. Never a throw.
  if (lines === undefined)
    return {
      ...role,
      requirements: [],
      assumptions: [],
      duplicates: [],
      contractComplete: false,
      incompleteReason: reason ?? 'document could not be parsed',
    };
  return extractFromLines(lines, options);
}

/** The extraction proper, over lines whose code blocks are already blanked. @internal exported so a spec can drive it past the parse cap. */
export function extractFromLines(
  lines: readonly string[],
  options: { readonly role?: string } = {},
): ExtractedContract {
  const consumed = new Set<number>();
  const raw: string[] = [];
  const assumptions: { text: string; origin: 'declared' }[] = [];
  let headingGoal: string | undefined;
  let lineGoal: string | undefined;
  let titleGoal: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (REQUIREMENTS_HEADING.test(line)) {
      for (const item of sectionItems(
        lines,
        i + 1,
        sectionEnd(lines, i),
        consumed,
      ))
        raw.push(item); // not push(...spread): a huge section overflows the stack
    } else if (ASSUMPTIONS_HEADING.test(line)) {
      for (const item of sectionItems(
        lines,
        i + 1,
        sectionEnd(lines, i),
        new Set(),
      )) {
        if (assumptions.length < MAX_ASSUMPTIONS && clean(item) !== '')
          assumptions.push({ text: clean(item), origin: 'declared' });
      }
    } else if (GOAL_HEADING.test(line)) {
      headingGoal ??= firstParagraph(lines, i + 1, sectionEnd(lines, i));
    } else {
      const goalLine = GOAL_LINE.exec(line);
      if (goalLine) lineGoal ??= clean(goalLine[1] ?? '');
      const title = STEP_TITLE.exec(line);
      if (title) titleGoal ??= clean(title[1] ?? '');
    }
  }
  // Callouts that are not already part of a Requirements section, one paragraph each.
  for (let i = 0; i < lines.length; i += 1) {
    if (consumed.has(i) || !CALLOUT.test(lines[i] ?? '')) continue;
    const paragraph: string[] = [];
    let j = i;
    while (
      j < lines.length &&
      !isBlank(lines[j] ?? '') &&
      !HEADING.test(lines[j] ?? '')
    ) {
      paragraph.push((lines[j] ?? '').trim());
      consumed.add(j);
      j += 1;
    }
    raw.push(paragraph.join('\n'));
    i = j;
  }

  const seen = new Set<string>();
  const duplicates: ContentId[] = [];
  const duplicated = new Set<string>();
  const requirements: ExtractedRequirement[] = [];
  for (const item of raw) {
    const body = clean(item);
    if (body === '') continue;
    const id = requirementId(body);
    if (seen.has(id)) {
      if (!duplicated.has(id)) {
        duplicated.add(id);
        duplicates.push(id);
      }
      continue;
    }
    seen.add(id);
    if (requirements.length < MAX_REQUIREMENTS)
      requirements.push({ requirementId: id, text: body });
  }
  const goal = headingGoal ?? lineGoal ?? titleGoal;
  return {
    ...(options.role !== undefined ? { role: options.role } : {}),
    ...(goal !== undefined && goal !== '' ? { goal } : {}),
    requirements,
    assumptions,
    duplicates,
    contractComplete: requirements.length > 0 && duplicates.length === 0,
  };
}
