# Environment snapshot

A record of the environment this project was set up and checked in, for troubleshooting, compatibility
checks and quick recovery. Machine-readable twin: [ENVIRONMENT_SNAPSHOT.json](ENVIRONMENT_SNAPSHOT.json).

- **Captured:** 2026-11-03, on the Windows PC the project was set up on.
- **Source of truth for dependencies:** `package-lock.json`. This file lists direct dependencies only.
- **Not a recommendation to pin or downgrade.** It says what was observed and what was checked. Where
  something was not checked, it says so. Update both snapshot files when you deliberately change a
  runtime or dependency version.
- **Contains no secrets and no account identity.** Authentication is recorded as a status only.

## 1. Evidence levels used below

| Label | Meaning |
| --- | --- |
| **Observed** | Read from the machine on the capture date |
| **Verified** | A check that exercises the project passed with this version (the check is named) |
| **Minimum** | Required by `package.json`, the code or the docs; below this the project refuses or is unsupported |
| **Suspected** | Evidence of a problem exists (cited). None of the observed versions is in this group |
| **Untested** | Nothing was run with it. Not evidence of a problem |

## 2. System

| Item | Observed |
| --- | --- |
| OS | Windows 11 Pro, version 10.0.26300 (build 26300), 64-bit |
| CPU / RAM | AMD Ryzen 5 7500F (6 cores, 12 threads), 15.6 GB |
| Node architecture | x64, platform `win32` |
| Shell used for setup | Windows PowerShell 5.1.26100.9711 (Git Bash is also available) |

## 3. Toolchain

