# QATOOL × Apayee — Model Provider Selection Audit

> **Historical document.** It describes the state on 2026-10-31, when Apayee had only the mock
> provider ("mock only today" below). The `claude` provider and QATOOL's provider selector have
> been built since; see `README.md`, `CLAUDE.md` and `CLAUDE_PROVIDER.md` for the current state.

Date: 2026-10-31. Read-only audit; nothing in either implementation was changed. This file is the
only thing written.

"**Verified**" means read in code during this audit (file and line given). "**Recommendation**" is
design, not fact. Secret values were not read: QATOOL's `.env` was not opened, only
`.env.example`, `config.js` and validation code.

---

## 0. Summary

- Provider choice in QATOOL is already **resolved per call, not once at boot**, and each stage
  already accepts an injected `provider`. A per-request choice needs **no change to the provider
  abstraction**, only plumbing from the route down.
- Apayee has **exactly one provider per process** (`APAYEE_PROVIDER`, mock only today) and
  deliberately refuses any per-request provider field. "Claude via Apayee" therefore means *the
  operator runs Apayee configured with a Claude provider*. The UI cannot choose it, only use it.
- **Apayee needs no change** for the selector.
- A healthy Apayee does not mean Claude is available. Today `GET /v1/health` reports
  `provider: "mock"`. Availability must be derived from the provider name the gateway reports,
  checked against an allowlist in QATOOL. Until a real Claude provider exists, Claude is
  **disabled, with a reason from the backend**.
- Recommended design: **Option B** (per-run selection, server default unchanged), with an optional
  browser-only remembered preference later. Option A (global switch) is rejected.

---

## 1. Verified current architecture

### QATOOL

| Fact | Where |
|---|---|
| Provider registry: `gemini`, `mock`, `apayee`; lazily imported | `server/llm/provider.js:131-135` |
| `createProvider(settings = config.llm)` already takes settings | `provider.js:148` |
| Provider is created **inside each stage**, per call, unless one is injected | `structure/index.js:117`, `generate/index.js:285`, `semantic/index.js:185` |
| All three stages already accept `{ provider, signal }` (injection seam used by tests) | `structure/index.js:101`, `generate/index.js:255`, `extract/index.js:54`, `semantic/index.js` |
| `config` is a module-level constant read from `process.env` once at import | `server/config.js:22-89` |
| `.env` is loaded by the Node process at start (`--env-file-if-exists=.env`) | `package.json` scripts `start`, `dev:server*` |
| `LLM_PROVIDER` read once, default `gemini` | `config.js:55` |
| Apayee settings are validated at startup **only if** `LLM_PROVIDER=apayee`; reachability never probed | `server/index.js:38-41` |
| Gemini key missing throws `LLM_NOT_CONFIGURED` in the constructor, i.e. at first use | `llm/gemini.js:87-93` |
| Server is stateless. The browser holds the canonical project and posts it to each call | `routes/pipeline.js:18-30` |
| A "run" is **three separate HTTP requests**: `POST /api/extract`, `POST /api/generate`, `POST /api/validate?semantic=true`. The server has no run concept spanning them | `web/src/pipeline.js`, `routes/pipeline.js` |
| No request carries a provider field today. `requireCanonical` copies only `project/documents/requirements/test_cases`, so extra top-level body keys are ignored | `pipeline.js:231-246` |
| QATOOL's own API has **no authentication and no CORS code**; it relies on binding `127.0.0.1` | `config.js:24`, no auth hooks in `server/app.js` |
| `GET /api/health` returns only `{status, stateless, time}`. No LLM information | `routes/meta.js:24-28` |
| Frontend: `api.js` (fetch wrappers), `pipeline.js` (runs the 3 phases through an injected `api`), `ProcessingStage.jsx` (retry resumes at the failed phase), `UploadStage.jsx` (project name + files). **No settings UI.** Results already display `generation.metadata.provider/model` and `semantic status.provider/model` | `web/src/**`, `ResultsStage.jsx:196,589` |
| Vite proxies `/api` to `127.0.0.1:3001`; the browser never contacts a provider | `web/vite.config.js` |

Failure behaviour per stage (**verified**):

