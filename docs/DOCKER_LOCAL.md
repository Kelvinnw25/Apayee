# Running Apayee in Docker (local development)

Apayee as a container on Windows with Docker Desktop (WSL2 backend). There are two ways to start the same
image, and they differ in how settings and the host port are handled:

| | Standalone `docker run` (this page) | QATOOL's Docker Compose file |
| --- | --- | --- |
| Who owns the start command | You, with the commands below | QATOOL's repository (`compose.yaml`); this repository deliberately has no compose file |
| Settings file | A separate `.env.docker` (`--env-file`) | `../Apayee/.env`, the same file `npm start` reads on Windows |
| Host port | `-p 127.0.0.1:4100:4100` | **None.** Neither 4100 nor 4101 is published; only the QATOOL backend reaches Apayee, at `http://apayee:4100` on the Compose network |
| Claude volume | `apayee-claude-config`, created by you | `apayee-claude-config`, a named volume the Compose file manages (details below) |

- **Contains no secrets.** The image has no `.env`, no token and no Claude login. Settings arrive as
  environment variables when the container starts; the Claude login lives in a named volume.
- **The Windows Claude login is never copied.** The container has its own Linux CLI and its own sign-in,
  made once with your own browser.
- **Same policy as everywhere else.** The Claude provider is experimental and owner-only, and whether this use
  is permitted is unconfirmed. Read [CLAUDE_PROVIDER.md](CLAUDE_PROVIDER.md) first. Nothing here changes the
  `APAYEE_CLAUDE_EXPERIMENTAL` and `APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED` flags; they are yours to set.

## What is in the image

| Item | Value |
| --- | --- |
| Base image | `node:22.15.0-bookworm-slim` (Debian 12, x86_64). Build argument `NODE_VERSION` |
| Node.js / npm | 22.15.0 / 10.9.2 (the npm bundled with that image; the Windows PC uses npm 11.6.4, see [ENVIRONMENT_SNAPSHOT.md](ENVIRONMENT_SNAPSHOT.md)) |
| Dependencies | `npm ci --omit=dev` from `package-lock.json`: the same fastify 5.12.7, ajv 8.20.0, ajv-formats 3.0.1 |
| Claude Code CLI | 2.1.316, official native Linux build from Anthropic's installer (checksum-verified). Build argument `CLAUDE_CODE_VERSION`; the build fails if the installer does not deliver exactly that version |
| CLI path | `/home/node/.local/bin/claude` (a link into `/home/node/.local/share/claude/versions/2.1.316`). `APAYEE_CLAUDE_CLI_PATH` is set to it |
| Extra packages | `socat` (port forwarder), `tini` (init), `curl` and `ca-certificates` (installer) |
| User / home | `node` (uid 1000), home `/home/node`. The service never runs as root |
| Working directory | `/app` (`src/`, `scripts/`, production `node_modules/`) |
| Image size | about 850 MB, most of it the CLI |
| Not in the image | `.env`, tests, docs, examples, `.git`, caches, logs. Enforced by an allow-list in `.dockerignore` |
| Database | none |

Files: `Dockerfile`, `.dockerignore`, `docker/entrypoint.sh`.

## Ports

```text
standalone:  host 127.0.0.1:4100  --publish-->  container 0.0.0.0:4100 (socat)  -->  127.0.0.1:4101 (Apayee)
Compose:     QATOOL backend container  --  http://apayee:4100  -->  the same socat  (no host port at all)
```

Apayee's configuration refuses the Claude provider on any non-loopback address, even with
`APAYEE_ALLOW_REMOTE=true`. That rule is unchanged. So inside the container Apayee listens on
**127.0.0.1:4101** only, and `socat` listens on **0.0.0.0:4100** and forwards to it. The entrypoint fixes
`APAYEE_HOST` and `APAYEE_PORT` itself, so a value in your env file cannot move either.

What this does and does not protect:

- The bearer token, the `Origin` check, and all readiness checks still run in Apayee. socat only moves bytes.
- Apayee sees every client as `127.0.0.1`. Its loopback rule therefore no longer limits who can connect; the
  limits are the token and where you publish the port.
- **Standalone: publish only to host loopback:** `-p 127.0.0.1:4100:4100`. A bare `-p 4100:4100` exposes it on
  every network interface of the PC.
