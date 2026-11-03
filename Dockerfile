# syntax=docker/dockerfile:1
#
# Apayee as a standalone local service. See docs/DOCKER_LOCAL.md.
#
# Nothing in this image is a secret: no .env, no token, no Claude login. Configuration arrives
# as environment variables at run time and the Claude login lives in a named volume mounted at
# /home/node/.claude.

ARG NODE_VERSION=22.15.0
FROM node:${NODE_VERSION}-bookworm-slim

# The Claude Code CLI version this image was verified with (docs/ENVIRONMENT_SNAPSHOT.md).
# Native CLIs update themselves, so the build fails if the installer did not give exactly this.
ARG CLAUDE_CODE_VERSION=2.1.316

# socat forwards the published port to the loopback-only application; tini reaps the CLI's
# child processes and passes signals on.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl socat tini \
    && rm -rf /var/lib/apt/lists/*

# Line endings are normalised so a Windows checkout with CRLF still runs.
COPY docker/entrypoint.sh /usr/local/bin/apayee-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/apayee-entrypoint && chmod 755 /usr/local/bin/apayee-entrypoint

WORKDIR /app
RUN chown node:node /app
USER node

# Production dependencies from the lockfile only. npm ci never edits it.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Everything the CLI persists (the login and its settings file, ~/.claude.json) goes into ONE
# directory, so one named volume on it keeps the sign-in. Without CLAUDE_CONFIG_DIR the settings
# file would sit beside the directory, outside the volume. Apayee stops its Claude provider when
# this variable is set unless it is approved, so it is approved by name here (the documented
# mechanism, docs/CLAUDE_PROVIDER.md). If you override APAYEE_CLAUDE_PASSTHROUGH_ENV, keep it in.
ENV CLAUDE_CONFIG_DIR=/home/node/.claude \
    APAYEE_CLAUDE_PASSTHROUGH_ENV=CLAUDE_CONFIG_DIR

# Official native Linux CLI, installed for the unprivileged user: the binary lands in
# /home/node/.local/bin (a link into /home/node/.local/share/claude). Anthropic's installer
# verifies a SHA-256 from its manifest. Do not copy a Windows claude.exe into this image.
ENV PATH="/home/node/.local/bin:${PATH}"
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_CODE_VERSION}" \
    && test "$(claude --version | cut -d' ' -f1)" = "${CLAUDE_CODE_VERSION}" \
    && mkdir -p /home/node/.claude

COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

# The application listens on loopback only (4101). Its own rules require that for the Claude
# provider. The entrypoint also starts socat on 0.0.0.0:4100, which is the only port to publish.
ENV NODE_ENV=production \
    APAYEE_CLAUDE_CLI_PATH=/home/node/.local/bin/claude
EXPOSE 4100

# Goes through the forwarder, so it tests the path a client uses. 200 means the service is up,
# not that Claude is ready: read provider and provider_status in the body for that.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "const h={};if(process.env.APAYEE_AUTH_TOKEN)h.Authorization='Bearer '+process.env.APAYEE_AUTH_TOKEN;fetch('http://127.0.0.1:4100/v1/health',{headers:h}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/apayee-entrypoint"]
CMD ["serve"]
