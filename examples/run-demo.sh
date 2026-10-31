#!/usr/bin/env bash
# Runs the four demo scenarios on one runtime: ./examples/run-demo.sh node|bun|deno
set -u
cd "$(dirname "$0")/.."
RT="${1:-node}"

case "$RT" in
  node) RUN=(node --experimental-strip-types --no-warnings examples/demo.ts) ;;
  bun)  RUN=(bun examples/demo.ts) ;;
  deno) RUN=(deno run --allow-env --allow-net examples/demo.ts) ;;
  *) echo "usage: $0 node|bun|deno"; exit 2 ;;
esac

GOOD_DB="postgres://app:s3cr3t-pass@127.0.0.1:5433/app"
step() { printf '\n\033[1m── %s (%s) ──\033[0m\n' "$1" "$RT"; }

step "1. broken config: every problem at once, no checks run"
env -i PATH="$PATH" HOME="$HOME" DATABASE_URL="postgres//missing-colon" PORT="eighty" "${RUN[@]}"
echo "exit code: $?"

step "2. config fine, database down: retries, then one clear report (password masked)"
env -i PATH="$PATH" HOME="$HOME" SCENARIO=down DATABASE_URL="$GOOD_DB" SESSION_SECRET="x9f2-long-secret" "${RUN[@]}"
echo "exit code: $?"

step "3. database comes up late: ready after retries"
env -i PATH="$PATH" HOME="$HOME" SCENARIO=late DATABASE_URL="$GOOD_DB" SESSION_SECRET="x9f2-long-secret" "${RUN[@]}"
echo "exit code: $?"

step "4. optional analytics down: ready but degraded"
env -i PATH="$PATH" HOME="$HOME" SCENARIO=degraded DATABASE_URL="$GOOD_DB" ANALYTICS_URL="tcp://127.0.0.1:5999" SESSION_SECRET="x9f2-long-secret" "${RUN[@]}"
echo "exit code: $?"