- **Under QATOOL's Compose file nothing is published for Apayee.** The Compose file has no `ports` entry for it, and
  the running container showed no host port binding, only port 4100 exposed on the Compose network (observed
  2026-11-03). Other containers on that network can still reach `apayee:4100`; they need the token.
- Port 4101 is not published in either mode and is not reachable from the host (checked standalone).
- Anyone who can run `docker inspect` on this PC can read the container's environment, including the token.

## Build

```powershell
docker build -t apayee:local .
```

Dependencies and the CLI are installed during the build; no configuration is read. Other versions are
possible (`--build-arg NODE_VERSION=...`, `--build-arg CLAUDE_CODE_VERSION=...`) but only the defaults above
have been built and checked.

## Configuration

**Standalone `docker run`: use a separate env file, not the Windows `.env`.** The Windows file may hold a Windows
`APAYEE_CLAUDE_CLI_PATH` (`C:\...\claude.exe`), which would override the Linux path and give `cli_not_found`, and
a host and port that do not apply here. `.env.docker` is already Git-ignored (`.env.*`) and excluded from the build.

**QATOOL's Compose file is different.** It passes `../Apayee/.env`, the Windows file, to the container with
`env_file`. That works because of two guards, neither of which depends on what the file contains:

- The entrypoint exports `APAYEE_HOST=127.0.0.1` and `APAYEE_PORT=4101` itself, after the environment is read, so
  a host or port in that file cannot move the application (see Ports).
- The Compose file sets `APAYEE_CLAUDE_CLI_PATH: /home/node/.local/bin/claude` under `environment`, which wins
  over `env_file`, so a Windows CLI path in the file is replaced.

Everything else in that file applies to the container as it does on Windows: the token, `APAYEE_PROVIDER`, both
Claude flags, queue and timeout settings, and `APAYEE_MAX_CONCURRENT`. So the Windows service and the container
share one token and one set of attestation flags, and a change to the file reaches the container only when it is
recreated. If that file sets `APAYEE_CLAUDE_PASSTHROUGH_ENV`, it replaces the image's value, so it must still list
`CLAUDE_CONFIG_DIR` (see the last bullet below). If you would rather keep the container's settings apart from the
Windows service, give the Compose file a separate env file instead; that is QATOOL's repository to change.

For the standalone path, create `.env.docker` in the project folder, one `NAME=value` per line, no quotes (Docker takes quotes literally):

```ini
APAYEE_AUTH_TOKEN=<a new token, at least 32 characters>
APAYEE_PROVIDER=claude
APAYEE_CLAUDE_EXPERIMENTAL=true
APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED=false
```

- Generate the token: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. The
  same value goes into QATOOL as `APAYEE_TOKEN`. Do not reuse the Windows service's token.
- Set `APAYEE_CLAUDE_SUBSCRIPTION_CONFIRMED=true` only yourself, after checking your plan in your Claude account
  settings. Until then health reports `claude_not_ready`.
- Any other setting from `.env.example` works the same way (queue size, timeouts, log level). Do not set
  `APAYEE_HOST`, `APAYEE_PORT`, `APAYEE_ALLOW_REMOTE` or `APAYEE_CLAUDE_CLI_PATH` here.
- If you set `APAYEE_CLAUDE_PASSTHROUGH_ENV` (for example `HTTPS_PROXY`), keep `CLAUDE_CONFIG_DIR` in the list:
  `APAYEE_CLAUDE_PASSTHROUGH_ENV=CLAUDE_CONFIG_DIR,HTTPS_PROXY`. The image sets it so the CLI keeps everything
  in one directory (below); without that approval Apayee's readiness check stops the provider, by design.

## One-time Claude sign-in

The login belongs to the container user and is stored in the Docker volume `apayee-claude-config`, mounted at
**`/home/node/.claude`**. Everything the CLI persists (credentials and its settings file) is inside that
directory, because the image sets `CLAUDE_CONFIG_DIR=/home/node/.claude`. Recreating or rebuilding the
container keeps it; deleting the volume signs you out.

1. Create the volume and start the official sign-in in an interactive container (needs a terminal):

   ```powershell
   docker volume create apayee-claude-config
   docker run -it --rm -v apayee-claude-config:/home/node/.claude apayee:local node scripts/claude-auth.js login
   ```

2. It prints a sign-in URL and `Paste code here if prompted >`. Open the URL in **your own browser on Windows**,
   choose the Claude account (subscription) option, never Console or API billing, finish with Anthropic, then
   paste the code it shows back into the terminal.
