# CLAUDE.md

Context for Claude Code on a new machine or in a new session. `README.md` is the full reference for
people; this file is what you need to work on the code without re-deriving it. Facts here were taken
from the source, so when code and this file disagree, trust the code and fix this file.

## What Apayee is

A **private, local AI gateway**: one Node.js (Fastify) HTTP service that accepts a generation request
from a trusted backend client, runs it through one operator-chosen provider, validates the output
against the client's JSON Schema, and returns normalized JSON. Clients own workflows, prompts and
data; Apayee owns inference execution only. It stores nothing.

Main consumer: **QATOOL**, a sibling project (a separate repo/folder, not part of this one) that turns
PRDs into test cases. Apayee is its optional LLM backend, next to Gemini.

Neither project was a git repository when this file was written. Check `git status` before assuming
history exists.

## Request flow

```text
POST /v1/generate
  onRequest hooks     rejectBrowserOrigins (403 if Origin header)  ->  bearerAuthentication (if token set)
  body parse          application/json only (text/plain parser removed), bodyLimit
  parseGenerateRequest (src/validation/request.js)   shape, timeout <= max, task supported, schema compiles (Ajv)
  queue.enqueue        FIFO, ONE active execution, bounded pending + bounded wait
  provider.generate    mock | claude          (selected by APAYEE_PROVIDER at boot, never by the client)
  acceptedResult       JSON round-trip, must be an object/array, validated against the client's schema
  200 {request_id, status:'success', provider, result, metadata{queue_wait_ms, execution_time_ms, total_time_ms, usage?}}
```

Errors from any step go to the single error handler in `src/app.js`, which maps them through
`src/errors.js` to `{request_id, status:'error', error:{code, message, retryable, details?}}`. Provider
messages are never relayed unless the provider threw an `ApiError`.

`GET /v1/health` returns `{status, service, version, provider, provider_status, queue}`. `provider` is the
provider's name **only while it is ready**; otherwise `<name>_not_ready`. QATOOL relies on that to
decide whether Claude is selectable.

## Where things live

| Path | Responsibility |
| --- | --- |
| `src/server.js` | Entry point. `startServer()` loads config, builds the app, listens, handles SIGINT/SIGTERM/SIGBREAK (stop immediately, do not drain). Only listens when run as the entry point |
| `src/app.js` | `buildApp({config, provider?, logStream?, env?})`: Fastify, hooks, error handler, routes. Tests inject `provider` and `logStream` |
| `src/config.js` | `loadConfig(env)` and `loadClaudeSettings(env)`. Invalid values throw `ConfigError` at boot; nothing silently defaults. Enforces token strength and the loopback rules |
| `src/errors.js` | `ApiError` and the error-code catalog (HTTP status, retryable) |
| `src/middleware/authentication.js` | Bearer check (constant time) and browser-origin rejection |
| `src/routes/generate.js`, `health.js` | The two endpoints. Disconnect aborts a queued or active request |
| `src/queue/request-queue.js` | The only concurrency control. In memory, one active run, abort grace, `abandoned` counter |
| `src/validation/` | `request.js` (request contract) and `json-schema.js` (Ajv, refuses `pattern`, external `$ref`, `$async`, deep nesting) |
| `src/providers/provider.js` | `Provider` contract: `generate()`, `status()`, `supportsTask()` |
| `src/providers/registry.js` | Fixed table `{mock, claude}`. Add a provider here; no dynamic module paths |
| `src/providers/mock/` | Deterministic mock (default). Delay/failure controls are constructor options for tests only |
| `src/providers/claude/` | The experimental CLI provider, below |
| `scripts/claude-auth.js` | `claude:login`, `claude:status`, `claude:smoke` (implemented in `providers/claude/auth.js`) |
| `examples/qatool-client/` | Mock-level demonstration of the QATOOL integration pattern. Not QATOOL's code |
| `tests/` | `node:test` suites; `helpers/` and `fixtures/` hold the fake CLI and harness |
| `docs/` | `CLAUDE_PROVIDER.md` (provider design, setup, policy), `PROVIDER_SELECTION_AUDIT.md` (historical QATOOL audit, dated 2026-10-31) |

Claude provider files (`src/providers/claude/`): `claude.provider.js` (class, readiness cache, error
mapping), `cli.js` (resolve and spawn the executable, kill tree, output caps), `invocation.js` (exact
flags, minimum CLI version), `environment.js` (child env allowlist, denied variables), `readiness.js`
(static checks and the two-process probe), `result.js` (parse CLI JSON, classify failures), `workdir.js`
(empty temp cwd per run), `auth.js` (login/status/smoke).

## How the Claude CLI integration works