| Stage | Provider failure (including not configured, Apayee offline) |
|---|---|
| Structuring (inside `/api/extract`) | **Fail-soft.** Any `AppError`, including `LLM_NOT_CONFIGURED`, is caught and the run continues with deterministic extraction plus a warning (`structure/index.js:116-117, 220-251`) |
| Generation (`/api/generate`) | **Hard failure.** Traced and rethrown (`generate/index.js:315-330`) |
| Semantic review (`/api/validate?semantic=true`) | **Fail-soft but reported** in `semantic.llm = failed`, deterministic findings still returned |

Consequence for this feature: if a user picks an unavailable provider and nothing checks first,
extraction would **silently degrade to deterministic mode**, the same way a missing Gemini key does
today. A provider selector must check availability **before** running a stage.

### Apayee

| Fact | Where |
|---|---|
| One provider per process, chosen by `APAYEE_PROVIDER` (default `mock`), built once in `buildApp` | `src/config.js:98`, `src/app.js:18` |
| Registry is a fixed table, `mock` only. "Nothing in a request can reach this table" | `src/providers/registry.js:10-12` |
| `/v1/generate` body is `additionalProperties: false`: no provider/model field can be sent | `src/validation/request.js:20` |
| Routes: `GET /v1/health`, `POST /v1/generate` only | `src/app.js:86-88` |
| Health returns `status`, `service`, `version`, `provider` (the active provider's `name`), and queue stats | `src/routes/health.js` |
| Mock provider's name is `'mock'` | `src/providers/mock/mock.provider.js:31` |
| Bearer token, when `APAYEE_AUTH_TOKEN` is set, is an `onRequest` hook on **all** routes, so `/v1/health` needs it too | `src/app.js:45` |
| Requests carrying an `Origin` header are rejected, so **a browser cannot call Apayee directly**; QATOOL's server must be the caller | `middleware/authentication.js:32-34` |
| Non-loopback host requires `APAYEE_ALLOW_REMOTE=true` and a token of at least 32 characters | `src/config.js:62-80` |
| README states the intent: clients cannot choose providers | `README.md` (Security, "No execution paths") |

---

## 2. Existing configuration

### QATOOL (owner: QATOOL; every setting is **startup-only**)

| Variable | Default | Used when | Notes |
|---|---|---|---|
| `LLM_PROVIDER` | `gemini` | always | `gemini`, `mock`, `apayee`; normalised lower-case |
| `GEMINI_API_KEY` | empty | gemini | Missing: `LLM_NOT_CONFIGURED` on first use |
| `GEMINI_MODEL` | `gemini-3.8-flash` | gemini | |
| `GEMINI_BASE_URL` | Google v1beta | gemini | |
| `LLM_TIMEOUT_MS` | `120000` | gemini, apayee | For Apayee it is sent as the *execution* budget and must not exceed Apayee's `APAYEE_MAX_TIMEOUT_MS` |
| `LLM_MAX_OUTPUT_TOKENS` | `32768` | gemini | |
| `LLM_TEMPERATURE` | unset | gemini | |
| `APAYEE_BASE_URL` | `http://127.0.0.1:4100` | apayee | Validated: http(s) only, no credentials/query/fragment. Path prefix kept |
| `APAYEE_TOKEN` | empty | apayee | Required unless host is loopback. Header-safe characters only |
| `APAYEE_QUEUE_WAIT_MS` | `60000` | apayee | Deadline = `LLM_TIMEOUT_MS + APAYEE_QUEUE_WAIT_MS` |
| `HOST` / `PORT` | `127.0.0.1` / `3001` | always | |

### Apayee (owner: Apayee; startup-only, validated, invalid values stop the process)

`APAYEE_HOST` (`127.0.0.1`), `APAYEE_PORT` (`4100`), `APAYEE_ALLOW_REMOTE` (`false`),
`APAYEE_AUTH_TOKEN` (unset; ≥32 chars, not a placeholder), `APAYEE_PROVIDER` (`mock`),
`APAYEE_MAX_QUEUE_SIZE` (16), `APAYEE_MAX_QUEUE_WAIT_MS` (600000), `APAYEE_DEFAULT_TIMEOUT_MS`
(180000), `APAYEE_MAX_TIMEOUT_MS` (600000), `APAYEE_ABORT_GRACE_MS`, `APAYEE_SHUTDOWN_TIMEOUT_MS`,
`APAYEE_MAX_BODY_BYTES`, `APAYEE_MAX_SCHEMA_BYTES`, `APAYEE_LOG_LEVEL`.

### Questions asked

- **Startup-only:** every setting above. Neither project reloads configuration.
- **Safe to change per request:** none of the *settings*. What can be per request is the *choice
  among already-configured providers*. Keys, URLs, tokens and timeouts stay startup-only.
- **Does changing `LLM_PROVIDER` need a QATOOL restart?** Yes (`config.js:55` is evaluated once).
  Restart also kills any in-flight request; the UI already explains that (`api.js` NO_RESPONSE).
- **Can a provider change affect an active generation?** Not today, because nothing changes at
  runtime. With the recommended design, the provider is resolved **once per HTTP request** and
  injected, so a later selection cannot affect a request already running. Across the three requests
  of one run, consistency has to be enforced by the browser (see §5).
- **How is availability detected today?** It is not. Gemini key presence is found at first use;
  Apayee settings at startup if selected; Apayee reachability only when a call is made.
- **Apayee offline today:** adapter maps connection failure to `LLM_UNAVAILABLE`, HTTP 502, "Could
  not reach Apayee at <origin> (<code>). Check that it is running and that APAYEE_BASE_URL is
  correct." Structuring falls back to deterministic extraction with a warning; generation fails
  with that message; semantic review reports `llm: failed`.

---

## 3. Required QATOOL backend changes (recommendation)

1. **`server/llm/catalog.js` (new).** A fixed allowlist, not derived from the registry or from
   client input:
   `gemini → { label: 'Gemini', registryKey: 'gemini' }`,
   `claude → { label: 'Claude (via Apayee)', registryKey: 'apayee', requiresGatewayProvider: 'claude' }`.
   Client-visible ids are catalog ids only. `mock` and the raw `apayee` registry key are never
   accepted from a client.
2. **`server/llm/provider.js`.** Add a small `providerFor(choiceId)` that calls the existing
   `createProvider({ ...config.llm, provider: entry.registryKey })`. `createProvider`'s signature is
   unchanged.
3. **`server/llm/apayee.js`.** Add a gateway probe: `GET {base}/v1/health` with the bearer token,
   the same `node:http`/`agent:false` approach, short timeout (about 2 s), returning
   `{ online, status, providerName }`. Reuses `validateApayeeSettings`.
4. **`GET /api/llm/providers` (new route, in `routes/meta.js` or a small `routes/llm.js`).** See §7.
5. **`routes/pipeline.js`.** Read `provider` from the query string on all three routes, resolve it
   once, **check availability before the stage runs**, and pass `provider` to
   `extractDocuments` / `generateFromRequirements` / `reviewSemantics`. A missing parameter means
   the server default, so existing clients are unchanged.
6. **`server/config.js`.** No new secrets. The server default stays `LLM_PROVIDER`. Optionally map
   the default to a catalog id.
7. **Startup validation.** Today it only runs for `LLM_PROVIDER=apayee`. With per-request choice,
   a bad `APAYEE_BASE_URL` would first surface when someone selects Claude. Recommendation: do not
   crash a Gemini-default server for it; report it as `misconfigured` in the providers response
   and log it once at startup.
8. **No cross-provider fallback.** A failing provider never retries on another one. The user chose
   it, and mixing silently would also hide where data went.
9. **Unchanged:** prompts, schemas, extraction, generation, traceability, XLSX, cancellation (the
   signal path is independent of which provider is used).

## 4. Required QATOOL frontend changes (recommendation)

- `web/src/api.js`: `api.providers()` for `GET /api/llm/providers`; `extract/generate/validate`
  take an optional `provider` and append `?provider=<id>` (the existing `?semantic=true` pattern).
- `web/src/pipeline.js`: `runPipeline({ …, provider })` forwards it to every phase call. The `api`
  object is already injected, so unit tests need no network.
- `web/src/App.jsx`: hold `provider` in `Wizard` state next to `files` (it is session state, not
  project data; it must **not** enter the canonical object, whose schema is strict).
- `web/src/stages/UploadStage.jsx`: an "AI provider" card with a select. Options come from the
  backend response; unavailable ones are shown **disabled with their reason**, not hidden.
- `web/src/stages/ProcessingStage.jsx`: pass the pinned provider to every run and retry. Selection
  is **locked once Processing starts**; switching means going back to Upload. RETRY_ADVICE needs one
  entry for the new "provider unavailable" code.
- `ResultsStage` already prints provider and model; no change needed.
- If the providers request fails, fall back to the server default: omit the parameter and show a
  neutral "Using the server's default provider" note, not a broken selector.

---

## 5. Provider-selection architecture: options compared

| | A. Global server config | B. Per-run selection | C. Saved preference + per-run override |
|---|---|---|---|
| What it is | UI changes a server-wide setting | Selection travels with each request | B plus a remembered default |
| Complexity | Low UI, but needs mutable server state and an admin endpoint | Low-medium: routes + 3 call sites + select | B + a few lines |
| Abstraction change | Needs mutable `config` or a registry swap, contradicts "no dynamic env mutation" | None. `createProvider(settings)` and stage `provider` option already exist | None |
| Concurrent runs | **Unsafe**: one user's switch changes another's in-flight stages (`createProvider` is called per stage) | Safe: resolved per request, no shared state | Same as B |
| Restart | No (but state lost on restart) | No | No |
| Security | QATOOL has **no authentication**; anyone able to reach it could flip the provider for everyone. Worst case, documents go to a different vendor | Allowlisted id only; no credentials cross the API | Preference stays in one browser |
| Fits stateless design | No | Yes | Yes if browser-only |

**Recommendation: B**, with the server default (`LLM_PROVIDER`) as the initial value. Add C only
if wanted, and only as `localStorage` in the browser (wrapped in try/catch, as the app's other
conveniences would be). QATOOL stores nothing server-side and should not start.

**One provider per run.** Three requests make a run, so consistency lives in the browser: the
choice is pinned when Processing starts and used for all three calls and for retries. Stage results
already record the provider (`structuring.status.provider`, `generation.metadata.provider`,
`semantic status.provider`), which makes a mixed run visible.

---

## 6. Availability rule (Claude is not ready)

Verified: Apayee has only a mock provider, and its health says so (`provider: "mock"`).
`LLM_PROVIDER=apayee` today reaches a mock whose output QATOOL cannot use (README: structuring
falls back, generation ends in `GENERATION_EMPTY`).

Rules (recommendation):

- Never route a "Claude" selection to the mock. The `claude` catalog entry is **available only
  when** the gateway is reachable, authenticated, healthy (`status: "ok"`), **and** reports
  `provider === 'claude'` (the exact name is a decision, §12). `mock` or any other name means
  *not available*.
- Distinguish reasons so the UI is honest:

| `reason` | Meaning | UI text (example) |
|---|---|---|
| `not_configured` | Gemini key missing, or Apayee settings invalid | "Not configured on the server" |
| `gateway_offline` | Cannot reach Apayee | "Apayee is not running or not reachable" |
| `gateway_auth_failed` | Apayee rejected `APAYEE_TOKEN` | "Apayee rejected the server's token" |
| `provider_not_ready` | Gateway online but its provider is not Claude (today: mock) | "Apayee is running, but Claude is not enabled on it" |
| `gateway_shutting_down` | health status not ok | "Apayee is shutting down" |

- **Disabled, not hidden, not "coming soon".** Hard-coding "coming soon" would need a UI release
  when Claude arrives. With a backend-driven reason, the option turns on by itself the moment the
  gateway reports a Claude provider. Until then it renders disabled with `provider_not_ready`.
- The check is **advisory for the UI and enforced again on the server** for every request
  (a request can race a gateway restart). An unavailable choice is refused before the stage
  starts, never degraded silently.
- Gateway online ≠ model available: do not use the word "online" for Claude, only for the gateway.
- Authorization to use a Claude subscription through Apayee is **out of scope and not assumed**.

---

## 7. Suggested API contracts

### `GET /api/llm/providers` (new, read-only, no secrets)

```json
{
  "default": "gemini",
  "providers": [
    { "id": "gemini", "label": "Gemini", "available": true, "reason": null, "message": null },
    { "id": "claude", "label": "Claude (via Apayee)", "available": false,
      "reason": "provider_not_ready",
      "message": "Apayee is running, but Claude is not enabled on it." }
  ]
}
```

- No URLs, tokens, key presence beyond a boolean outcome, or model strings.
- The probe uses a ~2 s timeout, single-flight, and a short cache (about 5 s) so reloads do not
  spam the gateway.
- `default` is the catalog id for the server's `LLM_PROVIDER`.

### Selection in the pipeline routes

```text
POST /api/extract?provider=claude          (multipart; unchanged body)
POST /api/generate?provider=claude         (JSON body unchanged)
POST /api/validate?semantic=true&provider=claude
```

A query parameter is used rather than a form field because `/api/extract` reads only file parts
(`request.files()`) and `/api/validate` already uses `?semantic=true`. A request header
(`X-QATOOL-Provider`) would also work and is the alternative.

| Case | Result |
|---|---|
| `provider` absent | Server default. **Backward compatible** |
| Unknown id (including `mock`, `apayee`, arbitrary strings) | `400 UNKNOWN_PROVIDER` |
| Known but unavailable | Refused before any work, reusing existing codes where they fit: `LLM_NOT_CONFIGURED` / `LLM_UNAVAILABLE` / `LLM_AUTH_FAILED`, with a message naming the reason, never the URL or token |
| Available | Run; the same instance is passed to the stage |

The id is only ever used as a key into the fixed catalog, never as a module path, URL, header or
Apayee field. Apayee's own request contract is unchanged and still rejects unknown fields.

### Routing

- `gemini` → existing `GeminiProvider` directly. Key stays in QATOOL's process.
- `claude` → existing `ApayeeProvider` → Apayee `POST /v1/generate` → whichever provider Apayee was
  started with (a future `APAYEE_PROVIDER=claude`).

---

## 8. Does Apayee need changes?

**No.** Specifically not:

- Do **not** add a provider/model field to `/v1/generate`. The README and
  `additionalProperties: false` make that a deliberate property.
- For the selector to work, a real Claude provider (separate future work) only has to register
  under a **stable `name`** (health exposes `provider.name`).

Optional, deferred until a real provider exists: an additive readiness field on health (for
example whether the provider can currently accept work), so "gateway up, provider logged out" can
be told apart from "provider ready". Without it QATOOL shows `claude` as available whenever the
name matches, and a failed call reports normally.

---

## 9. Configuration and deployment

### Gemini mode (default)

```ini
# QATOOL .env
LLM_PROVIDER=gemini
GEMINI_API_KEY=<set on the QATOOL server only>
```

Restart QATOOL after any change. Apayee is not involved. The UI shows Claude unavailable
(`gateway_offline` or `provider_not_ready`) and Gemini available.

### Apayee on the same PC

```ini
# Apayee .env (Apayee process)
APAYEE_HOST=127.0.0.1
APAYEE_PORT=4100
APAYEE_PROVIDER=mock        # a future Claude provider name goes here; restart Apayee

# QATOOL .env
LLM_PROVIDER=gemini          # server default; the UI selection overrides per run
APAYEE_BASE_URL=http://127.0.0.1:4100
# APAYEE_TOKEN optional on loopback
APAYEE_QUEUE_WAIT_MS=60000
```

Start Apayee first, then QATOOL. `127.0.0.1` rather than `localhost` avoids an IPv6 `::1`
mismatch on Windows (seen with Vite in earlier work).

### Apayee on a separate PC, private network

```ini
# Apayee .env (the Apayee machine)
APAYEE_HOST=<its private address, not 0.0.0.0>
APAYEE_ALLOW_REMOTE=true
APAYEE_AUTH_TOKEN=<32+ chars, generated once, never committed>
APAYEE_PROVIDER=<future real provider>

# QATOOL .env (the QATOOL machine)
APAYEE_BASE_URL=http://<apayee-private-address>:4100
APAYEE_TOKEN=<the same value>
```

- Allow only the QATOOL machine in the firewall; do not forward the port.
- Plain HTTP carries prompts, results and the token unencrypted: private network, VPN or TLS tunnel.
- QATOOL refuses to start Apayee mode with a non-local URL and no token; Apayee refuses remote
  access without one.
- Browsers never talk to Apayee (Origin rejection). Only QATOOL's server does, so the browser does
  not need a route to that machine.

### Ownership and restarts

| Change | Owner | Process to restart |
|---|---|---|
| `LLM_PROVIDER`, `GEMINI_*`, `APAYEE_BASE_URL`, `APAYEE_TOKEN`, `APAYEE_QUEUE_WAIT_MS`, `LLM_TIMEOUT_MS` | QATOOL | QATOOL server (Vite not needed) |
| `APAYEE_HOST/PORT/ALLOW_REMOTE/AUTH_TOKEN/PROVIDER/*_TIMEOUT_*` | Apayee | Apayee |
| Token rotation | Both | Both, same value |
| Which provider a **run** uses | The user, in the UI | None |

### Health-check and failures

- Providers endpoint (new) probes `GET /v1/health` with the token; offline → `gateway_offline`
  within about 2 s; 401 → `gateway_auth_failed`.
- During a run, failures use the existing mapping (§2). The abort/cancel path already releases the
  Apayee queue slot.
- Apayee dying **mid-run** after a good probe is handled by the existing per-call errors: no change.

---

## 10. File-by-file plan (recommendation, in order)

**QATOOL**

1. `server/llm/catalog.js` — new: allowlist, `resolveChoice`, labels.
2. `server/llm/apayee.js` — add `probeGateway(settings, {signal})`.
3. `server/llm/provider.js` — `providerFor(choiceId)`.
4. `server/llm/availability.js` — new: builds the response, cache and single-flight.
5. `server/routes/meta.js` (or `routes/llm.js`) — `GET /api/llm/providers`.
6. `server/routes/pipeline.js` — parse/validate `provider`, pre-check, pass `provider` down.
7. `server/index.js` — log configuration problems for Apayee once even when not default.
8. `.env.example`, `README.md` (§ Apayee), this behaviour documented.
9. `web/src/api.js`, `web/src/pipeline.js`, `web/src/App.jsx`, `web/src/stages/UploadStage.jsx`,
   `web/src/stages/ProcessingStage.jsx`, `web/src/styles.css` (select + disabled reason).

**Apayee:** none.

---

## 11. Regression risks and test plan

| Risk | Mitigation / test |
|---|---|
| Existing clients and tests stop working | `provider` absent = today's behaviour; run the full existing suite unchanged |
| Silent deterministic fallback when an unavailable provider is selected | Route test: unavailable choice → refused **before** `extractDocuments` runs; no `deterministic_fallback_used` |
| Mixed-provider run | Frontend test: pinned provider appears on all 3 calls and on retries; selector locked during Processing |
| Client injects `mock`, `apayee`, `__proto__`, paths | Allowlist test with `Object.hasOwn`; 400 for all |
| Credential or URL leakage in the providers response or errors | Assert JSON contains no token, key, URL; `redactSecrets` coverage extended |
| Probe floods Apayee or hangs the page | Timeout, cache, single-flight tests with a fake gateway |
| Cancellation regression | Existing cancellation suite must pass for both choices; add one test per choice |
| Gemini default changes | Snapshot: default path calls Gemini stub exactly as today; no-network guard stays on |
| Mock mistaken for Claude | Test: gateway reporting `provider: "mock"` → `provider_not_ready`, selection refused |
| Real-Claude behaviour | Cannot be tested now. Do not claim it. Gateway-level tests use Apayee's `MockProvider` named differently, only to exercise the name-matching logic |

Test layers: unit (catalog, availability), route (`inject`, fake gateway from
`server/llm/fixtures/fake-apayee.js`), frontend (`pipeline.test.js` with injected `api`), and the
existing opt-in Apayee smoke test. A browser check of the selector can reuse the CDP script
approach from the previous task.

---

## 12. Unresolved decisions

1. **Provider id and name for Claude.** Catalog id `claude` is proposed. What `name` will the
   future Apayee provider report (`claude`?). QATOOL's match depends on it.
2. **What label does an Apayee dev setup get?** With `LLM_PROVIDER=apayee` and a mock gateway
   (today's test mode), is the default shown as a distinct "Apayee (test provider)" entry, or kept
   env-only and not offered in the UI? Recommendation: env-only, shown only if it is the server
   default.
3. **Should `mock` ever be in the UI?** Recommendation: only when it is the server default.
4. **Switching provider after a failed run.** Locked until Upload (recommended) vs allowing
   "retry generation with the other provider", which makes a mixed run.
5. **Timeout per provider.** `LLM_TIMEOUT_MS` is shared. A subscription-backed Claude path may need
   a different budget.
6. **Result labelling.** Today an Apayee run reads "Drafted by Apayee (apayee-gateway)". Should it
   name the underlying provider reported by the gateway?
7. **Authentication for QATOOL itself.** It has none. That is safe on loopback; if QATOOL is ever
   exposed to a LAN, add authentication *before* anything more sensitive sits behind it.
8. **Remembered preference (Option C).** Wanted at all, and browser-local only?
9. **Apayee readiness field.** Add an additive health field when the real provider lands?
10. **Authorization to use a Claude subscription through Apayee** remains a separate policy
    decision, deliberately not covered here.