3. Check the sign-in without any model request, showing only the safe fields (the raw output also contains your
   email and organization, so do not paste it anywhere):

   ```powershell
   docker run --rm -v apayee-claude-config:/home/node/.claude apayee:local claude auth status | ConvertFrom-Json | Select-Object loggedIn, authMethod
   ```

   Expect `loggedIn True` and `authMethod claude.ai`.
4. Check your plan in your Claude account settings, then set the attestation flag in `.env.docker` and start
   the service. `node scripts/claude-auth.js status` runs the same readiness checks as health (it starts the CLI
   twice, sends no model request):

   ```powershell
   docker run --rm --env-file .env.docker -v apayee-claude-config:/home/node/.claude apayee:local node scripts/claude-auth.js status
   ```

If the volume is lost or the login expires, repeat steps 1 to 3. Use the exact volume name everywhere, or the
service will look at a different, empty login.

## Run

```powershell
docker run -d --name apayee --restart unless-stopped -p 127.0.0.1:4100:4100 --env-file .env.docker -v apayee-claude-config:/home/node/.claude apayee:local
```

| Task | Command |
| --- | --- |
| Status and Docker's own health | `docker ps --filter name=apayee` |
| Health with the token, token not printed | `$t = ((Get-Content .env.docker) \| Where-Object { $_ -like 'APAYEE_AUTH_TOKEN=*' }) -replace '^APAYEE_AUTH_TOKEN=',''; Invoke-RestMethod http://127.0.0.1:4100/v1/health -Headers @{ Authorization = "Bearer $t" }` |
| Logs (metadata only) | `docker logs apayee` |
| Stop (graceful, under a second) | `docker stop apayee` |
| Remove the container (keeps the volume) | `docker rm apayee` |
| Remove the sign-in too | `docker volume rm apayee-claude-config` |
| Rebuild and restart | `docker build -t apayee:local .` then `docker rm -f apayee` then the `docker run` above |

Only one Apayee can use host port 4100 at a time: stop `npm start` on Windows before starting the container,
or the other way round.

`provider` in health is `claude` only when the provider is ready, as in every other mode. The container's Docker
health status is `healthy` whenever the service answers with the token, whether or not Claude is ready, so it
tells you the process is up, not that Claude is usable. Read `provider` and `provider_status`. Docker's check polls
every 30 seconds; the readiness result is cached by Apayee (60 s when ready), so this does not start the CLI on
every poll.

## For QATOOL's Docker Compose file

QATOOL's repository owns the Compose file (`compose.yaml`, project name `qatool`, services `apayee`,
`qatool-backend`, `qatool-frontend`). This is how it currently starts Apayee, read from that file on 2026-11-03:

| Item | What the Compose file does |
| --- | --- |
| Image | `build: { context: ../Apayee }`, tagged `apayee:local` |
| Settings | `env_file: ../Apayee/.env` (the Windows file; see Configuration for why this works) |
| CLI path | `APAYEE_CLAUDE_CLI_PATH: /home/node/.local/bin/claude` under `environment`, overriding the file |
| Host ports | None for Apayee (no `ports` entry). 4100 is reachable only on the Compose network; 4101 is reachable by nothing outside the container |
| Login volume | `apayee-claude-config:/home/node/.claude`, declared under top-level `volumes:` with `name: apayee-claude-config`. It is a **named, Compose-managed volume**, not `external: true`. The fixed name makes Compose use the volume you signed in to rather than a `<project>_`-prefixed empty one |
| Limits | `cap_drop: [ALL]`, `no-new-privileges`, and ceilings on memory, CPUs and process IDs. They are starting points that have not been measured for real CLI runs |
| QATOOL settings | `APAYEE_BASE_URL=http://apayee:4100`; `APAYEE_TOKEN` equal to `APAYEE_AUTH_TOKEN`; `LLM_TIMEOUT_MS` not above `APAYEE_MAX_TIMEOUT_MS` |
| Start order | The backend has `depends_on: { apayee: { condition: service_healthy } }`. Healthy means "up", not "Claude ready" |

**The login volume and `down -v`.** Because the volume is Compose-managed, `docker compose down` keeps it but
`docker compose down -v` (and removing or pruning the volume) deletes the container's Claude sign-in, and you sign
in again. Declaring it `external: true` would make Compose refuse to delete it. That change belongs in QATOOL's
repository and has not been made. **Several CLI processes sharing this one volume** (when `APAYEE_MAX_CONCURRENT`
is above 1) is an unverified runtime consideration, as described in `docs/CLAUDE_PROVIDER.md`, "Concurrency".

