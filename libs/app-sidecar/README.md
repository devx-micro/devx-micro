# @devx-micro/app-sidecar

The JSON-lines transport for a [`@devx-micro/app-runtime`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-runtime) application, both ends of it: `runJsonLinesDriver` is the server a child process runs, and `SidecarClient` is what the parent (typically an editor extension) uses to talk to it.

## Install

```bash
npm install @devx-micro/app-sidecar
```

It depends on [`@devx-micro/app-runtime`](https://github.com/devx-micro/devx-micro/tree/main/libs/app-runtime), which provides the `CqrsToolRuntime` it drives.

## Usage

### Server: `runJsonLinesDriver(runtime, input?, output?)`

Reads one JSON request per line, writes one envelope per line.

```ts
import { runJsonLinesDriver } from '@devx-micro/app-sidecar';

// node main.js --sidecar
await runJsonLinesDriver(runtime);
```

```jsonc
{"operation":"note.get","input":{"id":"42"},"correlationId":"abc"}
{"operation":"help","input":{"topic":"note.get"}}
```

A line that is not valid JSON yields an `INVALID_JSON_LINE` envelope; the loop continues.

### Client: `SidecarClient`

Framework-free (Node only), so it can run inside an editor extension host.

```ts
import { SidecarClient } from '@devx-micro/app-sidecar';

const sidecar = new SidecarClient({ command: process.execPath, args: ['main.js', '--sidecar'] });
sidecar.start();
const envelope = await sidecar.request({ operation: 'note.get', input: { id: '42' } });
await sidecar.stop();
```

- **Requests are queued, one in flight at a time.** The server awaits each line before reading the
  next, so concurrent writes could pair a response with the wrong request.
- **A dead child never hangs a caller.** A bad command, a crash or kill, and `stop()` racing a
  queued request each reject every pending request with a clear error (including the child's last
  stderr) instead of crashing the host or waiting forever.
- `start()` is idempotent, and a client can be started again after `stop()`.
