#!/usr/bin/env bash

set -euo pipefail
export EPLP_DATA="${EPLP_DATA:-.data-ui-portal}"
cd "$(dirname "$0")/.."
SHOT_TAG=sealing node verify/e2e.ts overview
node verify/e2e.ts setter authority create
node verify/candidates.ts > verify/out/candidates.log 2>&1
SHOT_TAG=shifts-done node verify/e2e.ts overview
node verify/e2e.ts publish results audit
SHOT_TAG=published node verify/e2e.ts overview
node verify/e2e.ts revoke
echo "RUN-ALL PASSED"
