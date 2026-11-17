/**
 * The REPL's session variables (ADR-066 D7).
 *
 * 🔴 **A port declared here and implemented elsewhere.** This library is `scope:shared` and cannot
 * import the Whiteboard; the Whiteboard (`libs/platform/whiteboard/application`) implements it over
 * its own commands, and a composition root binds it into the runtime. A runtime with none bound
 * still runs every operation: only the variable commands are unavailable, and they say so.
 */
export interface SessionBoardPort {
  /** Stores `value` (any JSON value) as the variable `name`, replacing an earlier one. */
  set(sessionId: string, name: string, value: unknown): Promise<void>;
  /** `found: false` for a variable that is not set; `value` is the JSON value that was stored. */
  get(sessionId: string, name: string): Promise<{ readonly found: boolean; readonly value?: unknown }>;
  /** The names of every variable, sorted. */
  names(sessionId: string): Promise<readonly string[]>;
  /** Removes a variable; `false` if it was not set. */
  unset(sessionId: string, name: string): Promise<boolean>;
  /** Copies the entries of the named board `board:<name>` into this session as variables. */
  attach(sessionId: string, board: string): Promise<{ readonly attached: number; readonly skipped: number }>;
  /** Saves this session's variables as the named board `board:<name>`; never overwrites one. */
  save(sessionId: string, name: string): Promise<void>;
  /** Ends the session: its board is discarded (a saved copy is unaffected). */
  end(sessionId: string): Promise<void>;
}

/** What a variable name may be: a leading letter or `_`, then letters, digits, `_` and `-`. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