Commands (run in QATOOL's folder):

```powershell
docker volume create apayee-claude-config
docker compose build apayee
docker compose run --rm apayee node scripts/claude-auth.js login
docker compose up -d
docker compose ps
docker compose logs apayee
docker compose stop apayee
```

`docker compose run` replaces the container's command, so the entrypoint runs the login and does not start the
service. The one-time sign-in is the same as the standalone procedure and is yours to do.

**What has been observed of the Compose setup (2026-11-03, read-only):** the three services were running and
Docker reported them healthy after several hours; the Apayee container had no host port binding, only 4100
exposed, ran as user `node` with all capabilities dropped, and mounted `apayee-claude-config` at
`/home/node/.claude` read-write. That running image was built before `APAYEE_MAX_CONCURRENT` existed, so it needs a
rebuild to use it. **Not observed:** a completed sign-in through Compose, any `/v1/generate` request, any model
request, or a QATOOL run through Apayee to the real CLI.

## What was checked (2026-11-03) and what was not

Checked on Docker Desktop 4.97.0 / Engine 29.9.2 (WSL2), with the image built from this repository:

- The build succeeded; `npm ci --omit=dev` installed the lockfile; the build verified CLI 2.1.316.
- Inside the container: user `node` (uid 1000), `HOME=/home/node`, Node 22.15.0, CLI at the path above.
  No `.env`, `.pem`, credentials file, tests or docs in the image.
- The service started with `APAYEE_PROVIDER=claude`. Apayee listened on `127.0.0.1:4101` and socat on
  `0.0.0.0:4100`; from Windows, `127.0.0.1:4100` answered and `127.0.0.1:4101` did not.
- `GET /v1/health`: 401 without a token and with a wrong token, 200 with the right one. Docker's health status
  reached `healthy`. With the attestation flag off it reported `claude_not_ready` / `subscription_unconfirmed`.
- In a throwaway container (no credentials, attestation set for that run only) the Linux readiness probe started
  the CLI, read version 2.1.316, and reported `not_authenticated`, as expected.
- A named volume on `/home/node/.claude` survived container recreation (a marker file and the CLI settings file),
  was owned by `node`, and a container without the volume did not have the marker.
- `docker stop` shut down gracefully in 0.6 s with exit code 0. Logs held metadata only.
- The login command starts and reaches the `Paste code here if prompted >` prompt.

Not done: completing the browser sign-in in the container (that is yours to do), any request to `/v1/generate`,
any model request, a QATOOL run through Apayee to the real CLI, running as a service across a Windows restart,
other Node or CLI versions, and Apple silicon or Linux hosts. The Compose setup is described above; this page's
own checks used `docker run`.

## Known limits and troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Health says `subscription_unconfirmed` | The attestation flag is `false`. Yours to set after checking your plan |
| `not_authenticated` | Sign in again (steps above), with the same volume name the service mounts |
| `cli_not_found` | Standalone: `APAYEE_CLAUDE_CLI_PATH` in your env file points elsewhere (often a Windows path); remove it. Under Compose the file's `environment` entry replaces that value, so check that entry |
| `api_environment_conflict` naming `CLAUDE_CONFIG_DIR` | `APAYEE_CLAUDE_PASSTHROUGH_ENV` was overridden without `CLAUDE_CONFIG_DIR` |
| `port is already allocated` / `EADDRINUSE` | Standalone only: something else owns host port 4100, often `npm start` on Windows. Under Compose Apayee publishes no host port, so this does not come from Apayee |
| Container exits at once | `docker logs apayee`: the message names the invalid setting (a weak token, a bad value) |
| CLI version differs from 2.1.316 later | The native CLI can update itself inside a running container. Updates are lost when the container is recreated; the image stays pinned. Rebuild to change the pinned version on purpose |
| A signed-in login stops working | Run steps 1 to 3 again; the volume keeps nothing else Apayee needs |

The image is for local development. It has no TLS, keeps its queue in memory, and runs one generation at a time
by default, like the Windows service. `APAYEE_MAX_CONCURRENT` (1 to 3) changes that; the container's memory,
CPU and process limits are set by the Compose file that starts it, and have not been measured for more than
one real CLI run (see "Concurrency" in `docs/CLAUDE_PROVIDER.md`).
