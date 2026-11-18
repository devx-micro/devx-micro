# @devx-micro/observability-port

The **port** for recording observations of work that was done: the record shape, the `Recorder`
interface, content addressing, and the pure logic for recording inference runs. It holds **no
storage and no I/O**. An implementation is injected by the application's composition root, and code
that emits observations depends only on this package.

```bash
npm install @devx-micro/observability-port
```

Everything here is pure and deterministic unless noted, and every validator takes `unknown` and
**never throws**: it returns a list of problems, empty meaning valid.

## What's in the box

### Observation records (`record`)

An `ObservationRecord` describes one observed unit: its `kind` (`operation`, `workflow-step`,
`tool-call`, `dispatch`, `inference-run`), `operator`, `operation`, two UTC timestamps, optional
`durationMs` / `latencyMs`, a `result` (`success` | `failure` | `blocked` | `skipped` plus
`evidence`) and a free-form `detail`.

The field list is closed: a new field or a changed meaning bumps `OBSERVATION_SCHEMA_VERSION`.

- **Absent is never zero.** A duration or latency that was not measured is omitted, not recorded as
  `0`.
- `failure` and `blocked` results must carry non-empty `evidence`.
- `validateObservation(input)` lists every rule violation, and its last check asks whether the
  record can be canonically hashed, so a record that validates is also recordable.

### The recorder port (`recorder`)

```ts
import { noopRecorder, startTiming, type Recorder } from '@devx-micro/observability-port';

const timing = startTiming(); // injectable Clock; defaults to systemClock
const result = await doTheWork();
const { beforeTimestamp, afterTimestamp, durationMs } = timing.finish();

await recorder.record({
  kind: 'operation',
  operator: 'my-tool',
  operation: 'note.get',
  beforeTimestamp,
  afterTimestamp,
  ...(durationMs !== undefined ? { durationMs } : {}),
  result: { outcome: 'success', evidence: [] },
});
```

- `Recorder.record` resolves to the stored content id, or `undefined` if nothing was stored. It
  must not throw into the observed unit.
- `noopRecorder` is the default for emitters whose app has not bound a real one.
  `OBSERVATION_RECORDER` is the conventional DI token.
- `startTiming` measures duration with the monotonic clock, never by subtracting timestamps (the
  wall clock can step). A bad monotonic reading omits the duration rather than throwing.
- `InferenceRecorder` extends `Recorder` with artifact, contract and per-iteration storage;
  `isInferenceRecorder` narrows to it.

### Bounded recording (`bounded-recording`)

`BoundedRecording` makes waiting on a recorder safe for the caller:

```ts
const bounded = new BoundedRecording({ label: 'my-tool', timeoutMs: 2000, cooldownMs: 30000 });
await bounded.run(() => recorder.record(observation)); // never throws, never waits past timeoutMs
```

After a **timeout**, `isPaused()` is true for the cooldown so a wedged store costs the bound once,
not on every call. A recorder that is merely slow never trips it.

### Content identity (`canonical-json`, `content-id`, `requirement`)

- `canonicalJson(value)` is [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) JSON
  Canonicalization. Unlike `JSON.stringify` it **throws** on anything with no JSON form (`NaN`,
  `Infinity`, holes, lone surrogates, cycles). The one exception: an object member whose value is
  `undefined` is treated as absent.
- A `ContentId` is `1-<32 hex>`: the first 32 hex characters of a SHA-256. The leading `1` versions
  the ID scheme. Create with `contentIdOfText`, `contentIdOfBytes` or `contentIdOfRecord`; check
  with `isContentId`, `parseContentId`, `verifyContentId`.
- An ID names **bytes, not a type**: `contentIdOfText('"x"')` equals `contentIdOfRecord('x')`.
  Store the kind next to the ID.
- `requirementId(text)` hashes requirement text in a normal form (NFC, LF line endings, each line
  trimmed, runs of ASCII space/tab collapsed, edge blank lines removed), so the ID identifies the
  claim rather than its layout.
- `wellFormed(text)` replaces lone surrogates with U+FFFD, for caller text that must remain
  hashable.

### Inference runs (`contract-extraction`, `evaluation`, `inference`)

A run is a **contract** (role, goal, requirements, assumptions), a sequence of **iterations**
that each evaluate the output against every requirement, and an overall result.

- `extractContract(markdown)` reads a contract out of step text: requirements are the bullets (or
  paragraphs) under headings such as _Requirements_, _Acceptance_ or _Constraints_, plus paragraphs
  opening with `🔴 **` or `⚠️ **`. Code blocks are examples, not claims, and are skipped (decided by a
  CommonMark parser). Oversized input is reported unparseable rather than guessed at (see
  `MAX_PARSE_CHARS`, `MAX_REQUIREMENTS`, `MAX_ITEM_CHARS`).
- `evaluateRequirements(requirements, subject, evaluators)` asks `RequirementEvaluator`s for a
  verdict per requirement. The first valid entry wins. **No evaluator is built in**, so by default
  every requirement is `not-evaluated`; nothing ever guesses `met`.
- `decideIteration` accepts an iteration only when no requirement is `not-met` and at least one is
  `met`. `derivedConfidence` is `met / (met + notMet)`, omitted when the denominator is 0.
- `completeRun` produces the overall `ResultRecord` and `InferenceRunDetail`. Incomplete contracts
  and duplicate requirements can never be accepted.
- `validateContract` and `validateIteration` return problem lists.
- `ContractEnforcement` (`'observe'` by default, or `'refuse'`) chooses whether such runs are
  refused before dispatch or observed and recorded as failures.

## API reference

Generated TypeDoc: run `npm run docs` at the repository root and open `docs/api/index.html`.

## License

[MPL-2.0](https://github.com/devx-micro/devx-micro/blob/main/LICENSE)
