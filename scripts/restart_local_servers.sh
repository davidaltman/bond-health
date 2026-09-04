#!/usr/bin/env bash
# Restart the Bond Health demo's local backend (port 8790) and frontend (port 5190).
#
# Why this is needed: both are plain background processes (npm/tsx/vite). Closing
# the laptop lid (sleep) or a terminal-app quit kills them silently -- there is no
# supervisor bringing them back up. This script kills anything stale on the two
# ports, starts both fresh in the background with nohup (so they survive the
# terminal that launched them closing), and verifies both respond before exiting.
#
# Usage:
#   ./restart_local_servers.sh            # restart both
#   ./restart_local_servers.sh backend    # restart backend only
#   ./restart_local_servers.sh frontend   # restart frontend only
#   ./restart_local_servers.sh status     # just check what's running, don't restart
#
# Logs: written to /tmp/bond_health_demo_logs/{backend,frontend}.log (outside the
# repo on purpose, so there's no risk of accidentally committing them).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$DEMO_ROOT/server"
FRONTEND_DIR="$DEMO_ROOT/frontend"
LOG_DIR="/tmp/bond_health_demo_logs"
mkdir -p "$LOG_DIR"

# Prefer a local env file in this standalone checkout. Copy server/.env.example
# to server/.env (or a repo-root bond.env) and fill in BOND_ELEVEN_LABS_API_KEY.
BOND_ENV_FILE=""
for candidate in \
  "$SERVER_DIR/.env" \
  "$DEMO_ROOT/.env" \
  "$DEMO_ROOT/bond.env"
do
  if [ -f "$candidate" ]; then
    BOND_ENV_FILE="$candidate"
    break
  fi
done

BACKEND_PORT="${PORT:-8790}"
FRONTEND_PORT=5190
AWS_PROFILE_NAME="${AWS_PROFILE:-default}"
AWS_REGION_NAME="${AWS_REGION:-us-west-2}"
BEDROCK_MODEL="${BEDROCK_MODEL_ID:-us.anthropic.claude-haiku-4-5-20251001-v1:0}"

MODE="${1:-all}"

port_pid() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

kill_port() {
  local port="$1" name="$2"
  local pid
  pid="$(port_pid "$port")"
  if [ -n "$pid" ]; then
    echo "Stopping existing $name process on port $port (pid $pid)..."
    kill -9 $pid 2>/dev/null || true
    sleep 1
  fi
}

start_backend() {
  if [ -z "$BOND_ENV_FILE" ]; then
    echo "ERROR: env file not found (checked $SERVER_DIR/.env, $DEMO_ROOT/.env, $DEMO_ROOT/bond.env)" >&2
    exit 1
  fi
  local api_key
  api_key="$(grep '^BOND_ELEVEN_LABS_API_KEY=' "$BOND_ENV_FILE" | cut -d= -f2-)"
  if [ -z "$api_key" ]; then
    echo "ERROR: BOND_ELEVEN_LABS_API_KEY not found in $BOND_ENV_FILE" >&2
    exit 1
  fi

  kill_port "$BACKEND_PORT" backend

  echo "Starting backend on port $BACKEND_PORT..."
  (
    cd "$SERVER_DIR"
    export BOND_ELEVEN_LABS_API_KEY="$api_key"
    export AWS_PROFILE="$AWS_PROFILE_NAME"
    export AWS_REGION="$AWS_REGION_NAME"
    export BEDROCK_MODEL_ID="$BEDROCK_MODEL"
    export PORT="$BACKEND_PORT"
    nohup npm run dev >> "$LOG_DIR/backend.log" 2>&1 &
    disown
  )

  echo -n "Waiting for backend to come up"
  for _ in $(seq 1 15); do
    if curl -sf -o /dev/null "http://127.0.0.1:$BACKEND_PORT/api/agents" 2>/dev/null; then
      echo " -> up"
      return 0
    fi
    echo -n "."
    sleep 1
  done
  echo " -> FAILED. Check $LOG_DIR/backend.log"
  tail -n 30 "$LOG_DIR/backend.log" || true
  return 1
}

start_frontend() {
  kill_port "$FRONTEND_PORT" frontend

  echo "Starting frontend on port $FRONTEND_PORT..."
  (
    cd "$FRONTEND_DIR"
    nohup npm run dev >> "$LOG_DIR/frontend.log" 2>&1 &
    disown
  )

  echo -n "Waiting for frontend to come up"
  for _ in $(seq 1 15); do
    if curl -sf -o /dev/null "http://127.0.0.1:$FRONTEND_PORT/" 2>/dev/null; then
      echo " -> up"
      return 0
    fi
    echo -n "."
    sleep 1
  done
  echo " -> FAILED. Check $LOG_DIR/frontend.log"
  tail -n 30 "$LOG_DIR/frontend.log" || true
  return 1
}

show_status() {
  local backend_pid frontend_pid
  backend_pid="$(port_pid "$BACKEND_PORT")"
  frontend_pid="$(port_pid "$FRONTEND_PORT")"
  if [ -n "$backend_pid" ]; then
    echo "Backend:  UP   (pid $backend_pid, http://127.0.0.1:$BACKEND_PORT)"
  else
    echo "Backend:  DOWN (port $BACKEND_PORT)"
  fi
  if [ -n "$frontend_pid" ]; then
    echo "Frontend: UP   (pid $frontend_pid, http://127.0.0.1:$FRONTEND_PORT)"
  else
    echo "Frontend: DOWN (port $FRONTEND_PORT)"
  fi
}

case "$MODE" in
  status)
    show_status
    ;;
  backend)
    start_backend
    show_status
    ;;
  frontend)
    start_frontend
    show_status
    ;;
  all)
    start_backend
    start_frontend
    show_status
    echo ""
    echo "Open http://127.0.0.1:$FRONTEND_PORT/ in your browser."
    ;;
  *)
    echo "Usage: $0 [all|backend|frontend|status]" >&2
    exit 1
    ;;
esac