| Tool | Observed | Where / how installed | Minimum | Verified with |
| --- | --- | --- | --- | --- |
| Node.js | 22.15.0 (V8 12.4.254.21-node.24) | `C:\Program Files\nodejs\node.exe`, a real directory, not managed by nvm | 22.13.0 (`engines`) | `npm ci`, `npm test`, `npm start` + health, 2026-11-03 |
| npm | 11.6.4 | User-level install in `%APPDATA%\npm\node_modules\npm` (npm's own config path shows this), so it is not the npm bundled with Node | none declared; lockfile is `lockfileVersion` 3 | `npm ci`, `npm ls`, 2026-11-03 |
| Git | 2.48.1.windows.1 | on PATH | none | `git status`, `git rev-parse` |
| Claude Code CLI | 2.1.316 | Anthropic's official native installer (`install.ps1`), run 2026-11-03 | 2.1.299 (`docs/CLAUDE_PROVIDER.md`) | see section 4 |
| nvm-windows | 1.1.11, installed; lists only Node 23.11.0 | on PATH | not required | Not used for the active Node |
| winget | present | on PATH | not required | Not used |

Not used by this project: Docker. There is no `Dockerfile` or compose file in the repository.
Docker was present on the machine and is recorded only for completeness (section 9).

## 4. Claude Code CLI

| Item | Value |
| --- | --- |
| Version | 2.1.316 (Claude Code) |
| Install method | Official native installer for Windows (`install.ps1` from `claude.ai`; the script was downloaded and read first, then run). It checks a SHA-256 from Anthropic's manifest |
| Location | `%USERPROFILE%\.local\bin\claude.exe` (about 335 MB) |
| PATH | `%USERPROFILE%\.local\bin` was added to the **User** PATH on 2026-11-03. Terminals and editors opened before then do not see it. Apayee also sets `APAYEE_CLAUDE_CLI_PATH` to the absolute path, so it does not depend on PATH |
| Authentication | Signed in; `loggedIn: true`, `authMethod: claude.ai`, `apiProvider: firstParty`. No account identity recorded here |
| API-key / cloud environment variables | None set (checked by variable name with the project's own conflict check) |
| Updates | Native installs update themselves in the background, so the version can change under a running Apayee |
| Other copy on the machine | The VS Code extension bundles its own `claude.exe` (2.1.314 at capture time) inside a version-named extension folder. Apayee does not use it. It shares the same `~/.claude` login store as the standalone CLI |

**Caution.** The raw output of `claude auth status` includes an email address and organization
identifiers. When documenting or sharing it, read only the fields you need:

```powershell
$a = & "$env:USERPROFILE\.local\bin\claude.exe" auth status | ConvertFrom-Json
"loggedIn=$($a.loggedIn) authMethod=$($a.authMethod)"
```

## 5. Project technology stack

ES modules, no build step, no TypeScript, no linter. Fastify 5 (Pino logging), Ajv 8 with ajv-formats,
`node:test` for tests. No database or broker; nothing is persisted. See `README.md`.

## 6. Dependencies

`package-lock.json` (lockfile version 3, registry `registry.npmjs.org` only) is authoritative. It holds
49 packages, all production, none dev. `npm ls --depth=0` and the lockfile agree.

| Package | Range in `package.json` | Locked and installed |
| --- | --- | --- |
| `fastify` | `^5.12.7` | 5.12.7 |
| `ajv` | `^8.20.0` | 8.20.0 |
| `ajv-formats` | `^3.0.1` | 3.0.1 |

| Integrity item | Value |
| --- | --- |
| `package-lock.json` SHA-256 | `a315135b0c0d74f30d5f63f1fb2b99485d632d79191503649784108ce95be1cd` |
| `package.json` SHA-256 | `be00260a39f63d45816531f8330bb86a7bd4ff3488c44f7cccc37f003d50ccd2` |
| Git commit | `4cf403552777e51b249db734ccd0979a180d4011` (branch `main`, "chore: initial project setup") |
| Working tree at capture | Tracked files clean. One untracked file: `.env.example` (see section 10). The two snapshot files, and the small links added to `README.md` and `CLAUDE.md`, came after this capture |

Dependency-install configuration: no project `.npmrc` and no user `.npmrc`; npm's only non-default
setting is the global `prefix` (`%APPDATA%\npm`). Locked packages declare Node engine floors of at most
`>=22` (`cookie`) and the project's own `>=22.13.0`, so the project floor is the binding one.

Check that the lockfile is unchanged:

```powershell
(Get-FileHash package-lock.json -Algorithm SHA256).Hash.ToLower()
```

## 7. Package manager and install commands

```powershell
npm ci                    # exact install from the lockfile; does not edit it
npm ls --depth=0          # expect fastify 5.12.7, ajv 8.20.0, ajv-formats 3.0.1
```

Use `npm ci`, not `npm install`, when recovering: `npm install` may rewrite the lockfile.

## 8. Configuration, ports and runtime settings

Names and status only. Values are never recorded here. `.env` is Git-ignored; `.env.example` documents
every variable.

| Variable | Status at capture |
| --- | --- |
| `APAYEE_HOST` | set, loopback (`127.0.0.1`) |
| `APAYEE_PORT` | set, `4100` (also the code default) |
| `APAYEE_AUTH_TOKEN` | set (random, generated locally; must equal QATOOL's `APAYEE_TOKEN`) |
| `APAYEE_PROVIDER` | set, `claude` |
| `APAYEE_CLAUDE_EXPERIMENTAL` | set, `true` |
| `APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED` | set, `false`. The owner's own attestation; not made when this was written |
| `APAYEE_CLAUDE_CLI_PATH` | set, absolute path to `claude.exe` |
| All other `APAYEE_*` variables | unset, code defaults apply (see `README.md`, "Configuration") |

Listens on `http://127.0.0.1:4100`. Queue: one active execution, 16 waiting. Defaults: execution timeout
180 s, maximum 600 s, Claude ceiling 300 s. Process environment variables override `.env`.

## 9. Docker and WSL (recorded only; nothing was installed)

| Item | Observed |
| --- | --- |
| Docker Desktop | 4.97.0.244584 |
| Docker Engine | client 29.9.2, server 29.9.2 (linux/amd64), answering at capture |
| Docker Compose | v5.6.1 |
| WSL | 2.6.3.0, kernel 6.6.87.2-1, WSLg 1.0.71; default version 2 |
| WSL distributions | `docker-desktop` only, version 2. Its state read "Stopped" in `wsl -l -v` although the Docker server answered. Recorded as observed, not explained |

Apayee does not use any of these.

## 10. Commands

| Purpose | Command |
| --- | --- |
| Install | `npm ci` |
| Offline test suite (fake CLI, network guard; no model request, no quota) | `npm test` |
| Start | `npm start` (`node --env-file-if-exists=.env src/server.js`) |
| Stop | `Ctrl+C` in its terminal (graceful). Avoid `Stop-Process -Force` while a request runs |
| Claude readiness (starts the CLI twice, no model request; needs both Claude flags `true`) | `npm run claude:status` |
| Health | see below |
| Build / lint | none exist |

Health check without printing the token:

```powershell
$t = ((Get-Content .env) | Where-Object { $_ -like 'APAYEE_AUTH_TOKEN=*' }) -replace '^APAYEE_AUTH_TOKEN=',''
Invoke-RestMethod http://127.0.0.1:4100/v1/health -Headers @{ Authorization = "Bearer $t" }
```

Expected: `status: ok`. `provider` is `claude` only when Claude is ready; with the attestation off it reads
`claude_not_ready` (`state: subscription_unconfirmed`), which is the state at capture.

Never run for routine checks: `npm run claude:smoke` (sends one real request and uses subscription quota).

## 11. Version status

**Verified working** (what was run, 2026-11-03, Node 22.15.0 / npm 11.6.4 / Windows 11 build 26300):

- `npm ci`: 49 packages, 0 vulnerabilities reported.
- `npm test`: 262 tests, 260 passed, 0 failed, 2 skipped. Both skips are guarded by
  `process.platform === 'win32'` (`tests/lifecycle.test.js`, `tests/claude-provider.test.js`). Uses the fake CLI.
- `npm start`: bound only to `127.0.0.1:4100`; `GET /v1/health` returned 401 without the token and 200 with it;
  stopped cleanly afterwards.
- Claude CLI 2.1.316: `--version` and `auth status` reported as in section 4. Readiness stage 2 was **not**
  run through Apayee, because the attestation flag is off.

**Previously verified, not re-run here** (stated by `docs/CLAUDE_PROVIDER.md`): on 2026-11-02 one
`npm run claude:smoke` request, sent directly to `ClaudeProvider.generate` on CLI 2.1.316, returned schema-valid
output (`num_turns` 2). That is the same CLI version as now.

**Minimum required:** Node 22.13.0; Claude CLI 2.1.299 (below it the provider reports `cli_too_old`).

**Suspected problems:** none of the observed versions. Known behavioural risks are in section 12.

**Untested:**

- Node other than 22.15.0, including Node 23.11.0 (installed under nvm-windows but not active) and Node 24 or newer. The `engines` range permits them.
- npm other than 11.6.4, including the npm bundled with Node 22.15.0. The lockfile format (v3) is supported by npm 7 and later, but `npm ci` was not run with another npm here.
- Any Claude CLI other than 2.1.316 (between 2.1.299 and 2.1.316, or newer).
- Newer versions of the three direct dependencies, or a fresh `npm install` that re-resolves ranges.
- Operating systems other than this Windows 11 build.
- A request through Apayee's HTTP endpoint and queue to the real CLI, concurrency, real timeouts, larger schemas, and a live QATOOL run.

## 12. Known compatibility issues and limitations

1. **Timing-sensitive test.** On a heavily loaded Windows machine, "the provider's own ceiling ends a run that hangs"
   has failed in a full run and passed alone (`README.md`). It passed in the full run on 2026-11-03.
2. **CLI version drift.** The native CLI auto-updates. Apayee reads the version during readiness probes and
   refuses one below 2.1.299, but it has no upper bound and has been exercised against 2.1.316 only. If Claude requests
   start failing after an update, compare `claude --version` with this file before changing code.
3. **`--tools ""` and structured output.** It worked on 2.1.316. If a live run returns `no_structured_output`,
   suspect that flag first (`docs/CLAUDE_PROVIDER.md`). Do not loosen it without reviewing what it would enable.
4. **`.cmd` launchers are refused.** An npm-installed `claude.cmd` cannot be started without a shell. Use the native
   `claude.exe` or set `APAYEE_CLAUDE_CLI_PATH`.
5. **Undocumented CLI fields.** `apiProvider` and `subscriptionType` in `claude auth status` are undocumented. Apayee
   does not rely on them, and neither proves the plan.
6. **PATH.** Sessions started before the User PATH change do not find `claude`. Restart the terminal or VS Code.
7. **Two Node-related facts that could surprise a recovery.** nvm-windows is installed and would, on `nvm use`,
   try to link `C:\Program Files\nodejs`, which is currently a real directory. Whether that fails or replaces it was not
   tested. Separately, npm 11.6.4 is a user-level install, so reinstalling Node does not restore it.
8. **`.env.example` was missing** from the initial commit even though the docs, `.gitignore` and a test refer to it.
   It was reconstructed on 2026-11-03 and is untracked. If it is lost, a documentation test fails.
9. **Policy.** Whether scripted use of a consumer subscription is permitted is unconfirmed
   (`docs/CLAUDE_PROVIDER.md`). Technical success is not permission.
10. **By design:** no TLS, queue lost on restart, one active execution; `pattern` is refused in schemas.

## 13. Recovery procedure

Work in this order and stop when the problem is gone. Change one thing at a time.

**Step 0. Find out what changed.**

```powershell
node --version; npm --version; git --version
& "$env:USERPROFILE\.local\bin\claude.exe" --version
git rev-parse HEAD; git status --short
(Get-FileHash package-lock.json -Algorithm SHA256).Hash.ToLower()
```

Compare with sections 3, 4 and 6. A different lockfile hash means dependencies changed (`git diff package-lock.json`).
If the hash matches, `npm ci` gives back the same dependency tree.

**Step 1. Dependencies.** Does not touch Node, npm or the CLI:

```powershell
Remove-Item -Recurse -Force node_modules
npm ci
npm ls --depth=0
npm test
```

If the lockfile itself was altered: `git checkout -- package-lock.json package.json`, then repeat.

**Step 2. Node.js.** Restore 22.15.0 (anything 22.13 or newer meets the minimum; 22.15.0 is the one verified).
Available options, none of them run during this capture and none installed here:

- *nvm-windows (already installed, 1.1.11):* `nvm install 22.15.0`, then `nvm use 22.15.0` (usually needs an
  administrator terminal). Read the caveat in section 12, item 7 first.
- *winget (already installed):* `winget search OpenJS.NodeJS` shows what is available; `winget install OpenJS.NodeJS.LTS --version 22.15.0` if that version is offered.
- *Direct download:* the Windows x64 installer for v22.15.0 from <https://nodejs.org/dist/v22.15.0/>.

Afterwards open a new terminal, confirm `node --version`, and repeat Step 1.

**Step 3. npm.** If npm differs from 11.6.4:

```powershell
npm install -g npm@11.6.4
```

This is the only place a global install is suggested. It restores the recorded user-level npm.

**Step 4. Claude Code CLI.** `claude update` moves forward. To return to the recorded version, the official
installer accepts a version argument (its parameter accepts `stable`, `latest` or an exact version): download
`https://claude.ai/install.ps1`, read it, and run it with `2.1.316`. Whether a pinned version then resists
auto-update is not verified here. Then:

```powershell
& "$env:USERPROFILE\.local\bin\claude.exe" --version
npm run claude:status
```

**Step 5. Configuration.** Recreate `.env` from `.env.example` if lost. Generate a **new** token
(`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`), give it to QATOOL as
`APAYEE_TOKEN`, and set the Claude flags as in section 8. Sign in again with `npm run claude:login` if
the status says not authenticated.

**Step 6. Verify** with section 10: `npm test`, `npm start`, health. If the check passes, update both snapshot
files with the new versions and the date, and say what was run.

Do not downgrade dependencies or the CLI to "fix" a symptom without first reproducing it against the recorded
versions. If the recorded versions also fail, the cause is elsewhere (configuration, login, quota, network).
