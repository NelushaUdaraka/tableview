#!/usr/bin/env bash
#
# Runs the end-to-end suites against a built app. On a headless machine it
# starts an Xvfb display first.
#
# Usage: scripts/e2e.sh [smoke|workspace|editing|all]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SUITE="${1:-all}"

if [ -z "${DISPLAY:-}" ]; then
  if ! command -v Xvfb >/dev/null; then
    echo "No DISPLAY and Xvfb is not installed (apt-get install -y xvfb)" >&2
    exit 1
  fi
  if [ ! -e /tmp/.X11-unix/X99 ]; then
    echo "==> starting Xvfb on :99"
    Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp &
    for _ in $(seq 1 20); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.5; done
  fi
  export DISPLAY=:99
fi

echo "==> building"
npx electron-vite build >/dev/null

# A previous run holding the single-instance lock would make the next launch exit.
for pid in $(pgrep -x electron 2>/dev/null || true); do kill -9 "$pid" 2>/dev/null || true; done

# The SSM suite runs against stand-ins for the AWS CLI and the Session Manager
# plugin, so it needs no AWS account. A hand-written stand-in already in
# .tmp/bin is left alone.
stub_aws() {
  mkdir -p "$ROOT/.tmp/bin"
  if [ ! -e "$ROOT/.tmp/bin/aws" ]; then
    cat > "$ROOT/.tmp/bin/aws" <<STUB
#!/usr/bin/env bash
exec node "$ROOT/test/fixtures/fake-aws.mjs" "\$@"
STUB
    chmod +x "$ROOT/.tmp/bin/aws"
  fi
  if [ ! -e "$ROOT/.tmp/bin/session-manager-plugin" ]; then
    cat > "$ROOT/.tmp/bin/session-manager-plugin" <<'STUB'
#!/usr/bin/env bash
echo "1.2.707.0"
STUB
    chmod +x "$ROOT/.tmp/bin/session-manager-plugin"
  fi
}

run() {
  echo
  echo "==> e2e: $1"
  [ "$1" = "ssm-form" ] && stub_aws
  rm -rf "$ROOT/.tmp/profile-$1"
  node "test/e2e/$1.mjs"
}

case "$SUITE" in
  smoke)       run smoke ;;
  workspace)   run workspace ;;
  editing)     run editing ;;
  table-ui)    run table-ui ;;
  ssm-form)    run ssm-form ;;
  connections) run connections ;;
  all)         run smoke; run connections; run workspace; run editing; run table-ui; run ssm-form ;;
  *) echo "usage: $0 {smoke|connections|workspace|editing|table-ui|ssm-form|all}" >&2; exit 1 ;;
esac
