import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runOneShot } from '@devx-micro/app-cli';
import { runInteractiveRepl } from '@devx-micro/app-repl';
import type { CqrsToolRuntime } from '@devx-micro/app-runtime';
import { runJsonLinesDriver } from '@devx-micro/app-sidecar';

import { defineApp, type AppDefinition } from './define-app';

// The transports have their own specs; here they are recorded so the dispatch, the lifecycle and the
// error handling of the entry points can be asserted without a terminal.
vi.mock('@devx-micro/app-cli', () => ({ runOneShot: vi.fn(async () => 0) }));
vi.mock('@devx-micro/app-repl', () => ({
  runInteractiveRepl: vi.fn(async () => undefined),
}));
vi.mock('@devx-micro/app-sidecar', () => ({
  runJsonLinesDriver: vi.fn(async () => undefined),
}));

class OperatorError extends Error {}

type Options = { tag: string };

const runtime = { id: 'runtime' } as unknown as CqrsToolRuntime;

/** Distinct objects, so swapping two arguments cannot pass a deep-equality assertion. */
const stream = (id: string) => ({ id }) as never;

/** Lets a test hold a promise open and release it, to assert what happens before and after. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function fakeApp(address: unknown = { port: 4321 }) {
  const calls: string[] = [];
  const app = {
    setGlobalPrefix: (prefix: string) => calls.push(`prefix:${prefix}`),
    listen: vi.fn(async (port: unknown) => {
      calls.push(`listen:${String(port)}`);
    }),
    close: vi.fn(async () => {
      calls.push('close');
    }),
    getHttpServer: () => ({ address: () => address }),
  };
  return { calls, app };
}

function build(overrides: Partial<AppDefinition<Options>> = {}) {
  const closed = vi.fn(async () => undefined);
  const createTool = vi.fn(async (_options?: Options) => ({
    runtime,
    close: closed,
  }));
  const http = fakeApp();
  const createApp = vi.fn(async () => http.app as never);
  const app = defineApp<Options>({
    name: 'demo',
    createTool,
    http: { createApp, portEnv: 'DEMO_APP_MAIN_PORT', defaultPort: 3999 },
    isOperatorError: (error) => error instanceof OperatorError,
    ...overrides,
  });
  return { app, createTool, closed, createApp, http };
}

describe('defineApp', () => {
  let stderr: string;
  let logged: string[];
  beforeEach(() => {
    stderr = '';
    logged = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(Logger, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    process.exitCode = undefined;
    delete process.env['DEMO_APP_MAIN_PORT'];
    vi.mocked(runOneShot).mockClear().mockResolvedValue(0);
    vi.mocked(runInteractiveRepl).mockClear().mockResolvedValue(undefined);
    vi.mocked(runJsonLinesDriver).mockClear().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  describe('definition', () => {
    it('refuses an extra mode that repeats a standard flag', () => {
      for (const flag of ['--repl', '--sidecar', '--cli', '--help'] as const) {
        expect(() =>
          build({ extraModes: [{ flag, run: async () => undefined }] }),
        ).toThrow(
          `demo: extra mode '${flag}' is already taken (a standard flag, or another extra mode)`,
        );
      }
    });

    it('refuses two extra modes with the same flag', () => {
      const run = async () => undefined;
      expect(() =>
        build({
          extraModes: [
            { flag: '--hub', run },
            { flag: '--hub', run },
          ],
        }),
      ).toThrow(`extra mode '--hub' is already taken`);
    });
  });

  describe('runCli', () => {
    it('runs one operation with the runtime, passing options to the factory, and closes the tool', async () => {
      const { app, createTool, closed } = build();
      vi.mocked(runOneShot).mockResolvedValue(7);

      const code = await app.runCli(['note.get', '--id', '1'], { tag: 'x' });

      expect(code).toBe(7);
      expect(createTool).toHaveBeenCalledWith({ tag: 'x' });
      expect(runOneShot).toHaveBeenCalledWith(runtime, [
        'note.get',
        '--id',
        '1',
      ]);
      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('drops a --cli flag wherever it sits, and forwards an injected io', async () => {
      const { app } = build();
      const io = { stdout: () => undefined, stderr: () => undefined };

      await app.runCli(['--cli', 'a', '--cli'], undefined, io);

      expect(runOneShot).toHaveBeenCalledWith(runtime, ['a'], io);
    });

    it('closes the tool only after the transport has finished', async () => {
      const { app, closed } = build();
      const transport = deferred<number>();
      vi.mocked(runOneShot).mockReturnValue(transport.promise);

      const running = app.runCli(['x']);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(closed).not.toHaveBeenCalled();

      transport.resolve(0);
      await running;
      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('closes the tool when the transport throws, and rethrows that error', async () => {
      const { app, closed } = build();
      vi.mocked(runOneShot).mockRejectedValue(new Error('boom'));

      await expect(app.runCli(['x'])).rejects.toThrow('boom');
      expect(closed).toHaveBeenCalledTimes(1);
    });

    it('reports the transport error, not the close error, when both fail', async () => {
      const { app, closed } = build();
      closed.mockRejectedValue(new Error('close failed'));
      vi.mocked(runOneShot).mockRejectedValue(new Error('real failure'));

      await expect(app.runCli(['x'])).rejects.toThrow('real failure');
    });

    it('waits for the close before rethrowing the transport error', async () => {
      const { app, closed } = build();
      const closing = deferred();
      closed.mockReturnValue(closing.promise as never);
      vi.mocked(runOneShot).mockRejectedValue(new Error('real failure'));
      let settled = false;

      const running = app.runCli(['x']).catch(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);

      closing.resolve();
      await running;
      expect(settled).toBe(true);
    });

    it('reports the transport error when close throws synchronously or returns nothing', async () => {
      const { app, closed } = build();
      vi.mocked(runOneShot).mockRejectedValue(new Error('real failure'));

      closed.mockImplementation((() => {
        throw new Error('sync close failure');
      }) as never);
      await expect(app.runCli(['x'])).rejects.toThrow('real failure');

      closed.mockImplementation((() => undefined) as never);
      await expect(app.runCli(['x'])).rejects.toThrow('real failure');
    });

    it('writes a warning to stderr, with the app name and the cause, when closing fails while another error is being reported', async () => {
      const { app, closed } = build();
      closed.mockRejectedValue(new Error('dispose blew up'));
      vi.mocked(runOneShot).mockRejectedValue(new Error('real failure'));

      await expect(app.runCli(['x'])).rejects.toThrow('real failure');

      expect(stderr).toBe(
        'demo: warning: closing the tool failed while handling an earlier error: dispose blew up\n',
      );
    });

    it("still writes the warning when the app has silenced Nest's Logger", async () => {
      const { app, closed } = build();
      vi.spyOn(Logger, 'warn').mockImplementation(() => {
        throw new Error('the Logger must not be used for this');
      });
      closed.mockRejectedValue(new Error('dispose blew up'));
      vi.mocked(runOneShot).mockRejectedValue(new Error('real failure'));

      await expect(app.runCli(['x'])).rejects.toThrow('real failure');

      expect(stderr).toContain('closing the tool failed');
    });

    it.each([
      ['a null-prototype object', () => Object.create(null)],
      [
        'an object whose toString throws',
        () => ({
          toString() {
            throw new Error('toString failed');
          },
        }),
      ],
      [
        'an Error whose message getter throws',
        () => {
          const error = new Error('x');
          Object.defineProperty(error, 'message', {
            get() {
              throw new Error('getter failed');
            },
          });
          return error;
        },
      ],
    ])(
      'reports the original error when close throws %s, and still warns',
      async (_label, thrown) => {
        const { app, closed } = build();
        closed.mockImplementation((async () => {
          throw thrown();
        }) as never);
        vi.mocked(runOneShot).mockRejectedValue(new Error('real failure'));

        await expect(app.runCli(['x'])).rejects.toThrow('real failure');
        expect(stderr).toBe(
          'demo: warning: closing the tool failed while handling an earlier error: <unprintable value>\n',
        );
      },
    );

    it('reports the original error when stderr itself throws while warning', async () => {
      const { app, closed } = build();
      vi.mocked(process.stderr.write).mockImplementation(() => {
        throw new Error('stderr is closed');
      });
      closed.mockRejectedValue(new Error('dispose blew up'));
      vi.mocked(runOneShot).mockRejectedValue(new Error('real failure'));

      await expect(app.runCli(['x'])).rejects.toThrow('real failure');
    });

    it('does not warn when closing succeeds', async () => {
      const { app } = build();
      vi.mocked(runOneShot).mockRejectedValue(new Error('real failure'));

      await expect(app.runCli(['x'])).rejects.toThrow('real failure');

      expect(stderr).toBe('');
    });

    it('defaults argv to the process arguments', async () => {
      const { app } = build();
      const saved = process.argv;
      process.argv = ['node', 'main', 'note.get', '--id', '9'];
      try {
        await app.runCli();
      } finally {
        process.argv = saved;
      }

      expect(runOneShot).toHaveBeenCalledWith(runtime, [
        'note.get',
        '--id',
        '9',
      ]);
    });

    it('reports a close failure when the transport succeeded', async () => {
      const { app, closed } = build();
      closed.mockRejectedValue(new Error('close failed'));

      await expect(app.runCli(['x'])).rejects.toThrow('close failed');
    });
  });

  describe('runRepl and runSidecar', () => {
    it('hand the runtime and each stream, in order, to their transports and close the tool afterwards', async () => {
      const { app, closed } = build();
      const input = stream('input');
      const output = stream('output');

      await app.runRepl(input, output, { tag: 'r' });
      await app.runSidecar(input, output, { tag: 's' });

      const repl = vi.mocked(runInteractiveRepl).mock.calls[0] as unknown[];
      const sidecar = vi.mocked(runJsonLinesDriver).mock.calls[0] as unknown[];
      expect(repl[0]).toBe(runtime);
      expect(repl[1]).toBe(input);
      expect(repl[2]).toBe(output);
      expect(sidecar[0]).toBe(runtime);
      expect(sidecar[1]).toBe(input);
      expect(sidecar[2]).toBe(output);
      expect(closed).toHaveBeenCalledTimes(2);
    });

    it('default to the process streams', async () => {
      const { app } = build();

      await app.runRepl();
      await app.runSidecar();

      for (const call of [
        vi.mocked(runInteractiveRepl).mock.calls[0] as unknown[],
        vi.mocked(runJsonLinesDriver).mock.calls[0] as unknown[],
      ]) {
        expect(call[1]).toBe(process.stdin);
        expect(call[2]).toBe(process.stdout);
      }
    });

    it('close the tool when the transport throws', async () => {
      const { app, closed } = build();
      vi.mocked(runJsonLinesDriver).mockRejectedValue(new Error('pipe'));

      await expect(app.runSidecar()).rejects.toThrow('pipe');
      expect(closed).toHaveBeenCalledTimes(1);
    });
  });

  describe('runApi', () => {
    it('resolves the port before building the app, and gives both factories the same context', async () => {
      process.env['DEMO_APP_MAIN_PORT'] = '5555';
      const configure = vi.fn();
      const createApp = vi.fn(async () => http.app as never);
      const { app, http } = build({
        http: {
          createApp,
          portEnv: 'DEMO_APP_MAIN_PORT',
          defaultPort: 3999,
          configure,
        },
      });

      await app.runApi({ tag: 'o' });

      expect(createApp).toHaveBeenCalledWith({ tag: 'o' }, { port: '5555' });
      expect(configure).toHaveBeenCalledWith(
        http.app,
        { tag: 'o' },
        { port: '5555' },
      );
    });

    it('sets the prefix, then configures, then listens on the default port', async () => {
      const { app, http } = build({
        http: {
          createApp: async () => http.app as never,
          portEnv: 'DEMO_APP_MAIN_PORT',
          defaultPort: 3999,
          configure: () => {
            http.calls.push('configure');
          },
        },
      });

      await app.runApi();

      expect(http.calls).toEqual(['prefix:api', 'configure', 'listen:3999']);
    });

    it('waits for an asynchronous configure before listening, and for listen before resolving', async () => {
      const configuring = deferred();
      const listening = deferred();
      const { app, http } = build({
        http: {
          createApp: async () => http.app as never,
          portEnv: 'DEMO_APP_MAIN_PORT',
          defaultPort: 3999,
          configure: () => configuring.promise,
        },
      });
      http.app.listen.mockImplementation(async () => {
        http.calls.push('listen');
        await listening.promise;
      });
      let settled = false;

      const running = app.runApi().then(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(http.calls).not.toContain('listen');

      configuring.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(http.calls).toContain('listen');
      expect(settled).toBe(false);

      listening.resolve();
      await running;
      expect(settled).toBe(true);
    });

    it('lets the environment override the port, and honours a custom prefix', async () => {
      process.env['DEMO_APP_MAIN_PORT'] = '5555';
      const { app, http } = build({
        http: {
          createApp: async () => http.app as never,
          portEnv: 'DEMO_APP_MAIN_PORT',
          defaultPort: 3999,
          globalPrefix: 'v1',
        },
      });

      await app.runApi();

      expect(http.calls).toEqual(['prefix:v1', 'listen:5555']);
    });

    it('treats an empty port variable as unset', async () => {
      process.env['DEMO_APP_MAIN_PORT'] = '';
      const { app, http } = build();

      await app.runApi();

      expect(http.calls).toContain('listen:3999');
    });

    it('logs the port the server is actually on, with the default help path', async () => {
      const { app, http } = build();
      http.app.getHttpServer = () => ({ address: () => ({ port: 4321 }) });

      await app.runApi();

      expect(logged).toEqual([
        'demo is serving on: http://localhost:4321/api/demo/help',
      ]);
    });

    it('logs a custom help path and prefix, and falls back to the requested port for a socket address', async () => {
      process.env['DEMO_APP_MAIN_PORT'] = '5555';
      const { app, http } = build({
        http: {
          createApp: async () => http.app as never,
          portEnv: 'DEMO_APP_MAIN_PORT',
          defaultPort: 3999,
          globalPrefix: 'v1',
          helpPath: '/v1/status',
        },
      });
      http.app.getHttpServer = () => ({ address: () => '/tmp/app.sock' });

      await app.runApi();

      expect(logged).toEqual([
        'demo is serving on: http://localhost:5555/v1/status',
      ]);
    });

    it('keeps an empty global prefix instead of replacing it with api, and logs a clean help path', async () => {
      const { app, http } = build({
        http: {
          createApp: async () => http.app as never,
          portEnv: 'DEMO_APP_MAIN_PORT',
          defaultPort: 3999,
          globalPrefix: '',
        },
      });

      await app.runApi();

      expect(http.calls[0]).toBe('prefix:');
      expect(logged).toEqual([
        'demo is serving on: http://localhost:4321/demo/help',
      ]);
    });

    it('builds the default help path from a custom prefix', async () => {
      const { app, http } = build({
        http: {
          createApp: async () => http.app as never,
          portEnv: 'DEMO_APP_MAIN_PORT',
          defaultPort: 3999,
          globalPrefix: 'v1',
        },
      });

      await app.runApi();

      expect(logged).toEqual([
        'demo is serving on: http://localhost:4321/v1/demo/help',
      ]);
    });

    it('falls back to the requested port when the server has no address', async () => {
      const { app, http } = build();
      http.app.getHttpServer = () => ({ address: () => null });

      await app.runApi();

      expect(logged).toEqual([
        'demo is serving on: http://localhost:3999/api/demo/help',
      ]);
    });

    it('waits for the application to close before rethrowing the startup error', async () => {
      const { app, http } = build();
      const closing = deferred();
      http.app.listen.mockRejectedValue(new Error('EADDRINUSE'));
      http.app.close.mockReturnValue(closing.promise);
      let settled = false;

      const running = app.runApi().catch(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);

      closing.resolve();
      await running;
      expect(settled).toBe(true);
    });

    it('reports the startup error when app.close throws synchronously or returns nothing', async () => {
      const { app, http } = build();
      http.app.listen.mockRejectedValue(new Error('EADDRINUSE'));

      http.app.close.mockImplementation((() => {
        throw new Error('sync close failure');
      }) as never);
      await expect(app.runApi()).rejects.toThrow('EADDRINUSE');

      http.app.close.mockImplementation((() => undefined) as never);
      await expect(app.runApi()).rejects.toThrow('EADDRINUSE');
    });

    it.each([
      ['/api', '/api/demo/help'],
      ['api/', '/api/demo/help'],
      ['/', '/demo/help'],
      ['/v1/', '/v1/demo/help'],
      ['v1/beta', '/v1/beta/demo/help'],
    ])('logs a clean help path for the prefix %j', async (prefix, helpPath) => {
      const { app, http } = build({
        http: {
          createApp: async () => http.app as never,
          portEnv: 'DEMO_APP_MAIN_PORT',
          defaultPort: 3999,
          globalPrefix: prefix,
        },
      });

      await app.runApi();

      expect(logged).toEqual([
        `demo is serving on: http://localhost:4321${helpPath}`,
      ]);
    });

    it('warns on stderr, and still reports the startup error, when closing the application fails too', async () => {
      const { app, http } = build();
      http.app.listen.mockRejectedValue(new Error('listen failed'));
      http.app.close.mockRejectedValue(new Error('onModuleDestroy failed'));

      await expect(app.runApi()).rejects.toThrow('listen failed');

      expect(stderr).toBe(
        'demo: warning: closing the application failed while handling an earlier error: onModuleDestroy failed\n',
      );
    });

    it('warns the same way when configure failed and closing then fails too', async () => {
      const { app, http } = build({
        http: {
          createApp: async () => http.app as never,
          portEnv: 'DEMO_APP_MAIN_PORT',
          defaultPort: 3999,
          configure: () => {
            throw new Error('configure failed');
          },
        },
      });
      http.app.close.mockRejectedValue(new Error('onModuleDestroy failed'));

      await expect(app.runApi()).rejects.toThrow('configure failed');

      expect(stderr).toContain(
        'closing the application failed while handling an earlier error: onModuleDestroy failed',
      );
    });

    it('reports the startup error when app.close throws a value that cannot be printed', async () => {
      const { app, http } = build();
      http.app.listen.mockRejectedValue(new Error('listen failed'));
      http.app.close.mockImplementation((async () => {
        throw Object.create(null);
      }) as never);

      await expect(app.runApi()).rejects.toThrow('listen failed');
      expect(stderr).toContain('<unprintable value>');
    });

    it('resolves to the application it started', async () => {
      const { app, http } = build();
      expect(await app.runApi()).toBe(http.app);
    });

    it('throws when the definition has no HTTP mode', async () => {
      const { app } = build({ http: undefined });
      await expect(app.runApi()).rejects.toThrow('demo has no HTTP mode');
    });

    it('closes the application and rethrows the original error when configure fails', async () => {
      const { app, http } = build({
        http: {
          createApp: async () => http.app as never,
          portEnv: 'DEMO_APP_MAIN_PORT',
          defaultPort: 3999,
          configure: () => {
            throw new Error('bad config');
          },
        },
      });

      await expect(app.runApi()).rejects.toThrow('bad config');
      expect(http.app.close).toHaveBeenCalledTimes(1);
      expect(http.app.listen).not.toHaveBeenCalled();
    });

    it('closes the application and rethrows the original error when listen fails, even if close fails too', async () => {
      const { app, http } = build();
      http.app.listen.mockRejectedValue(new Error('EADDRINUSE'));
      http.app.close.mockRejectedValue(new Error('close failed'));

      await expect(app.runApi()).rejects.toThrow('EADDRINUSE');
      expect(http.app.close).toHaveBeenCalledTimes(1);
    });

    it('does not log when it did not start', async () => {
      const { app, http } = build();
      http.app.listen.mockRejectedValue(new Error('EADDRINUSE'));

      await expect(app.runApi()).rejects.toThrow();
      expect(logged).toEqual([]);
    });
  });

  describe('main', () => {
    it.each(['--repel', '-x', '-'])(
      'refuses an unrecognised leading flag %s by name, exit 2, without building a tool or a server',
      async (flag) => {
        const { app, createTool, createApp } = build();

        await app.main([flag]);

        expect(stderr).toBe(
          `demo: unknown mode '${flag}'. Modes are --repl, --sidecar, --cli, or none for the HTTP API.\n`,
        );
        expect(process.exitCode).toBe(2);
        expect(createTool).not.toHaveBeenCalled();
        expect(createApp).not.toHaveBeenCalled();
      },
    );

    it('names extra modes in that message, and omits the HTTP clause when there is no HTTP mode', async () => {
      const { app } = build({
        http: undefined,
        extraModes: [{ flag: '--hub', run: async () => undefined }],
      });

      await app.main(['--nope']);

      expect(stderr).toBe(
        "demo: unknown mode '--nope'. Modes are --repl, --sidecar, --hub, --cli.\n",
      );
    });

    it.each([['--cli'], ['--help'], ['-h']])(
      'runs %s as a one-shot request rather than refusing it or starting a server',
      async (flag) => {
        const { app, createApp } = build();

        await app.main([flag]);

        expect(stderr).toBe('');
        expect(runOneShot).toHaveBeenCalledTimes(1);
        expect(createApp).not.toHaveBeenCalled();
      },
    );

    it('runs a lone --cli as a one-shot with no operation', async () => {
      const { app } = build();

      await app.main(['--cli']);

      expect(runOneShot).toHaveBeenCalledWith(runtime, []);
    });

    it('does not refuse a flag that is not first, and a flag later in argv still selects its mode', async () => {
      const { app } = build();

      await app.main(['x', '--repl']);

      expect(stderr).toBe('');
      expect(runInteractiveRepl).toHaveBeenCalledTimes(1);
    });

    it('starts the REPL and the sidecar, passing options to the tool factory', async () => {
      const { app, createTool } = build();

      await app.main(['--repl'], { tag: 'a' });
      await app.main(['--sidecar'], { tag: 'b' });

      expect(runInteractiveRepl).toHaveBeenCalledTimes(1);
      expect(runJsonLinesDriver).toHaveBeenCalledTimes(1);
      expect(createTool.mock.calls.map(([options]) => options)).toEqual([
        { tag: 'a' },
        { tag: 'b' },
      ]);
    });

    it('lets --sidecar and an extra mode flag appear after other arguments', async () => {
      const run = vi.fn(async () => undefined);
      const { app } = build({ extraModes: [{ flag: '--hub', run }] });

      await app.main(['x', '--sidecar']);
      await app.main(['x', '--hub']);

      expect(runJsonLinesDriver).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('checks only the first argument: a later unrecognised flag is not refused and reaches the operation parser', async () => {
      const { app } = build();

      await app.main(['note.get', '--nope']);

      expect(stderr).toBe('');
      expect(process.exitCode).toBe(0);
      expect(runOneShot).toHaveBeenCalledWith(runtime, ['note.get', '--nope']);
    });

    it('defaults argv to the process arguments', async () => {
      const { app } = build();
      const saved = process.argv;
      process.argv = ['node', 'main', 'note.get', '--id', '4'];
      try {
        await app.main();
      } finally {
        process.argv = saved;
      }

      expect(runOneShot).toHaveBeenCalledWith(runtime, [
        'note.get',
        '--id',
        '4',
      ]);
    });

    it('prefers the REPL when both --repl and --sidecar are given', async () => {
      const { app } = build();

      await app.main(['--sidecar', '--repl']);

      expect(runInteractiveRepl).toHaveBeenCalledTimes(1);
      expect(runJsonLinesDriver).not.toHaveBeenCalled();
    });

    it('prefers the REPL over an extra mode when both are given', async () => {
      const run = vi.fn(async () => undefined);
      const { app } = build({ extraModes: [{ flag: '--hub', run }] });

      await app.main(['--hub', '--repl']);

      expect(runInteractiveRepl).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
    });

    it('refuses a near miss of an extra mode flag', async () => {
      const { app } = build({
        extraModes: [{ flag: '--hub', run: async () => undefined }],
      });

      await app.main(['--hubx']);

      expect(process.exitCode).toBe(2);
      expect(stderr).toContain("unknown mode '--hubx'");
    });

    it('runs the first extra mode, in definition order, when two of their flags are given', async () => {
      const first = vi.fn(async () => undefined);
      const second = vi.fn(async () => undefined);
      const { app } = build({
        extraModes: [
          { flag: '--hub', run: first },
          { flag: '--sync', run: second },
        ],
      });

      await app.main(['--sync', '--hub']);

      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
    });

    it('runs an extra mode with the options and the full argv', async () => {
      const run = vi.fn(async () => undefined);
      const { app } = build({ extraModes: [{ flag: '--hub', run }] });

      await app.main(['--hub', '--port', '9'], { tag: 'h' });

      expect(run).toHaveBeenCalledWith({ tag: 'h' }, ['--hub', '--port', '9']);
    });

    it('starts the HTTP API when there are no arguments, passing options to the factory', async () => {
      const { app, http, createApp } = build();

      await app.main([], { tag: 'api' });

      expect(http.calls).toContain('listen:3999');
      expect(createApp).toHaveBeenCalledWith({ tag: 'api' }, { port: 3999 });
    });

    it('prints the help text instead when there are no arguments and no HTTP mode', async () => {
      const { app, createTool } = build({ http: undefined });

      await app.main([], { tag: 'help' });

      expect(runOneShot).toHaveBeenCalledWith(runtime, ['--help']);
      expect(createTool).toHaveBeenCalledWith({ tag: 'help' });
    });

    it('runs anything else as a one-shot CLI, passing options, and sets the exit code', async () => {
      const { app, createTool } = build();
      vi.mocked(runOneShot).mockResolvedValue(3);

      await app.main(['note.get', '--id', '1'], { tag: 'cli' });

      expect(runOneShot).toHaveBeenCalledWith(runtime, [
        'note.get',
        '--id',
        '1',
      ]);
      expect(createTool).toHaveBeenCalledWith({ tag: 'cli' });
      expect(process.exitCode).toBe(3);
    });

    describe('errors', () => {
      it('reports an operator error from a long-running mode as its message alone, exit 1', async () => {
        const { app } = build({
          createTool: async () => {
            throw new OperatorError('no workspace here');
          },
        });

        await app.main(['--repl']);

        expect(stderr).toBe('no workspace here\n');
        expect(process.exitCode).toBe(1);
      });

      it('reports an operator error from the HTTP mode the same way', async () => {
        const { app } = build({
          http: {
            createApp: async () => {
              throw new OperatorError('no workspace for the api');
            },
            portEnv: 'DEMO_APP_MAIN_PORT',
            defaultPort: 1,
          },
        });

        await app.main([]);

        expect(stderr).toBe('no workspace for the api\n');
        expect(process.exitCode).toBe(1);
      });

      it('reports an operator error from an extra mode the same way, including a synchronous throw', async () => {
        const { app } = build({
          extraModes: [
            {
              flag: '--hub',
              run: () => {
                throw new OperatorError('hub needs a root');
              },
            },
          ],
        });

        await app.main(['--hub']);

        expect(stderr).toBe('hub needs a root\n');
        expect(process.exitCode).toBe(1);
      });

      it('rethrows any other error from a long-running mode', async () => {
        const { app } = build({
          createTool: async () => {
            throw new Error('real bug');
          },
        });

        await expect(app.main(['--sidecar'])).rejects.toThrow('real bug');
      });

      it('rethrows an unexpected error from the HTTP mode and from an extra mode', async () => {
        const { app } = build({
          http: {
            createApp: async () => {
              throw new Error('port in use');
            },
            portEnv: 'DEMO_APP_MAIN_PORT',
            defaultPort: 1,
          },
          extraModes: [
            {
              flag: '--hub',
              run: async () => {
                throw new Error('hub broke');
              },
            },
          ],
        });

        await expect(app.main([])).rejects.toThrow('port in use');
        await expect(app.main(['--hub'])).rejects.toThrow('hub broke');
      });

      it('prints an operator error from the one-shot CLI without a stack', async () => {
        const { app } = build({
          createTool: async () => {
            throw new OperatorError('bad config');
          },
        });

        await app.main(['x']);

        expect(stderr).toBe('bad config\n');
        expect(process.exitCode).toBe(1);
      });

      it('prints a non-Error value from an operator predicate as text, never as "undefined"', async () => {
        const { app } = build({
          isOperatorError: (error) => typeof error === 'string',
          createTool: async () => {
            throw 'plain string failure';
          },
        });

        await app.main(['x']);
        expect(stderr).toBe('plain string failure\n');

        stderr = '';
        await app.main(['--repl']);
        expect(stderr).toBe('plain string failure\n');
      });

      it('prints any other one-shot failure with the app name and its stack', async () => {
        const { app } = build();
        const failure = new Error('exploded');
        failure.stack = 'Error: exploded\n    at fake (file.ts:1:1)';
        vi.mocked(runOneShot).mockRejectedValue(failure);

        await app.main(['x']);

        expect(stderr).toMatch(/^demo failed: Error: exploded\n/);
        expect(stderr).toContain('at fake (file.ts:1:1)');
        expect(process.exitCode).toBe(1);
      });

      it('falls back to the message for an Error with no stack', async () => {
        const { app } = build();
        const failure = new Error('no stack here');
        failure.stack = undefined;
        vi.mocked(runOneShot).mockRejectedValue(failure);

        await app.main(['x']);

        expect(stderr).toBe('demo failed: no stack here\n');
      });

      it('treats nothing as an operator error when no predicate is given', async () => {
        const { app } = build({
          isOperatorError: undefined,
          createTool: async () => {
            throw new OperatorError('plain');
          },
        });

        await app.main(['x']);

        expect(stderr).toMatch(/^demo failed: /);
      });
    });
  });
});
