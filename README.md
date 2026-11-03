# Apayee

**Private Local AI Gateway — a standalone service that manages AI request execution for privately operated applications.**

Clients own their workflows and data. Apayee owns inference execution.

> **Current state.** The default provider is a deterministic mock, and no real AI is called unless
> you opt in. There is also an **experimental, owner-only `claude` provider** that drives the
> official Claude Code CLI with your own signed-in Claude subscription. It is off by default, needs
> three explicit opt-ins, and its policy status is **unconfirmed** — read
> [docs/CLAUDE_PROVIDER.md](docs/CLAUDE_PROVIDER.md) before enabling it. Apayee holds no Anthropic API
> key, SDK or credential, and never will under this design.

## Contents

1. [Overview](#overview)
2. [Technology stack](#technology-stack)
3. [Architecture and folder structure](#architecture-and-folder-structure)
4. [How a request is handled](#how-a-request-is-handled)
5. [Setup on a new computer](#setup-on-a-new-computer)
6. [Configuration](#configuration)
7. [API](#api)
8. [Queue, timeouts and shutdown](#queue-timeouts-and-shutdown)
9. [Claude Code CLI integration](#claude-code-cli-integration)
10. [QATOOL integration](#qatool-integration)
11. [Security](#security)
12. [Development workflow and tests](#development-workflow-and-tests)
13. [Troubleshooting](#troubleshooting)
14. [Project status and open work](#project-status-and-open-work)
15. [Adding a provider](#adding-a-provider)

## Overview

Apayee is a small HTTP service that sits between a trusted backend application and an AI model. The
application sends a prompt and a JSON Schema; Apayee queues the request, runs it through the provider
the operator configured, checks the output against the schema, and returns normalized JSON.

| Apayee does                                     | Apayee does not                                   |
| ----------------------------------------------- | ------------------------------------------------- |
| Accept and validate generation requests         | Parse PRDs or understand any client's domain      |
| Queue them, FIFO, one at a time by default      | Orchestrate workflows or stages                   |
| Run the provider chosen by server configuration | Let clients choose a provider or run commands     |
| Enforce timeouts and cancellation               | Retry anything automatically                      |
| Validate output against the client's schema     | Repair or alter a provider's output               |
| Log operational metadata and report health      | Store prompts, results or artifacts, or log them  |

Its main consumer is **QATOOL**, a separate project that turns PRDs into test cases
([QATOOL integration](#qatool-integration)).

## Technology stack

| Piece        | Choice                                                                   |
| ------------ | ------------------------------------------------------------------------ |
| Runtime      | Node.js 22.13 or newer, ES modules, no build step, no TypeScript         |
| HTTP server  | Fastify 5 (with its built-in Pino logger)                                |
| Validation   | Ajv 8 and ajv-formats (draft-07 and 2020-12 JSON Schema)                 |
| Tests        | The built-in `node:test` runner, real sockets, a fake CLI                |
| Real model   | Optional: the official Claude Code CLI, started as a child process       |
| Storage      | None. The queue is in memory and nothing is persisted                    |

No database, broker or other service is needed.

## Architecture and folder structure

```text
client application
      |  HTTP / JSON
      v
Fastify server        origin check, bearer auth, body limit
      |
      v
request validation    shape, timeout limit, task support, schema compiles
      |               (rejected here means never queued)
      v
FIFO queue            1 to 3 active executions (default 1), bounded pending, bounded wait
      |
      v
provider              registry -> mock | claude (experimental, runs the official CLI)
      |
      v
output validation     against the client's JSON Schema
      |
      v
normalized JSON response
```

```text
apayee/
  CLAUDE.md                  context for Claude Code in a new session or machine
  README.md                  this file
  package.json, package-lock.json
  .env.example               every setting with its default (copy to .env; .env is never committed)
  .gitignore
  docs/
    CLAUDE_PROVIDER.md       Claude provider: design, setup, policy status, readiness, errors
    PROVIDER_SELECTION_AUDIT.md   historical QATOOL provider-selection audit (2026-10-31)
    ENVIRONMENT_SNAPSHOT.md/.json recorded tool and dependency versions, with recovery steps
    DOCKER_LOCAL.md          running Apayee in Docker: build, sign-in volume, ports, Compose notes
  Dockerfile, .dockerignore  the container image (docker/entrypoint.sh starts Apayee and its port forwarder)
  scripts/
    claude-auth.js           CLI for claude:login, claude:status, claude:smoke
  src/
    server.js                entry point: listening, signals, shutdown
    app.js                   assembles Fastify, hooks, error handling
    config.js                environment parsing and security checks
    errors.js                error-code catalog (HTTP status, retryable)
    middleware/authentication.js   bearer token, browser-origin rejection
    routes/                  health.js, generate.js
    queue/request-queue.js   FIFO queue, APAYEE_MAX_CONCURRENT active runs (default 1)
    validation/              request.js (contract), json-schema.js (Ajv rules)
    providers/
      provider.js            the Provider contract
      registry.js            fixed table of providers
      mock/                  deterministic mock (default)
      claude/                experimental Claude Code CLI provider
  tests/                     node:test suites; helpers/ and fixtures/ hold the fake CLI
  examples/qatool-client/    mock-level demonstration of the QATOOL integration pattern
```

Files inside `src/providers/claude/`:

| File                | Responsibility                                                              |
| ------------------- | --------------------------------------------------------------------------- |
| `claude.provider.js`| The provider class: readiness cache, running the CLI, mapping failures     |
| `cli.js`            | Finding and starting the executable, output caps, killing the process tree  |
| `invocation.js`     | The exact CLI flags, the minimum CLI version                                |
| `environment.js`    | The child-process environment allowlist and the variables that stop it      |
| `readiness.js`      | Static checks and the two-process probe (`--version`, `auth status`)        |
| `result.js`         | Parsing the CLI's JSON result and classifying failures                      |
| `workdir.js`        | An empty temporary working directory per run                                |
| `auth.js`           | The login, status and smoke commands                                        |

## How a request is handled

1. **Connection hooks.** A request carrying an `Origin` header is refused with 403. If a token is
   configured, `Authorization: Bearer <token>` is checked (constant time) before the body is read.
2. **Parsing.** Only `application/json` is accepted, up to `APAYEE_MAX_BODY_BYTES`.
3. **Validation** (`src/validation/request.js`). Field rules, `timeout_ms` against the maximum, the
   provider's support for the task, and compiling the client's schema. A request rejected here is
   never queued.
4. **Queue.** The request waits its turn (bounded size, bounded wait). A client that disconnects
   removes a waiting request or aborts the running one.
5. **Provider.** `provider.generate()` runs with an `AbortSignal` and the execution timeout. The
   provider is fixed by `APAYEE_PROVIDER` at startup; a request cannot choose one.
6. **Output check.** The reply is round-tripped through JSON, must be an object or array, and must
   validate against the client's schema. Otherwise `INVALID_PROVIDER_RESPONSE`.
7. **Response.** `200` with the result and timing/usage metadata, or an error body with a stable
   `code` and a `retryable` flag. Provider messages are never relayed unless the provider chose a
   safe message.

## Setup on a new computer

Nothing outside the project folder is required for the mock provider.

1. **Install Node.js 22.13 or newer** and check with `node --version`.
2. **Copy the project** without `node_modules` and without `.env`. Both are rebuilt or recreated below.
3. **Install dependencies:**
   ```bash
   npm install
   ```
4. **Create the settings file** (optional for the mock; every setting has a default):
   ```bash
   cp .env.example .env            # PowerShell: Copy-Item .env.example .env
   ```
   Node prints `.env not found. Continuing without it.` if you skip this, which is harmless.
5. **Check it works:**
   ```bash
   npm test
   npm start
   ```
   The service listens on `http://127.0.0.1:4100`. Try `GET /v1/health`.

The Node.js, npm, Claude CLI and dependency versions this project was last checked with, and how to
restore them, are in [docs/ENVIRONMENT_SNAPSHOT.md](docs/ENVIRONMENT_SNAPSHOT.md).

**In Docker** (local development, with its own Linux CLI and its own sign-in in a named volume): the full
procedure is in [docs/DOCKER_LOCAL.md](docs/DOCKER_LOCAL.md). For a standalone `docker run`, use a separate
`.env.docker`, not the Windows `.env` (the commands below do). QATOOL's Compose file behaves differently: it
passes the Windows `../Apayee/.env` to the container, and that works only because the container entrypoint fixes
the internal host and port (`127.0.0.1:4101`, socat on `4100`) and the Compose file overrides
`APAYEE_CLAUDE_CLI_PATH` with the Linux path. Under Compose no host port is published for Apayee at all.

```powershell
docker build -t apayee:local .
docker volume create apayee-claude-config
docker run -it --rm -v apayee-claude-config:/home/node/.claude apayee:local node scripts/claude-auth.js login
docker run -d --name apayee --restart unless-stopped -p 127.0.0.1:4100:4100 --env-file .env.docker -v apayee-claude-config:/home/node/.claude apayee:local
docker stop apayee
```

Inside the container Apayee listens on loopback (4101), as the Claude provider requires, and `socat` listens on
port 4100. With `docker run`, publish it only on `127.0.0.1`; under QATOOL's Compose file do not publish it.
The sign-in volume `apayee-claude-config` is a named volume in both cases; under Compose it is Compose-managed,
so `docker compose down -v` deletes the container's sign-in.

**To use the experimental Claude provider** on the new machine you also need to do the following
there. Nothing carries over from the old computer: the login lives in the CLI's own storage for that
Windows user, and `.env` holds the token.

1. Install the official Claude Code CLI natively and confirm `claude --version`
   (see [docs/CLAUDE_PROVIDER.md](docs/CLAUDE_PROVIDER.md), "One-time setup").
2. `npm run claude:login` as the same OS user that will run Apayee, and finish the sign-in with Anthropic.
3. Generate a **new** token for this machine (see [Security](#security)) and put it in `.env`
   as `APAYEE_AUTH_TOKEN`, together with `APAYEE_PROVIDER=claude`, `APAYEE_CLAUDE_EXPERIMENTAL=true`
   and `APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED=true` (your attestation, after checking your plan in your
   Claude account settings).
4. `npm run claude:status`, then `npm start`.
5. Give the same token to each client (QATOOL's `APAYEE_TOKEN`) and restart it.

## Configuration

Settings are environment variables, usually read from `.env` by `node --env-file-if-exists=.env`.
Variables already set in the process **win over** `.env`. Invalid values stop the service at startup
rather than falling back to a default. Names and meanings only; see `.env.example` for defaults and
never put real values in documentation.

| Variable                     | Default     | Meaning                                                          |
| ---------------------------- | ----------- | ---------------------------------------------------------------- |
| `APAYEE_HOST`                | `127.0.0.1` | Bind address. Non-loopback needs the two settings below          |
| `APAYEE_PORT`                | `4100`      | Port                                                             |
| `APAYEE_ALLOW_REMOTE`        | `false`     | Explicit opt-in to a non-loopback host                           |
| `APAYEE_AUTH_TOKEN`          | unset       | Bearer token; at least 32 characters. Required for remote access and for the `claude` provider |
| `APAYEE_PROVIDER`            | `mock`      | Active provider: `mock`, or the experimental `claude`            |
| `APAYEE_MAX_CONCURRENT`      | `1`         | Executions at once, 1 to 3. Above 1, see the concurrency note below |
| `APAYEE_MAX_QUEUE_SIZE`      | `16`        | Requests that may wait while every execution slot is busy        |
| `APAYEE_MAX_QUEUE_WAIT_MS`   | `600000`    | Longest wait in the queue                                        |
| `APAYEE_DEFAULT_TIMEOUT_MS`  | `180000`    | Execution budget when a request sends no `timeout_ms`            |
| `APAYEE_MAX_TIMEOUT_MS`      | `600000`    | A larger `timeout_ms` is rejected, not shortened                 |
| `APAYEE_ABORT_GRACE_MS`      | `2000`      | How long an aborted provider gets to stop                        |
| `APAYEE_SHUTDOWN_TIMEOUT_MS` | `10000`     | Hard limit on graceful shutdown                                  |
| `APAYEE_MAX_BODY_BYTES`      | `10485760`  | Largest request body                                             |
| `APAYEE_MAX_SCHEMA_BYTES`    | `262144`    | Largest client schema                                            |
| `APAYEE_LOG_LEVEL`           | `info`      | `fatal` to `trace`, or `silent`                                  |

Claude provider settings, only read for `APAYEE_PROVIDER=claude`, all off or unset by default:

| Variable                                     | Meaning                                                              |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `APAYEE_CLAUDE_EXPERIMENTAL`                 | Explicit opt-in (`true`/`false`)                                     |
| `APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED`       | Your attestation that you checked the plan in your account settings  |
| `APAYEE_CLAUDE_CLI_PATH`                     | Absolute path to `claude.exe` when it is not on `PATH`               |
| `APAYEE_CLAUDE_MODEL`                        | Model alias or name; unset uses the CLI's own default                |
| `APAYEE_CLAUDE_TIMEOUT_MS` (300000)          | Ceiling on one CLI run; the request's `timeout_ms` applies too, the shorter wins |
| `APAYEE_CLAUDE_STRUCTURED_OUTPUT_ATTEMPTS` (1) | Attempts the CLI may make to match the schema, 1 to 5              |
| `APAYEE_CLAUDE_PASSTHROUGH_ENV`              | Extra variable **names** the CLI may inherit, e.g. `HTTPS_PROXY`     |
| `APAYEE_CLAUDE_SMOKE`                        | Set to `1` only to allow `npm run claude:smoke` to send one request  |

`APAYEE_PROVIDER=claude` also requires `APAYEE_AUTH_TOKEN` and a loopback `APAYEE_HOST`.

## API

All routes need `Authorization: Bearer <token>` when a token is configured.

### `GET /v1/health`

```json
{
  "status": "ok",
  "service": "apayee",
  "version": "0.1.0",
  "provider": "mock",
  "provider_status": { "ready": true, "state": "ready" },
  "queue": {
    "length": 0,
    "running": false,
    "active": 0,
    "max_active": 1,
    "pending": 0,
    "capacity": 16,
    "abandoned": 0,
    "totals": { "succeeded": 2, "failed": 0, "timed_out": 0, "cancelled": 0, "rejected": 0 }
  }
}
```

`active` is the number of executions running now and `max_active` is `APAYEE_MAX_CONCURRENT`;
`pending` is the number waiting (`length` is the same figure, kept for existing clients), and
`capacity` is `APAYEE_MAX_QUEUE_SIZE`. `running` stays a boolean: true while `active` is above 0.
All of these are plain numbers; none carries a path, a version of the CLI or request content.

`abandoned` counts provider executions still running after their abort grace period. It should
always be 0. Health never sends a generation request.

`provider` carries the provider's name **only while it can take work**. A provider that is
configured but not ready (disabled, signed out, not confirmed) reports `<name>_not_ready`, for
example `claude_not_ready`, and `provider_status` gives a `state` and a safe `reason`. A client that
looks for a specific name, as QATOOL looks for `claude`, therefore never finds one that is not usable.

### `POST /v1/generate`

The call is synchronous: the response arrives when the request has finished. Send
`Content-Type: application/json`.

```json
{
  "request_id": "run-001-stage-1",
  "task": "understand_prd",
  "system": "System instructions...",
  "prompt": "Generation instructions and source content...",
  "schema": { "type": "object" },
  "timeout_ms": 180000
}
```

| Field        | Rules                                                                               |
| ------------ | ----------------------------------------------------------------------------------- |
| `request_id` | Required. 1 to 128 of `A-Za-z0-9._:-`. Must not match a queued or running request   |
| `task`       | Required. 1 to 64 of `a-z0-9_.-`. The mock accepts `understand_prd`, `generate_testcases`, `generic` |
| `system`     | Required string; may be empty                                                       |
| `prompt`     | Required non-empty string; never truncated                                          |
| `schema`     | Required JSON Schema object; see below                                              |
| `timeout_ms` | Optional positive integer, up to the server maximum                                 |

Any other field is rejected, so a client can't believe it chose a provider or a model.

**Supported schemas:** draft-07 (the default when `$schema` is absent) and draft 2020-12, with the
root describing an object or an array. Formats such as `date` are checked. These are refused with
`INVALID_SCHEMA`:

- `pattern` and `patternProperties`. Validation is synchronous, so a catastrophic regex would freeze
  the whole service where no timeout can interrupt it.
- References to anything external. Nothing is ever fetched.
- `$async` schemas, and nesting deeper than 64 levels.

The `claude` provider additionally refuses a schema longer than 16,000 characters, because the CLI
takes it as a command-line argument.

**Success (200):**

```json
{
  "request_id": "run-001-stage-1",
  "status": "success",
  "provider": "mock",
  "result": {},
  "metadata": {
    "queue_wait_ms": 0,
    "execution_time_ms": 21,
    "total_time_ms": 46,
    "usage": { "input_tokens": 0, "output_tokens": 0 }
  }
}
```

`total_time_ms` also covers request validation, so it can exceed the sum of the other two. `usage`
appears only when the provider reports it; the Claude provider adds `num_turns`.

**Failure:**

```json
{
  "request_id": "run-001-stage-1",
  "status": "error",
  "error": {
    "code": "PROVIDER_TIMEOUT",
    "message": "Provider execution exceeded the configured timeout.",
    "retryable": true
  }
}
```

`request_id` is `null` when the request carried no usable id, for example malformed JSON. An
optional `error.details` array of `{ path, message }` appears on `INVALID_REQUEST` and
`INVALID_PROVIDER_RESPONSE`, with at most 20 entries on the latter. Stack traces, provider messages
and request content are never included.

### Error codes

Branch on `code` and `retryable`, not on the message.

| HTTP | Code                        | Retryable | Meaning                                         |
| ---- | --------------------------- | --------- | ----------------------------------------------- |
| 400  | `INVALID_REQUEST`           | no        | Malformed JSON, or the body breaks the contract |
| 400  | `INVALID_SCHEMA`            | no        | Schema invalid, unsupported or too large        |
| 400  | `UNSUPPORTED_TASK`          | no        | The active provider doesn't support this task   |
| 401  | `UNAUTHORIZED`              | no        | Missing or wrong bearer token                   |
| 403  | `FORBIDDEN_ORIGIN`          | no        | Request has an `Origin` header (browser)        |
| 404  | `NOT_FOUND`                 | no        | No such endpoint                                |
| 409  | `DUPLICATE_REQUEST_ID`      | no        | That id is already queued or running            |
| 413  | `REQUEST_TOO_LARGE`         | no        | Body exceeds the limit                          |
| 415  | `UNSUPPORTED_MEDIA_TYPE`    | no        | Content-Type is not `application/json`          |
| 429  | `QUEUE_FULL`                | yes       | Pending queue is at capacity                    |
| 429  | `PROVIDER_RATE_LIMITED`     | yes       | The provider is limiting requests (the message says if it is brief throttling or an exhausted allowance) |
| 499  | `REQUEST_CANCELLED`         | yes       | The client disconnected                         |
| 500  | `INTERNAL_ERROR`            | no        | Unexpected failure in Apayee                    |
| 502  | `INVALID_PROVIDER_RESPONSE` | yes       | Output is non-JSON or fails the schema          |
| 503  | `PROVIDER_UNAVAILABLE`      | yes       | The provider failed                             |
| 503  | `PROVIDER_NOT_READY`        | no        | The provider is off, signed out or unconfirmed; waiting does not fix it |
| 503  | `QUEUE_TIMEOUT`             | yes       | Waited longer than the queue allows             |
| 503  | `SERVICE_SHUTTING_DOWN`     | yes       | Rejected or aborted by shutdown                 |
| 504  | `PROVIDER_TIMEOUT`          | yes       | Execution exceeded its timeout                  |

"Retryable" says a retry is not pointless in principle. For `PROVIDER_RATE_LIMITED` caused by an
exhausted subscription allowance, retrying straight away will not help; wait for the reset.

## Queue, timeouts and shutdown

**Queue**

- First in, first out, with `APAYEE_MAX_CONCURRENT` provider executions at a time (1 unless you
  change it; the most allowed is 3). Requests **start** in arrival order and no request can
  overtake an earlier one; with more than one slot they may **finish** in any order.
- A request runs immediately while a slot is free; otherwise it waits, up to `APAYEE_MAX_QUEUE_SIZE`
  requests. `QUEUE_FULL` is returned only when every slot is busy and the waiting line is full.
- **More than one slot (concurrency note).** Each execution has its own process, empty working
  directory, timeout and abort signal, and stopping one does not touch another. The tests for this use
  the fake CLI and mock provider only. What they cannot show is how several real Claude CLI processes
  behave when they share one sign-in and one configuration directory; that is **unverified** and
  needs a separately approved real run (`docs/CLAUDE_PROVIDER.md`). Each extra slot also uses subscription
  allowance faster, and needs more memory, CPU and process IDs from the host or container.
- An id is released as soon as its request finishes, so the same id can be sent again afterwards.
- Apayee never retries. **The queue is in memory, so pending requests are lost on restart.** That is
  acceptable because clients own their workflow state and can resend.

**Timeout and cancellation**

- `timeout_ms` covers **execution only** and starts when the request becomes active, so requests
  ahead of it can't use it up. Waiting is bounded separately by `APAYEE_MAX_QUEUE_WAIT_MS`.
- When a client disconnects, a pending request is removed and never runs; an active one is aborted.
  Only that request is affected: the other active executions keep running.
- On timeout or cancellation the provider's `AbortSignal` fires, and the queue waits up to
  `APAYEE_ABORT_GRACE_MS` for it to stop. A provider that honours the signal never takes the slot
  of a request that has not finished stopping, so executions never exceed `APAYEE_MAX_CONCURRENT`.
- A provider that ignores the signal loses its slot after the grace period so the queue can continue,
  **but it keeps running in the background**. Concurrency can exceed the limit until it finishes. This is
  logged as `provider_ignored_abort` and counted in `abandoned`, and the provider contract forbids it.
- **Client HTTP timeouts.** Headers arrive only when generation ends, so a client's own timeout must
  cover queue wait plus execution. Node's built-in `fetch` has a default `headersTimeout` of 300
  seconds and would abort anything longer. The example client uses `node:http` for this reason.

**Shutdown.** On SIGINT, SIGTERM or SIGBREAK, Apayee stops immediately rather than draining: pending
requests are rejected, every active one is aborted, each is answered with `SERVICE_SHUTTING_DOWN`, and
the server closes. If shutdown exceeds `APAYEE_SHUTDOWN_TIMEOUT_MS`, the process exits with code 1.
On Windows, Ctrl+C and Ctrl+Break are graceful; `Stop-Process -Force` and `taskkill /F` kill the
process with no cleanup (a running CLI child is then not stopped by Apayee).

## Claude Code CLI integration

Summary only; the full design, policy discussion, readiness states and recovery steps are in
[docs/CLAUDE_PROVIDER.md](docs/CLAUDE_PROVIDER.md).

- **What it is.** For each request Apayee starts the official, unmodified `claude` program in print
  mode and reads one JSON result. Authentication belongs entirely to the CLI; Apayee never sees,
  stores or forwards a credential, never uses an API key, and never falls back to the mock.
- **Invocation.** `claude -p --output-format json --json-schema <schema> --tools "" --disallowedTools mcp__*
  --strict-mcp-config --safe-mode --disable-slash-commands --permission-mode dontAsk
  --no-session-persistence --max-turns 5`, plus `--model` if configured. `--console` and `--bare` are
  never passed. The program is started without a shell, the prompt goes on stdin (not the command
  line), and the working directory is an empty temporary folder deleted afterwards.
- **Environment.** The child inherits only an allowlist of operating-system variables, plus
  `MAX_STRUCTURED_OUTPUT_RETRIES` (default 1). Any API-key, token, cloud-provider or base-URL variable
  in Apayee's environment stops the provider instead of being passed on.
- **Readiness.** `GET /v1/health` reports `claude` only when the CLI exists, is at least version 2.1.299,
  is signed in with `claude.ai`, no conflicting variable is set, and you attested your plan. Otherwise
  it reports `claude_not_ready` and generation returns `PROVIDER_NOT_READY` without starting a model run.
- **Process management.** Each run has a timeout (the shorter of the request's `timeout_ms` and
  `APAYEE_CLAUDE_TIMEOUT_MS`). On timeout, cancellation or shutdown the whole process tree is killed
  (`taskkill /T /F` on Windows). Output size is capped (8 MiB stdout, 64 KiB stderr). A process that
  does not confirm it stopped is reported as lingering instead of as a clean exit.
- **Turns and usage.** Apayee never retries, but the CLI can use more than one model turn per request.
  `num_turns` is returned in `metadata.usage` and logged. The reported token counts probably exclude
  cached input and do not measure subscription quota.
- **Helper commands.** `npm run claude:login` (the CLI's own sign-in), `npm run claude:status`
  (readiness; starts the CLI twice, no model request), and `npm run claude:smoke` (one real request;
  needs `APAYEE_CLAUDE_SMOKE=1`, uses quota).

## QATOOL integration

QATOOL is a separate project and is not part of this repository. It talks to Apayee over HTTP:

- **Transport.** QATOOL's Apayee adapter (`server/llm/apayee.js` in that project) implements its
  `generateJson({ system, prompt, schema, signal })` contract by calling `POST /v1/generate` with the
  bearer token. It generates the `request_id`, uses task `generic`, maps Apayee error codes onto its
  own `LLM_*` errors, and never retries.
- **Selection.** QATOOL's UI offers Claude only when `GET /v1/health` reports `provider: "claude"`.
  A run selects it with `?provider=claude`; Gemini remains the other choice.
- **QATOOL settings.** `APAYEE_BASE_URL` (default `http://127.0.0.1:4100`), `APAYEE_TOKEN` (must be the
  same value as Apayee's `APAYEE_AUTH_TOKEN`), `LLM_TIMEOUT_MS` (sent as `timeout_ms`; must not exceed
  `APAYEE_MAX_TIMEOUT_MS`) and `APAYEE_QUEUE_WAIT_MS`.
- **Cost of a run.** Structuring (`/api/extract`) and generation (`/api/generate`) are two Apayee
  requests. Semantic review adds a third only when requested.
- **Mapping to note.** `PROVIDER_NOT_READY` is not "overloaded, wait": QATOOL maps it to a
  not-configured error, and `PROVIDER_RATE_LIMITED` to a rate-limit error that says not to retry
  straight away.

`examples/qatool-client/` simulates the integration pattern against the mock. It is not QATOOL's
pipeline.

```bash
npm start                # terminal 1
npm run example:qatool   # terminal 2
```

- `apayee-provider.js` implements QATOOL's `LLMProvider` contract and the error mapping.
- `two-stage.js` sends `understand_prd`, validates the result, writes it into the prompt of a separate
  `generate_testcases` request, and validates that too.
- The mock can only know what is in its prompt, so Stage 2 cites Stage 1's attention areas only when
  they were actually handed over.

## Security

- **Loopback only by default.** A non-loopback host refuses to start unless `APAYEE_ALLOW_REMOTE=true`
  and a strong `APAYEE_AUTH_TOKEN` are both set. The `claude` provider never listens beyond loopback.
- **Token rules.** At least 32 characters, no whitespace, at least 8 distinct characters, nothing
  that looks like a placeholder. Weak tokens stop startup. Generate one with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`; never reuse a token
  across machines, and never put one in documentation or chat.
- **Authentication:** when a token is set, every route needs `Authorization: Bearer <token>`. It is
  checked before the body is read and compared in constant time.
- **Browsers are refused.** Requests with an `Origin` header are rejected and there are no CORS
  headers, which also blocks DNS rebinding against an unauthenticated localhost service. Backend HTTP
  clients don't send `Origin`.
- **Logs** hold metadata only: request id, task, provider, status, durations, token counts and error
  code. Prompts, schemas, results and tokens are never logged, at any level.
- **No execution paths:** requests can't select providers, load modules, touch files or run commands.
  Mock delay and failure controls exist only as constructor options used by tests. The one module
  that starts a program, `src/providers/claude/cli.js`, runs a fixed command without a shell and is
  reached only when the operator configured `APAYEE_PROVIDER=claude`; a test enforces both.
- **Nothing is persisted.**

### Running on a separate PC

Plain HTTP means the prompt, the results and the token all cross the network unencrypted, so use this
only on a network you trust, or inside a VPN or TLS tunnel. This applies to the mock provider only.

1. Generate a token (command above).
2. Set `APAYEE_HOST` to the machine's private address, not `0.0.0.0`, along with
   `APAYEE_ALLOW_REMOTE=true` and `APAYEE_AUTH_TOKEN`.
3. Allow only the client machine through the firewall. On Windows:
   ```powershell
   New-NetFirewallRule -DisplayName "Apayee" -Direction Inbound -Protocol TCP -LocalPort 4100 -RemoteAddress <client-ip> -Action Allow
   ```
4. Never forward this port from a router or expose it to the internet.

## Development workflow and tests

```bash
npm run dev     # restarts on file changes
npm test        # the whole suite
```

There is no build step and no linter configured; the code runs as written on Node 22.13+.

The suite runs real Fastify servers on real sockets and has no external dependencies. A guard makes
any `fetch` to another host fail the test. The Claude provider is tested against a **fake CLI**
(`tests/fixtures/fake-claude.js`), so the suite sends no model request and needs neither QATOOL nor a
Claude login. Two tests are skipped on Windows: the one for a real OS signal, because Windows can't
deliver a catchable signal to another process (there a child process raises the signal on itself instead),
and the one for the POSIX executable bit. To run them, run `npm test` on Linux, for example in a plain
`node:22` container with the project copied in and `npm ci` run there; they pass in that setup.

Some tests use short timeouts (hundreds of milliseconds) around process start-up. On a heavily loaded
Windows machine one of them ("the provider's own ceiling ends a run that hangs") has failed in a
full run and passed when run alone. Re-run that file before suspecting a regression:

```bash
node --import ./tests/helpers/no-network.js --test --test-concurrency=1 tests/claude-provider.test.js
```

Tests also check documentation wording (`tests/claude-provider.test.js`, "documentation makes only
claims the evidence supports") against `README.md`, `docs/CLAUDE_PROVIDER.md` and `.env.example`, so
edit those with the suite in mind.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `.env not found. Continuing without it.` | Harmless. Create `.env` from `.env.example` if you want to change settings |
| `Apayee did not start: ... not a loopback address` | `APAYEE_HOST` is not loopback. Use `127.0.0.1`, or set `APAYEE_ALLOW_REMOTE=true` with a token |
| `Apayee did not start: APAYEE_AUTH_TOKEN is not acceptable: ...` | Token too short, repetitive or placeholder-like. Generate a new one (see Security) |
| `APAYEE_PROVIDER=claude requires APAYEE_AUTH_TOKEN` | The Claude provider needs a token and a loopback host |
| `EADDRINUSE` | Port 4100 is taken (often a previous Apayee). Change `APAYEE_PORT` or stop the other process |
| `401 UNAUTHORIZED` | The client's token differs from `APAYEE_AUTH_TOKEN`. In QATOOL, `APAYEE_TOKEN` must be identical; restart both after editing `.env` |
| `403 FORBIDDEN_ORIGIN` | A browser called Apayee directly. Call it from a backend |
| Health shows `claude_not_ready` | Read `provider_status.state` and `reason`, or run `npm run claude:status`. The table in [docs/CLAUDE_PROVIDER.md](docs/CLAUDE_PROVIDER.md) maps every state to a fix |
| `cli_not_found` | Install the native CLI, open a new terminal, or set `APAYEE_CLAUDE_CLI_PATH` to the absolute path of `claude.exe` |
| `not_authenticated` | `npm run claude:login` as the same Windows user that runs Apayee |
| `api_environment_conflict` | An `ANTHROPIC_*` or similar variable is set in the shell. Remove it; the reason names it (never its value) |
| `503 PROVIDER_NOT_READY` on generate | Same as the readiness states above; not retryable until fixed |
| `429 PROVIDER_RATE_LIMITED` | Subscription usage limit or throttling. Wait for the reset; do not retry in a loop |
| `504 PROVIDER_TIMEOUT` | Raise `timeout_ms` (and `LLM_TIMEOUT_MS` in QATOOL), up to `APAYEE_MAX_TIMEOUT_MS`; the Claude ceiling is `APAYEE_CLAUDE_TIMEOUT_MS` |
| `429 QUEUE_FULL` / `503 QUEUE_TIMEOUT` | Requests are waiting behind a slow run. Check `queue` in health |
| Client times out at about 300 s | Use `node:http` or raise the client's headers timeout; built-in `fetch` aborts at 300 s |
| Changes to `.env` have no effect | Restart Apayee. Variables already in the shell override `.env` |

## Project status and open work

- **Done and tested:** HTTP API, auth, validation, queue, cancellation, shutdown, the mock provider and
  the example QATOOL client. QATOOL has a provider selector and an Apayee adapter that work against
  this API.
- **Claude provider:** experimental. Tested against a fake CLI whose output follows Anthropic's
  documentation. One real request through `npm run claude:smoke` (CLI 2.1.316) succeeded and showed
  `num_turns` 2 for one request. A request through Apayee's HTTP endpoint from QATOOL has **not** yet
  been run live, nor have concurrency, real timeouts and larger schemas. Details in
  [docs/CLAUDE_PROVIDER.md](docs/CLAUDE_PROVIDER.md).
- **Policy:** whether scripted use of a consumer subscription is permitted is unconfirmed, and Apayee
  cannot verify which plan an account is on. Technical success is not permission.
- **Limits by design:** queue state is lost on restart; no built-in TLS; one gateway process with one
  active execution; `pattern` and `patternProperties` are refused; schemas compile synchronously on each
  request (typically 20 to 40 ms, about 0.7 s at the default size limit, and nothing else runs meanwhile).
- **Possible next steps:** a live QATOOL run through Apayee, using the exit code and the CLI's
  `apiProvider` and `subscriptionType` fields in the readiness probe (currently undocumented, so
  unused), and making QATOOL's pipeline adopt the two-stage `understanding.json` workflow shown in the
  example, which QATOOL's own pipeline code does not yet have.

## Adding a provider

1. Create `src/providers/<name>/<name>.provider.js` extending `Provider` from
   `src/providers/provider.js`, and implement `generate({ system, prompt, schema, task, signal, timeoutMs })`
   returning `{ data, usage? }`.
2. Honour `signal`, including stopping any subprocess or socket. Return parsed JSON, never Markdown.
   Fail with `ApiError('PROVIDER_UNAVAILABLE', safeMessage)`, and never put prompt content in a message.
3. Override `supportsTask(task)` only if the provider must narrow its tasks, and `status()` if it can be
   unready.
4. Add one line to `REGISTRY` in `src/providers/registry.js`, then select it with `APAYEE_PROVIDER`.

Routes, the queue and output validation need no changes.
