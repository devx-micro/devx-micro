import type { Readable, Writable } from 'node:stream';
import { Logger, type INestApplication } from '@nestjs/common';
import { runOneShot } from '@devx-micro/app-cli';
import { runInteractiveRepl } from '@devx-micro/app-repl';
import type { CqrsToolRuntime, ToolIo } from '@devx-micro/app-runtime';
import { runJsonLinesDriver } from '@devx-micro/app-sidecar';

/** A runtime plus the way to release whatever built it (a Nest application context, a store, a socket). */
export interface AppToolHandle {
  readonly runtime: CqrsToolRuntime;
  readonly close: () => Promise<void>;
}

/** What `runApi` knows before it builds the application, for apps that need their own port early. */
export interface AppHttpContext {
  /** `process.env[portEnv] || defaultPort`, resolved before `createApp` runs. May be `'0'` (ephemeral). */
  readonly port: string | number;
}

/** How the application serves HTTP. Omit it and the application has no HTTP mode. */
export interface AppHttpDefinition<Options> {
  /**
   * Builds the Nest application, ready to configure but not yet listening. The application owns this
   * call because only it knows its module and its `NestFactory` options (body parsers, logger, …).
   */
  readonly createApp: (
    options: Options | undefined,
    context: AppHttpContext,
  ) => Promise<INestApplication>;
  /** The environment variable that overrides the port, e.g. `SCHEDULE_PORT`. */
  readonly portEnv: string;
  /** The port used when {@link AppHttpDefinition.portEnv} is unset or empty. */
  readonly defaultPort: number;
  /** The global route prefix. Defaults to `api`. */
  readonly globalPrefix?: string;
  /** Runs after the prefix is set and before `listen`: CORS, extra parsers, background workers. */
  readonly configure?: (
    app: INestApplication,
    options: Options | undefined,
    context: AppHttpContext,
  ) => void | Promise<void>;
  /** The path of the help route, for the "serving on" log line. Defaults to `/<prefix>/<name>/help`. */
  readonly helpPath?: string;
}

/** An extra `--flag` mode beyond the standard ones. */
export interface AppExtraMode<Options> {
  readonly flag: `--${string}`;
  /**
   * Runs the mode with the full `argv`, so it can parse flags of its own. Its failures are handled
   * like the standard long-running modes': an operator error prints its message and exits 1, anything
   * else is rethrown. A mode that needs a different exit code sets `process.exitCode` itself.
   */
  readonly run: (
    options: Options | undefined,
    argv: readonly string[],
  ) => Promise<unknown>;
}

/** What differs between applications; everything else about starting one is {@link defineApp}'s. */
export interface AppDefinition<Options = undefined> {
  /** The name used in messages: `<name>: unknown mode`, `<name> failed`, `<name> is serving on`. */
  readonly name: string;
  readonly createTool: (options?: Options) => Promise<AppToolHandle>;
  readonly http?: AppHttpDefinition<Options>;
  readonly extraModes?: readonly AppExtraMode<Options>[];
  /**
   * An error that is the operator's to fix (a missing workspace, a bad config). It prints its message
   * alone, with no stack, and exits 1. Anything else prints a stack in one-shot mode and is rethrown
   * in the long-running modes.
   */
  readonly isOperatorError?: (error: unknown) => boolean;
}

/** The entry points {@link defineApp} builds. Each opens its own tool and closes it when done. */
export interface App<Options = undefined> {
  /** One operation from `argv`, then exit. Resolves to the exit code. A leading `--cli` is ignored. */
  readonly runCli: (
    argv?: readonly string[],
    options?: Options,
    io?: ToolIo,
  ) => Promise<number>;
  readonly runRepl: (
    input?: Readable,
    output?: Writable,
    options?: Options,
  ) => Promise<void>;
  readonly runSidecar: (
    input?: Readable,
    output?: Writable,
    options?: Options,
  ) => Promise<void>;
  /** Starts the HTTP application and resolves to it. Throws when the definition has no `http`. */
  readonly runApi: (options?: Options) => Promise<INestApplication>;
  /**
   * The process entry point: picks a mode from `argv` and sets `process.exitCode`. It never calls
   * `process.exit`, so the event loop drains and a running server keeps the process alive.
   *
   * | `argv` | mode |
   * | --- | --- |
   * | an unrecognised flag first (`--x` or `-x`) | refused by name, exit 2 |
   * | contains `--repl` | REPL |
   * | contains `--sidecar` | JSON-lines sidecar |
   * | contains an extra mode's flag | that mode |
   * | empty | HTTP API (or the help text when there is none) |
   * | anything else | one-shot CLI |
   */
  readonly main: (argv?: readonly string[], options?: Options) => Promise<void>;
}

const STANDARD_FLAGS = [
  '--repl',
  '--sidecar',
  '--cli',
  '--help',
  '-h',
] as const;

const withoutCliFlag = (argv: readonly string[]): readonly string[] =>
  argv.filter((argument) => argument !== '--cli');

/**
 * Runs a cleanup whose failure must not replace the error being reported. A `close` written as a plain
 * function can throw synchronously or return nothing, so the call itself is inside the `try`, not
 * just the promise it should return.
 */
const quietly = async (cleanup: () => unknown): Promise<void> => {
  try {
    await cleanup();
  } catch {
    // the caller is already reporting a more important failure
  }
};

