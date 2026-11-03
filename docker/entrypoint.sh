#!/bin/bash
# Container entrypoint. With no argument (or "serve") it runs Apayee on loopback and a socat
# forwarder in front of it. Any other command is run as given, e.g. the interactive login:
#   docker run -it --rm -v apayee-claude-config:/home/node/.claude apayee:local node scripts/claude-auth.js login
set -euo pipefail

case "${1:-serve}" in
  serve) ;;
  *) exec "$@" ;;
esac

# Fixed on purpose: the Claude provider refuses a non-loopback host, so the application stays
# on 127.0.0.1 and only socat listens on all interfaces. A value from the environment must not
# move either of them.
export APAYEE_HOST=127.0.0.1
export APAYEE_PORT=4101

node src/server.js &
app=$!
socat TCP-LISTEN:4100,bind=0.0.0.0,fork,reuseaddr TCP:127.0.0.1:4101 &
forwarder=$!

shutdown() {
  trap '' TERM INT
  kill -TERM "$app" 2>/dev/null || true
  wait "$app" 2>/dev/null || true
  kill "$forwarder" 2>/dev/null || true
}

# A stop request: let Apayee run its own shutdown, then end the forwarder.
trap 'shutdown; exit 0' TERM INT

# Either process ending on its own ends the container, so the failure is visible and an
# orchestrator can restart it.
status=0
wait -n "$app" "$forwarder" || status=$?
shutdown
exit "$status"
