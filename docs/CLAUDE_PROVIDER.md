# Claude provider (experimental, owner-run)

Apayee can answer requests by running the **official, unmodified Claude Code CLI** (`claude -p`)
with **the owner's own signed-in Claude subscription**. It is off by default and needs three explicit
opt-ins (`APAYEE_PROVIDER=claude`, `APAYEE_CLAUDE_EXPERIMENTAL=true`,
`APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED=true`). Authentication belongs entirely to the CLI: Apayee never
collects, stores, copies or forwards a credential, holds no API key, and never falls back to the mock.

## Third-party terms that apply

Technically possible is not the same as allowed. Anthropic's pages state, among other things
(<https://code.claude.com/docs/en/legal-and-compliance>, checked when this section was written; read the
current text):

> OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team,
> and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other
> native Anthropic applications.

> Developers building products or services that interact with Claude's capabilities, including those
> using the Agent SDK, should use API key authentication through Claude Console or a supported cloud
> provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own
> applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of
> their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or
> session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

The Consumer Terms (<https://www.anthropic.com/legal/consumer-terms>) also restrict accessing the services
"through automated or non-human means, whether through a bot, script, or otherwise" except via an API key or
where Anthropic explicitly permits it, and say an account may not be made available to anyone else.

What this means for operating Apayee:

- **Whether a given use is permitted is not decided by this code.** It is the operator's responsibility and
  risk. Technical success is not permission.
- **Serving other people is the case the quoted text restricts.** QATOOL's public staging demo does this
  through the owner's login, which is the owner's decision; nothing here changes that.
- **Whose documents are they?** Material that belongs to an employer is probably not appropriate for a personal
  subscription. For consumer plans Anthropic documents model-training and retention terms
  (<https://code.claude.com/docs/en/data-usage>); commercial plans are documented differently.
- **Plan limits.** Usage is shared with all of the owner's Claude use, and each request can take several model
  turns (see below).

Leave `APAYEE_CLAUDE_EXPERIMENTAL` at `false` unless you have accepted the above.

## How it works

```text
you, in a terminal on the Apayee machine
  |  npm run claude:login
  v
official Claude Code CLI  -- opens Anthropic's own sign-in; you finish it with Anthropic --
  |  credentials live in the CLI's own storage, never in Apayee
  v
QATOOL ---HTTP + bearer token---> Apayee ---> claude -p (fresh process per request) ---> Anthropic
```

Per request, Apayee starts a fresh CLI process in an empty temporary directory, with **no tools, no
MCP servers, no hooks or plugins, no saved session**, and sends your instruction and input on stdin
(never on the command line, where other local users could read it). It validates the answer against
the client's JSON Schema, and it never falls back to the mock.

| Flag or variable | Why |
| --- | --- |
| `-p --output-format json` | One JSON result on stdout |
| `--json-schema <schema>` | The CLI validates its reply against the client's own schema |
| `MAX_STRUCTURED_OUTPUT_RETRIES=1` | Documented limit on schema attempts: "a first attempt plus four retries" by default; Apayee sets 1 |
| `--max-turns 5` | A backstop against a loop, not the retry control |
| `--tools ""`, `--disallowedTools mcp__*`, `--strict-mcp-config` | Nothing the model could run or reach |
| `--safe-mode` | No hooks, skills, plugins, CLAUDE.md or auto memory; the login still works |
| `--permission-mode dontAsk` | Nothing can wait for an answer nobody will give |
| `--no-session-persistence` | Nothing saved; never `--continue` or `--resume` |

Never passed: `--console` (selects API billing) and `--bare` (skips the subscription login). A test
checks this.

## Retries and consumption, stated accurately

**Apayee itself never retries**, and nothing here retries to get around a usage limit. A failed
request is reported once.

**The CLI can take more than one model turn for one request.** With `--json-schema` it re-prompts
when its reply fails the schema, and the documented control for that is
`MAX_STRUCTURED_OUTPUT_RETRIES` (default 5 attempts). Apayee sets it to **1**, meaning no internal
retry, and lets you raise it (`APAYEE_CLAUDE_STRUCTURED_OUTPUT_ATTEMPTS`, 1 to 5). Even then a
successful run can use more than one turn (the structured answer is itself a tool call), and the
result reports `num_turns`. Apayee returns it in `metadata.usage.num_turns` and logs it as a count.
One Apayee request is therefore **not** one model turn. What one run actually uses is unknown
until a real run reports it.

## Environment: an allowlist, not a copy

The CLI inherits **only** the operating-system variables it needs (`PATH`, `SystemRoot`,
`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `HOME`, `LC_*`, and the like) plus names you
approve on purpose with `APAYEE_CLAUDE_PASSTHROUGH_ENV` (for example `HTTPS_PROXY` on a corporate
network). Apayee's own settings, unrelated secrets, and the variables of a parent Claude Code
session are not passed. The CLI keeps its subscription login in its own storage
(`%USERPROFILE%\.claude\.credentials.json` on Windows, per Anthropic's authentication page), which
is why `USERPROFILE` and `APPDATA` are kept and nothing is read from it by Apayee.

Separately, these **stop the provider** (names reported, values never): every `ANTHROPIC_*`
variable, `AWS_BEARER_TOKEN_BEDROCK`, `CLAUDE_CODE_OAUTH_*` (including the refresh-token variables),
`CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY|MANTLE|ANTHROPIC_AWS`, `CLAUDE_CODE_SKIP_*_AUTH`,
`CLAUDE_CODE_CLIENT_*`, `CLAUDE_CODE_API_KEY*`, `CLAUDE_CODE_PROVIDER_*`, `CLAUDE_CODE_SIMPLE` and
`CLAUDE_CODE_SAFE_MODE`, and `CLAUDE_CONFIG_DIR` unless you approved it (a different configuration
directory means a different login than the one Apayee checked). They are taken from Anthropic's
environment-variable and authentication pages, where an API key or token takes precedence over the
subscription login and `ANTHROPIC_API_KEY` is "always used when present" with `-p`.

**Not visible to Apayee:** settings files (`apiKeyHelper`, `forceLoginMethod`, an `env` block,
managed settings). Apayee does not read them. `--safe-mode` is documented to disable customizations
but to leave managed settings in force, and its effect on a user settings file's `env` or
`apiKeyHelper` is not documented. On a machine with managed Claude Code policy, check it.

## What Apayee can and cannot verify

| Apayee checks automatically | Only you can check |
| --- | --- |
| The CLI exists and is at least 2.1.299 | **Which plan the account is on.** Neither `claude auth status` nor `/status` proves it. Check your Claude account settings |
| `claude auth status` reports `authMethod: claude.ai` | That you are allowed to use the plan this way (policy, above) |
| No API or cloud-provider variable is set | Settings files and managed policy |
| You set the attestation flag | |

`APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED=true` is **your attestation**, not a verification. Set it only
after you checked the plan in your account settings.

**Why 2.1.299.** From Anthropic's changelog: 2.1.286 stopped `claude auth status` reporting a
Console sign-in's stored API key as `claude.ai` (it reports `api_key`; before that, the
authentication-method check could not tell API billing from the subscription); 2.1.289 fixed headless
`--json-schema` runs exiting non-zero on success; 2.1.299 release notes already describe sessions
"started with `--safe-mode`". The flag's first release is not stated in the notes that could be read.
A Console sign-in without an API key is stored as an OAuth profile; which `authMethod` that reports
is not documented, which is another reason the plan check is manual.

## One-time setup

This is the **standalone** setup, with the CLI installed on the machine that runs Apayee. For the Docker
stack, where the container has its own Linux CLI and its own sign-in stored in the Docker volume
`apayee-claude-config`, see [DOCKER_LOCAL.md](DOCKER_LOCAL.md). Credentials are never part of the repository:
the login is made once per machine, by the owner, through Anthropic's own flow.

1. **Install Claude Code** natively on the Apayee machine. Anthropic's Windows command
   (<https://code.claude.com/docs/en/setup>), from PowerShell:
   ```powershell
   irm https://claude.ai/install.ps1 | iex
   ```
   Then open a new terminal and run `claude --version`. The binary is `%USERPROFILE%\.local\bin\claude.exe`;
   if the shell cannot find it, fix PATH or set `APAYEE_CLAUDE_CLI_PATH`. An npm `claude.cmd` script
   launcher is refused, because starting it would need a shell. Where the npm package keeps the
   real `claude.exe` is not verified here.
2. **Remove any API credentials** from the environment Apayee runs in (see above).
3. **Log in**, as the same OS user that will run Apayee:
   ```powershell
   cd <path-to-your-Apayee-checkout>
   npm run claude:login
   ```
   Choose the Claude account (subscription) option, never Console. Finish the confirmation with
   Anthropic directly. Apayee sees none of it.
4. **Check your plan** in your Claude account settings (not in the CLI).
5. **Configure** Apayee's `.env`:
   ```ini
   APAYEE_PROVIDER=claude
   APAYEE_AUTH_TOKEN=<a token of at least 32 characters>
   APAYEE_CLAUDE_EXPERIMENTAL=true
   APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED=true   # your attestation, made after step 4
   ```
   Generate a token with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. The token is
   required so that only your own applications can spend your subscription. Apayee listens on
   loopback only in this mode.
6. **Check readiness:** `npm run claude:status`
7. **Start Apayee** (`npm start`) and check `GET /v1/health` with the bearer token. It reports
   `"provider": "claude"` only when everything above holds.
8. **QATOOL** needs the same token as its `APAYEE_TOKEN` setting, then a restart. Under QATOOL's Docker Compose
   file the backend reaches Apayee at `http://apayee:4100` on the private Compose network instead.
9. **Optional live check**, which sends one small synthetic request and uses subscription quota:
   ```powershell
   $env:APAYEE_CLAUDE_SMOKE = '1'; npm run claude:smoke
   ```
   It prints sanitized evidence (version, auth method, duration, `num_turns`, token counts,
   classification) and never the prompt or any account detail. It sends one request and does not
   retry after a failure.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `APAYEE_PROVIDER` | `mock` | `claude` selects this provider. Needs the token and a loopback host |
| `APAYEE_CLAUDE_EXPERIMENTAL` | `false` | Explicit opt-in. Nothing runs without it |
| `APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED` | `false` | Your attestation that you checked the plan in your account settings |
| `APAYEE_CLAUDE_CLI_PATH` | unset | Absolute path to `claude.exe`, if it is not on PATH |
| `APAYEE_CLAUDE_MODEL` | unset | Model alias or name. Not every plan supports every model |
| `APAYEE_CLAUDE_TIMEOUT_MS` | `300000` | Ceiling on one run. A request's `timeout_ms` applies too; the shorter wins |
| `APAYEE_CLAUDE_STRUCTURED_OUTPUT_ATTEMPTS` | `1` | Sent as `MAX_STRUCTURED_OUTPUT_RETRIES`; 1 to 5 |
| `APAYEE_CLAUDE_PASSTHROUGH_ENV` | empty | Comma-separated names the CLI may inherit, e.g. `HTTPS_PROXY`. Credentials and routing overrides are refused |

Invalid values stop startup. QATOOL's `LLM_TIMEOUT_MS` is sent as the request's `timeout_ms`, so
raise it in QATOOL if the CLI needs longer than its default 120 seconds.

## Concurrency

`APAYEE_MAX_CONCURRENT` (default `1`, allowed 1 to 3) sets how many CLI runs may be active at once.
The default keeps the original behaviour: one run, the rest waiting in the FIFO line
(`APAYEE_MAX_QUEUE_SIZE`, default 16, unchanged by this setting).

What the tests show (fake CLI, no model): with 2 or 3 slots every request gets its own process, its
own empty working directory and its own output, cancelling or timing out one run stops only that
process tree, and a readiness probe can run while executions are active without disturbing them.

What is **not established** (unverified runtime considerations, not claims of safety):

- Several real CLI processes share one sign-in and one configuration directory (`HOME`, and
  `CLAUDE_CONFIG_DIR` in the container). Whether the real CLI handles that without trouble, for
  example when its login is refreshed while other runs are active, has not been tried. A bad outcome
  would look like `PROVIDER_NOT_READY` until the next `npm run claude:login`.
- Memory, CPU and process IDs per running CLI have not been measured. Size container limits for the
  slots plus a short extra margin: a run that ignores its abort keeps its process until it exits, and
  the readiness probe starts up to two short CLI processes (about once a minute).
- More parallel runs use the subscription allowance faster, and a usage limit reached by one run is
  likely to be reached by the others. The terms question above is unchanged and matters more as throughput grows.

Raise the setting only for a test you have approved, starting with the smallest requests, and read
`queue.active` and `queue.max_active` in `GET /v1/health` while it runs.

## Readiness

Health shows `provider: "claude"` only when all of these pass; otherwise `claude_not_ready` plus a
`provider_status.state`. Generation then answers `503 PROVIDER_NOT_READY` (not retryable) and does
nothing.

**Stage 1 starts no process** and is checked on every call: disabled, plan not attested, a
conflicting variable, the CLI not found. **Stage 2 starts the CLI twice** (`--version`,
`auth status`): version floor, then the login. Its answer is cached (60 s when ready; when not
ready 15 s, then 30 s, then 60 s while it stays so) and concurrent polls share one probe, so a page
that polls health does not start a process per poll. Health never sends a generation request.

| `state` | Meaning and fix |
| --- | --- |
| `disabled` | `APAYEE_CLAUDE_EXPERIMENTAL` is not `true` |
| `subscription_unconfirmed` | You have not attested the plan: check your account settings, then set the flag |
| `api_environment_conflict` | A variable that bypasses the login or changes which login is used; named in `reason` |
| `cli_not_found` / `cli_unsupported_launcher` | Install the native CLI, or set `APAYEE_CLAUDE_CLI_PATH` |
| `cli_too_old` / `cli_unreadable` | Run `claude update` (needs 2.1.299 or newer) |
| `not_authenticated` | Run `npm run claude:login` |
| `auth_mode_rejected` | Signed in with an API key, helper, token or cloud provider. Only `claude.ai` is accepted |
| `status_unreadable` / `status_unavailable` | `claude auth status` gave no usable answer; run `npm run claude:status` |
| `ready` | |

## Errors

Structured result fields come first (`subtype`, `api_error_status`, `terminal_reason`,
`num_turns`), then the wording from Anthropic's error reference.

| Situation | Apayee error | Retryable |
| --- | --- | --- |
| Not signed in, login expired, HTTP 401/403 | `PROVIDER_NOT_READY` 503 | no |
| Session, weekly, plan or model usage limit | `PROVIDER_RATE_LIMITED` 429, "wait for the limit to reset" | yes, later |
| Temporary throttling (429) | `PROVIDER_RATE_LIMITED` 429, "wait briefly" | yes |
| HTTP 529 overload, 5xx | `PROVIDER_UNAVAILABLE` 503; documented as not counting against a usage limit | yes |
| Request timed out, no response | `PROVIDER_TIMEOUT` 504 | yes |
| Schema attempts used up, turn limit, no structured output, malformed output | `INVALID_PROVIDER_RESPONSE` 502 | yes |
| Anything else | `PROVIDER_UNAVAILABLE` 503 | yes |

## Running Apayee under another account or as a service

Credentials belong to the OS user that logged in. If Apayee runs as a Windows service or under any
other account, **log in under that exact account**, because a login made by a different Windows user
is not visible to it. A service also has a different `PATH`, so set `APAYEE_CLAUDE_CLI_PATH`.
Apayee does not create or select a separate Claude configuration directory. If you use one, set
`CLAUDE_CONFIG_DIR` yourself, approve it with `APAYEE_CLAUDE_PASSTHROUGH_ENV=CLAUDE_CONFIG_DIR`, and
log in with the same value. Native installs update themselves in the background, so the CLI version
can change under a running Apayee; `claude --version` shows it.

## Recovery

| Situation | Do |
| --- | --- |
| Login expired or revoked | `npm run claude:login` again; health notices within a minute at most |
| Wrong account | `claude auth logout`, then `npm run claude:login` |
| Usage limit reached | Wait for the reset. Requests fail with a clear message and are not retried |
| After changing `.env` | Restart Apayee |
| Health says `claude_not_ready` | Read `provider_status.reason`, or run `npm run claude:status` |

## What was verified, and what was not

**Verified by tests here (a fake CLI, no model, no network):** configuration rules, the exact
arguments, request content on stdin only, no shell and no API-key path, the environment allowlist and
every documented override stopping the provider, every readiness state, that unready states start no
process, that health polling does not start a process per poll, structured-output parsing and schema
validation, error classification against the strings in Anthropic's error reference, timeouts,
cancellation, process-tree cleanup and queue release, no retry, no fallback to the mock, and that no
response or log carries prompt or CLI text. Also with the fake: 1, 2 and 3 concurrent runs (distinct
processes, directories and outputs; one run cancelled or timed out while the others continue; a
readiness probe overlapping active runs). The fake's output shapes follow the documentation; they
are not output from a real CLI.

**One real run (2026-11-02, CLI 2.1.316, Windows, owner's own login):** `npm run claude:smoke` sent one
small synthetic request directly to `ClaudeProvider.generate` (not through HTTP or the queue). It
returned schema-valid output in about 7 seconds. The CLI reported `num_turns` 2 for that single
request, with `input_tokens` 2 and `output_tokens` 53 (these probably exclude cached input, so they
under-count real consumption). It confirmed that `--tools ""` does not stop the `--json-schema`
structured answer on that version. The flags above and the `claude auth status` fields worked as
documented. `claude auth status` also showed `apiProvider` and `subscriptionType` fields; they are
undocumented, so Apayee does not rely on them and they do not replace the plan check below.

**Seen in QATOOL's Docker staging work (health only, no generation):** the container's own CLI signed in through the
volume, and QATOOL's backend read `provider: "claude"` and `queue.max_active: 1` from `GET /v1/health` over the internal
network.

**Still not confirmed against the real CLI:** a full generation through Apayee's HTTP endpoint and queue driven by QATOOL
(including the public demo's jobs), concurrency of real runs at any setting, cancellation and timeout of a real run, a larger schema or
prompt than the smoke test's, and how a missing login or a usage limit appears in `json` output. Those paths
are covered only by the fake CLI. If a live run returns `no_structured_output`, suspect the
`--tools ""` restriction first, and do not loosen it without reviewing what would be enabled.

**Not established:** that a given use is permitted (see the third-party terms above), and which plan the account is on.