/** An operator's error, or anything thrown, as the text to show. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Builds the four entry points every CQRS tool application repeats — one-shot CLI, REPL, sidecar and
 * HTTP — and the `main` that chooses between them.
 *
 * 🔴 **An unrecognised leading flag is refused by name** — `--repel` and `-x` alike. Without that, a typo
 * would fall through to "no arguments" semantics and start a web server, or be run as an operation
 * called `-x`. An operation name never starts with `-`, so nothing legitimate is refused.
 *
 * Extra-mode flags are checked when the app is defined: a duplicate, or one that shadows a standard
 * flag, throws at once rather than silently changing which mode runs.
 *
 * @example
 * ```ts
 * const app = defineApp({
 *   name: 'schedule',
 *   createTool: createScheduleTool,
 *   http: { createApp: createScheduleHttp, portEnv: 'SCHEDULE_PORT', defaultPort: 3401 },
 *   isOperatorError: (error) => error instanceof WorkspaceError,
 * });
 * export const { runCli, runRepl, runSidecar, runApi } = app;
 * if (require.main === module) {
 *   // A non-operator error from a long-running mode is rethrown, as a bug should be: without the
 *   // catch it is an unhandled rejection (Node prints the stack and exits 1).
 *   app.main().catch((error) => {
 *     console.error(error);
 *     process.exitCode = 1;
 *   });
 * }
 * ```
 */
export function defineApp<Options = undefined>(
  definition: AppDefinition<Options>,
): App<Options> {
  const { name, http } = definition;
  const isOperatorError = definition.isOperatorError ?? (() => false);
  const extraModes = definition.extraModes ?? [];

  const taken = new Set<string>(STANDARD_FLAGS);
  for (const { flag } of extraModes) {
    if (taken.has(flag)) {
      throw new Error(
        `${name}: extra mode '${flag}' is already taken (a standard flag, or another extra mode)`,
      );
    }
    taken.add(flag);
  }

  const withTool = async <T>(
    options: Options | undefined,
    use: (runtime: CqrsToolRuntime) => Promise<T>,
  ): Promise<T> => {
    const tool = await definition.createTool(options);
    let result: T;
    try {
      result = await use(tool.runtime);
    } catch (error) {
      // The failure being reported is the one from `use`; a failing close must not replace it.
      await quietly(() => tool.close());
      throw error;
    }
    await tool.close();
    return result;
  };

  const runCli: App<Options>['runCli'] = (
    argv = process.argv.slice(2),
    options,
    io,
  ) =>
    withTool(options, (runtime) =>
      io
        ? runOneShot(runtime, withoutCliFlag(argv), io)
        : runOneShot(runtime, withoutCliFlag(argv)),
    );

  const runRepl: App<Options>['runRepl'] = (
    input = process.stdin,
    output = process.stdout,
    options,
  ) =>
    withTool(options, (runtime) => runInteractiveRepl(runtime, input, output));

  const runSidecar: App<Options>['runSidecar'] = (
    input = process.stdin,
    output = process.stdout,
    options,
  ) =>
    withTool(options, (runtime) => runJsonLinesDriver(runtime, input, output));

  const runApi: App<Options>['runApi'] = async (options) => {
    if (!http) throw new Error(`${name} has no HTTP mode`);
    const requestedPort = process.env[http.portEnv] || http.defaultPort;
    const context: AppHttpContext = { port: requestedPort };
    const app = await http.createApp(options, context);
    try {
      const prefix = http.globalPrefix ?? 'api';
      app.setGlobalPrefix(prefix);
      await http.configure?.(app, options, context);
      await app.listen(requestedPort);
      const address = app.getHttpServer().address();
      const port =
        typeof address === 'object' && address ? address.port : requestedPort;
      Logger.log(
        `${name} is serving on: http://localhost:${port}${http.helpPath ?? `/${[prefix, name, 'help'].filter(Boolean).join('/')}`}`,
      );
      return app;
    } catch (error) {
      // A half-started application holds modules, timers and possibly a socket; release them, and
      // report the failure that got us here rather than one from the cleanup.
      await quietly(() => app.close());
      throw error;
    }
  };

  /** A long-running mode: an operator's error is reported plainly, anything else is a real failure. */
  const guarded = async (start: () => Promise<unknown>): Promise<void> => {
    try {
      await start();
    } catch (error) {
      if (!isOperatorError(error)) throw error;
      process.stderr.write(`${messageOf(error)}\n`);
      process.exitCode = 1;
    }
  };

  const oneShot = async (
    argv: readonly string[],
    options: Options | undefined,
  ): Promise<void> => {
    try {
      process.exitCode = await runCli(argv, options);
    } catch (error) {
      process.stderr.write(
        isOperatorError(error)
          ? `${messageOf(error)}\n`
          : `${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  };

  const main: App<Options>['main'] = async (
    argv = process.argv.slice(2),
    options,
  ) => {
    const first = argv[0];
    if (first?.startsWith('-') && !taken.has(first)) {
      process.stderr.write(
        `${name}: unknown mode '${first}'. Modes are ${[
          '--repl',
          '--sidecar',
          ...extraModes.map((mode) => mode.flag),
          '--cli',
        ].join(', ')}${http ? ', or none for the HTTP API' : ''}.\n`,
      );
      process.exitCode = 2;
      return;
    }
    if (argv.includes('--repl'))
      return guarded(() => runRepl(undefined, undefined, options));
    if (argv.includes('--sidecar'))
      return guarded(() => runSidecar(undefined, undefined, options));
    const extra = extraModes.find((mode) => argv.includes(mode.flag));
    if (extra) return guarded(async () => extra.run(options, argv));
    if (argv.length === 0) {
      return http
        ? guarded(() => runApi(options))
        : oneShot(['--help'], options);
    }
    return oneShot(argv, options);
  };

  return { runCli, runRepl, runSidecar, runApi, main };
}
