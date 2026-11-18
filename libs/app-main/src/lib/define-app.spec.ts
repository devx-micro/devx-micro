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

const runtime = { id: 'runtime' } as unknown as CqrsToolRuntime;

function fakeApp(address: unknown = { port: 4321 }) {
  const calls: string[] = [];
  return {
    calls,
    app: {
      setGlobalPrefix: (prefix: string) => calls.push(`prefix:${prefix}`),
      listen: async (port: unknown) => {
        calls.push(`listen:${String(port)}`);
      },
      getHttpServer: () => ({ address: () => address }),
    },
  };
}

function build(overrides: Partial<AppDefinition<{ tag: string }>> = {}) {
  const closed = vi.fn(async () => undefined);
  const createTool = vi.fn(async () => ({ runtime, close: closed }));
  const http = fakeApp();
  const createApp = vi.fn(async () => http.app as never);
  const app = defineApp<{ tag: string }>({
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
  beforeEach(() => {
    stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(Logger, 'log').mockImplementation(() => undefined);
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

    it('closes the tool when the transport throws, and rethrows', async () => {
      const { app, closed } = build();
      vi.mocked(runOneShot).mockRejectedValue(new Error('boom'));

      await expect(app.runCli(['x'])).rejects.toThrow('boom');
      expect(closed).toHaveBeenCalledTimes(1);
    });
  });

  describe('runRepl and runSidecar', () => {
    it('hand the runtime and streams to their transports and close the tool afterwards', async () => {
      const { app, closed } = build();
      const input = {} as never;
      const output = {} as never;

      await app.runRepl(input, output);
      await app.runSidecar(input, output);

      expect(runInteractiveRepl).toHaveBeenCalledWith(runtime, input, output);
      expect(runJsonLinesDriver).toHaveBeenCalledWith(runtime, input, output);
      expect(closed).toHaveBeenCalledTimes(2);
    });

    it('close the tool when the transport throws', async () => {
      const { app, closed } = build();
      vi.mocked(runJsonLinesDriver).mockRejectedValue(new Error('pipe'));

      await expect(app.runSidecar()).rejects.toThrow('pipe');
      expect(closed).toHaveBeenCalledTimes(1);
    });
  });

  describe('runApi', () => {
    it('sets the prefix, then configures, then listens on the default port', async () => {
      const configure = vi.fn(() => {
        http.calls.push('configure');
      });
      const { app, http } = build({
        http: {
          createApp: async () => http.app as never,
          portEnv: 'DEMO_APP_MAIN_PORT',
          defaultPort: 3999,
          configure,
        },
      });

      await app.runApi({ tag: 'o' });

      expect(http.calls).toEqual(['prefix:api', 'configure', 'listen:3999']);
      expect(configure).toHaveBeenCalledWith(http.app, { tag: 'o' });
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

    it('resolves to the application it started', async () => {
      const { app, http } = build();
      expect(await app.runApi()).toBe(http.app);
    });

    it('throws when the definition has no HTTP mode', async () => {
      const { app } = build({ http: undefined });
      await expect(app.runApi()).rejects.toThrow('demo has no HTTP mode');
    });
  });

  describe('main', () => {
    it('refuses an unrecognised --flag by name, exit 2, without building a tool or a server', async () => {
      const { app, createTool, createApp } = build();

      await app.main(['--repel']);

      expect(stderr).toBe(
        "demo: unknown mode '--repel'. Modes are --repl, --sidecar, --cli, or none for the HTTP API.\n",
      );
      expect(process.exitCode).toBe(2);
      expect(createTool).not.toHaveBeenCalled();
      expect(createApp).not.toHaveBeenCalled();
    });

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

    it('accepts every standard flag as a known mode', async () => {
      const { app } = build();
      for (const flag of ['--cli', '--help']) {
        stderr = '';
        await app.main([flag]);
        expect(stderr).toBe('');
      }
      await app.main(['-h']);
      expect(stderr).toBe('');
    });

    it('starts the REPL and the sidecar', async () => {
      const { app } = build();

      await app.main(['--repl']);
      await app.main(['--sidecar']);

      expect(runInteractiveRepl).toHaveBeenCalledTimes(1);
      expect(runJsonLinesDriver).toHaveBeenCalledTimes(1);
    });

    it('runs an extra mode', async () => {
      const run = vi.fn(async () => undefined);
      const { app } = build({ extraModes: [{ flag: '--hub', run }] });

      await app.main(['--hub'], { tag: 'h' });

      expect(run).toHaveBeenCalledWith({ tag: 'h' });
    });

    it('starts the HTTP API when there are no arguments', async () => {
      const { app, http } = build();

      await app.main([]);

      expect(http.calls).toContain('listen:3999');
    });

    it('prints the help text instead when there are no arguments and no HTTP mode', async () => {
      const { app } = build({ http: undefined });

      await app.main([]);

      expect(runOneShot).toHaveBeenCalledWith(runtime, ['--help']);
    });

    it('runs anything else as a one-shot CLI and sets the exit code', async () => {
      const { app } = build();
      vi.mocked(runOneShot).mockResolvedValue(3);

      await app.main(['note.get', '--id', '1']);

      expect(runOneShot).toHaveBeenCalledWith(runtime, [
        'note.get',
        '--id',
        '1',
      ]);
      expect(process.exitCode).toBe(3);
    });

    it('treats --help as a one-shot request, not a server start', async () => {
      const { app, createApp } = build();

      await app.main(['--help']);

      expect(runOneShot).toHaveBeenCalledWith(runtime, ['--help']);
      expect(createApp).not.toHaveBeenCalled();
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

      it('rethrows any other error from a long-running mode', async () => {
        const { app } = build({
          createTool: async () => {
            throw new Error('real bug');
          },
        });

        await expect(app.main(['--sidecar'])).rejects.toThrow('real bug');
      });

      it('rethrows an unexpected error from the HTTP mode', async () => {
        const { app } = build({
          http: {
            createApp: async () => {
              throw new Error('port in use');
            },
            portEnv: 'DEMO_APP_MAIN_PORT',
            defaultPort: 1,
          },
        });

        await expect(app.main([])).rejects.toThrow('port in use');
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

      it('prints any other one-shot failure with the app name and its stack', async () => {
        const { app } = build();
        vi.mocked(runOneShot).mockRejectedValue(new Error('exploded'));

        await app.main(['x']);

        expect(stderr).toMatch(/^demo failed: Error: exploded\n/);
        expect(process.exitCode).toBe(1);
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
