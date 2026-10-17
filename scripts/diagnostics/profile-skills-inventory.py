import subprocess
remote = '''
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("runner", str(Path.home()/".local/share/luma-ops/source/scripts/lib/paperclip_typecheck.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner.PATHS += ["skills", "skills-releases", "scripts/diagnostics"]
runner.CHECK = chr(10).join(["set -eu", "cat /payload/part-* > /tmp/overlay.tgz", "echo $OVERLAY_SHA256  /tmp/overlay.tgz | sha256sum -c -", "rm -rf /app/server/src /app/packages/db/src /app/packages/adapter-utils/src", "tar xzf /tmp/overlay.tgz -C /app", "cd /app", "node scripts/diagnostics/instrument-skills-inventory.mjs", "mkdir -p /tmp/profile-home", "chown -R node:node /app/server /app/packages/db /tmp/profile-home", "gosu node env HOME=/tmp/profile-home NODE_ENV=development node server/node_modules/vitest/vitest.mjs run --root server --config /app/server/vitest.config.ts src/__tests__/company-skills-inventory-profile.test.ts"])
raise SystemExit(runner.run(str(Path.home()/"tasks/per959/paperclip"), "SOURCE_SHA"))
'''
sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
remote = remote.replace("SOURCE_SHA", sha)
raise SystemExit(subprocess.run(["ssh", "agents", "python3", "-"], input=remote, text=True).returncode)
