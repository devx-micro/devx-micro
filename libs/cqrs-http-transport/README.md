# @devx-micro/cqrs-http-transport

The HTTP half of the [`@devx-micro/cqrs-tool-runtime`](https://github.com/devx-micro/devx-micro/tree/main/libs/cqrs-tool-runtime) transport contract:
turn a `ToolEnvelope` into a response body, or into a thrown NestJS `HttpException`.

It lives in its own package so that `cqrs-tool-runtime` can stay free of `@nestjs/common`, and so
that every HTTP app in a codebase shares **one** mapping from exit code to status instead of each
growing its own.

```bash
npm install @devx-micro/cqrs-http-transport
```

## Usage

```ts
import { Body, Controller, Param, Post } from '@nestjs/common';
import { CqrsToolRuntime } from '@devx-micro/cqrs-tool-runtime';
import { unwrap } from '@devx-micro/cqrs-http-transport';

@Controller('ops')
export class OperationsController {
  constructor(private readonly runtime: CqrsToolRuntime) {}

  @Post(':operation')
  async dispatch(@Param('operation') operation: string, @Body() body: Record<string, unknown>) {
    return unwrap(await this.runtime.dispatch(operation, body));
  }
}
```

## API

### `unwrap(envelope): unknown`

| Envelope `status` | Result                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `success`         | Returns `data`, or `{}` when there is none (so the body is never empty).                               |
| `incomplete`      | Throws an `HttpException` with `code: "INCOMPLETE"`; the body carries `data` so the caller can resume. |
| `error`           | Throws an `HttpException` carrying `operation`, `code`, `message` and, if present, `details`.          |

The thrown body always includes `statusCode`.

### `statusForExitCode(exitCode): number`

| Exit code (`TOOL_EXIT_CODES`) | HTTP status |
| ----------------------------- | ----------- |
| `usage` (2)                   | 400         |
| `conflict` (3)                | 409         |
| `blocked` (4)                 | 409         |
| `notFound` (5)                | 404         |
| `infrastructure` (10)         | 503         |
| anything else                 | 500         |

One deliberate exception: an `UNKNOWN_OPERATION` error is **404** even though its exit code is
`usage`. A caller who asked for an operation the app does not have has the wrong URL, and a 400
would send them to check their request body instead.

## API reference

Generated TypeDoc: run `npm run docs` at the repository root and open `docs/api/index.html`.

## License

[MPL-2.0](https://github.com/devx-micro/devx-micro/blob/main/LICENSE)