Experimental, **owner-only**, uses the owner's own signed-in Claude subscription. No API key, no
Anthropic SDK, no credential handling in Apayee. Off unless `APAYEE_CLAUDE_EXPERIMENTAL=true` and
`APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED=true` (the owner's attestation; Apayee cannot verify a plan), and
`APAYEE_PROVIDER=claude` additionally needs a strong `APAYEE_AUTH_TOKEN` and a loopback host.

Per request: a fresh `claude -p --output-format json --json-schema <schema> --tools "" --disallowedTools mcp__*
--strict-mcp-config --safe-mode --disable-slash-commands --permission-mode dontAsk --no-session-persistence
--max-turns 5 [--model]`. `shell:false`, prompt on stdin (never argv), empty temp directory as cwd, child
environment built from an **allowlist** plus `MAX_STRUCTURED_OUTPUT_RETRIES` (default 1). Timeout is
`min(request timeout_ms, APAYEE_CLAUDE_TIMEOUT_MS)`. On abort or timeout the whole process tree is killed
(`taskkill /T /F` on Windows, process group elsewhere). Schema argument limit is 16,000 characters
(`INVALID_SCHEMA` above it).

Rules that must not be loosened without a reason you can state:

- Never pass `--console` (API billing) or `--bare` (skips the subscription login).
- Never fall back to the mock. Not ready means `PROVIDER_NOT_READY` (503, not retryable).
- Any `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_OAUTH_*`, cloud-provider or base-URL variable stops
  the provider. Names are reported, values never.
- Apayee never retries. One request can still use several CLI model turns (`num_turns` is reported in
  `metadata.usage`), so one request is not one turn.
- Logs hold metadata only (ids, task, durations, counts, error codes). Never log prompts, schemas,
  results, tokens, email or org identifiers.

Readiness: stage 1 (flags, conflicting variables, CLI found) starts no process and runs every call; stage
2 starts the CLI twice (`--version`, `auth status`), is cached (60 s ready, 15/30/60 s backoff when not
ready) and single-flight. Minimum CLI version is 2.1.299.

Failure mapping (full table in `docs/CLAUDE_PROVIDER.md`): signed out -> `PROVIDER_NOT_READY` 503;
session/weekly/model limit and throttling -> `PROVIDER_RATE_LIMITED` 429; 5xx/529 ->
`PROVIDER_UNAVAILABLE` 503; timeout -> `PROVIDER_TIMEOUT` 504; schema/turn/format failures ->
`INVALID_PROVIDER_RESPONSE` 502.

## QATOOL link

QATOOL talks to Apayee over loopback HTTP with `Authorization: Bearer <APAYEE_TOKEN>`. On the QATOOL
side (separate project, edit only when a task says so): `server/llm/apayee.js` is the adapter
(implements `generateJson({system, prompt, schema, signal})` -> `{data, usage}`, generates the
`request_id`, defaults `task` to `generic`, maps Apayee codes to `LLM_*` errors, never retries),
`server/llm/catalog.js` offers the provider choices, and `?provider=claude` on `/api/extract` and
`/api/generate` selects Claude per run. The adapter enforces that the gateway reports the expected
provider name. QATOOL variables: `APAYEE_BASE_URL` (default `http://127.0.0.1:4100`), `APAYEE_TOKEN`
(must equal Apayee's `APAYEE_AUTH_TOKEN`), `LLM_TIMEOUT_MS` (sent as `timeout_ms`, must not exceed
`APAYEE_MAX_TIMEOUT_MS`), `APAYEE_QUEUE_WAIT_MS`.

A QATOOL run costs two generation requests (structuring in `/api/extract`, generation in
`/api/generate`); semantic review adds a third only with `?semantic=true`. Extract is fail-soft: if the
structuring call fails, QATOOL falls back to deterministic extraction, so check `status.mode === 'ai'`.

## Commands

```bash
npm install
npm test                     # full suite, real sockets, network guard, fake CLI (no model, no network)
npm start                    # node --env-file-if-exists=.env src/server.js
npm run dev                  # same, with --watch
npm run claude:status        # readiness only; starts the CLI twice, sends no model request
npm run claude:login         # the CLI's own sign-in; run as the OS user that runs Apayee
npm run claude:smoke         # ONE real model request; needs APAYEE_CLAUDE_SMOKE=1; uses subscription quota
npm run example:qatool       # needs `npm start` running in another terminal
```

There is no build step and no linter configured. Process environment variables override `.env`.
Windows is the primary platform (PowerShell); the one real-signal test is skipped there.

## Status when this file was written

- Mock provider and the HTTP/queue/validation layers: complete and covered by tests.
- Claude provider: tested against a fake CLI. One real direct call to `ClaudeProvider.generate`
  succeeded on CLI 2.1.316 (`num_turns` 2, schema valid), and `--tools ""` still allowed structured
  output. **Not yet done:** a live QATOOL -> Apayee HTTP -> Claude run, concurrency, long-run and
  larger-schema behaviour against the real CLI.
- Policy: whether scripted use of a subscription is allowed is **unconfirmed**. Technical success is not
  permission. Do not describe the provider as approved. The unsent draft question is in
  `docs/CLAUDE_PROVIDER.md`.

## Working rules for this repo

- Never read, print or commit `.env`, tokens, credentials, email or organization identifiers. Use
  `.env.example` for documentation.
- Do not edit QATOOL unless the task says so. Do not commit or push unless asked.
- No API keys, Console billing, credential extraction, private endpoints or retries meant to evade a
  usage limit. Do not weaken auth, loopback, TLS or antivirus settings to make something run.
- Keep to the existing style: ES modules, no build step, minimal comments that explain why.
- Tests that check documentation wording read `README.md`, `docs/CLAUDE_PROVIDER.md` and `.env.example`
  (`tests/claude-provider.test.js`, "documentation makes only claims the evidence supports"). Edit those
  files with the test open.
