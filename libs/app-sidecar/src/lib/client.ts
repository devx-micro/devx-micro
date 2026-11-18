import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

/**
 * The client side of the JSON-lines sidecar protocol that `runJsonLinesDriver` serves.
 *
 * Deliberately framework-free — it needs only Node, so an editor extension host (or anything
 * else that spawns a sidecar) can construct and test it without its host's APIs.
 *
 * 🔴 **Requests are queued, not fired concurrently.** The server side (`runJsonLinesDriver`) reads one line, fully awaits its dispatch, and only then reads
 * the next — so two requests in flight at once would have their responses arrive in write order,
 * not call order, and a naive concurrent caller could pair a response with the wrong request. This
 * client instead keeps one in-flight request at a time and queues anything asked for while it is
 * still waiting, which is the correct client-side answer to a synchronous-per-line server, not a
 * limitation being worked around.
 *
 * 🔴 **Every way the child process can stop answering is handled explicitly, found by an
 * adversarial QA pass rather than assumed away**: a bad command (`'error'` on the process itself),
 * an unexpected crash or kill (`'exit'` with no corresponding `stop()` call), and `stop()` racing a
 * request already queued to write. All three used to either crash the whole extension host (an
 * unhandled `'error'`/write-after-end event on an `EventEmitter` with no listener throws) or hang a
 * request forever with nothing to reject it. Every pending request is tracked in `pending` so any
 * of these can reject the lot with one clear error instead.
 */
export interface SidecarRequest {
  readonly operation: string;
  readonly input?: Record<string, unknown>;
}

/**
 * `value.slice(-limit)` on its own can cut a UTF-16 surrogate pair in half, leaving a lone low
 * surrogate at the front — not a crash, but invalid text that mangles under any later UTF-8
 * encoding (e.g. the notification surfacing this string). Drop that dangling low surrogate too.
 */
export function boundedTail(value: string, limit: number): string {
  const tail = value.slice(-limit);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

export interface SidecarEnvelope {
  readonly status: 'success' | 'error' | 'incomplete';
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface SidecarClientOptions {
  /** The command that boots the server in `--sidecar` mode — e.g. `node`. */
  readonly command: string;
  /** Arguments preceding nothing else — e.g. `[mainJsPath, '--sidecar']`. */
  readonly args: readonly string[];
}

export class SidecarClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** Every request awaiting a response, so a dead child can reject all of them at once. */
  private readonly pending = new Set<(error: Error) => void>();
  /** Set by `stop()` before it ends stdin, so the `'exit'` handler knows not to treat it as a crash. */
  private stopping = false;
  /** Set once the child is known dead (crashed, killed, or a bad command) — refuses new requests. */
  private died: Error | undefined;
  private stderr = '';

  public constructor(private readonly options: SidecarClientOptions) {}

  /** Spawns the child process. Idempotent — a second call while already started is a no-op. */
  public start(): void {
    if (this.child) return;
    this.died = undefined;
    this.stopping = false;
    this.stderr = '';
    const child = spawn(this.options.command, [...this.options.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderr = boundedTail(`${this.stderr}${chunk}`, 4000);
    });

    // Without this, a bad command (ENOENT, EACCES) throws an uncaught error and takes the whole
    // extension host down — Node's default behaviour for an `'error'` event with no listener.
    child.on('error', (error) => this.fail(error));
    // `child.stdin` is its own `EventEmitter`; writing after `.end()` emits `'error'` there, not on
    // `child` itself, and not as a synchronous throw a `Promise` executor could catch.
    child.stdin.on('error', (error) => this.fail(error));
    // An exit `stop()` did not cause is a crash from this client's point of view, whatever the
    // process's own reason was — nothing else here would ever notice or reject the request left
    // waiting for a response that is never coming.
    child.on('exit', (code, signal) => {
      if (this.stopping) return;
      this.fail(
        new Error(
          `sidecar process exited unexpectedly (code=${code}, signal=${signal})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ''}`,
        ),
      );
    });
  }

  /** Rejects every request currently waiting, and refuses any future one until `start()` again. */
  private fail(error: Error): void {
    this.died = error;
    for (const reject of this.pending) reject(error);
    this.pending.clear();
  }

  public async stop(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    this.stopping = true;
    this.lines?.close();
    this.lines = undefined;
    this.child = undefined;
    // Whatever was mid-write when `stop()` was called is not this client's to finish — reject it
    // rather than let its queued write land on a stream `stop()` is about to end.
    this.fail(new Error('SidecarClient.stop() was called'));
    child.stdin.end();
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      // A server that does not exit promptly on stdin close is a defect in the server, not
      // something this client should hang waiting on indefinitely.
      setTimeout(resolve, 2000);
    });
  }

  /**
   * One request, fully round-tripped, queued behind whatever is already in flight.
   *
   * 🔴 **Reads exactly one line per request.** The server writes exactly one envelope per line for
   * every request it accepts (`runJsonLinesDriver`'s own contract) — reading more would silently
   * consume a later response, and reading fewer is not a shape this protocol produces.
   */
  public async request(request: SidecarRequest): Promise<SidecarEnvelope> {
    if (!this.child || !this.lines) {
      throw new Error('SidecarClient.start() must be called before request()');
    }
    const next = this.queue.then(
      () =>
        new Promise<SidecarEnvelope>((resolve, reject) => {
          // Checked at execution time, not at call time — this request may have been queued
          // behind others when the child was still alive and only died since.
          if (this.died) {
            reject(this.died);
            return;
          }
          const child = this.child;
          const lines = this.lines;
          if (!child || !lines) {
            reject(
              new Error(
                'SidecarClient was stopped before this request could be sent',
              ),
            );
            return;
          }
          const settle = (error: Error) => {
            this.pending.delete(settle);
            lines.off('line', onLine);
            reject(error);
          };
          const onLine = (line: string) => {
            this.pending.delete(settle);
            lines.off('line', onLine);
            try {
              resolve(JSON.parse(line) as SidecarEnvelope);
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          };
          this.pending.add(settle);
          lines.on('line', onLine);
          child.stdin.write(`${JSON.stringify(request)}\n`);
        }),
    );
    // Swallow a rejection in the queue chain itself, so one failed request does not poison every
    // request queued after it — `request`'s own caller still sees the real rejection, via `next`.
    this.queue = next.catch(() => undefined);
    return next;
  }
}
