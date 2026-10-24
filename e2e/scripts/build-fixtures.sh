#!/usr/bin/env bash
# Builds the breaker plugin zips served by mock-feeds (zip top-level dir is always autowp-breaker/).
set -euo pipefail
E2E="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$E2E" <<'PY'
import sys, zipfile, os
e2e = sys.argv[1]
def build(src, out):
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(src):
            for f in sorted(files):
                p = os.path.join(root, f)
                z.write(p, os.path.join('autowp-breaker', os.path.relpath(p, src)))
build(f'{e2e}/fixtures/plugins/autowp-breaker-2.0.0', f'{e2e}/fixtures/feeds/autowp-breaker-2.0.0.zip')
build(f'{e2e}/fixtures/plugins/autowp-breaker', f'{e2e}/fixtures/feeds/autowp-breaker-1.0.0.zip')
PY
