"""Run the isolated subscription-backed Honcho compatibility proof."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
parser.add_argument('--model')
parser.add_argument('--source')
parser.add_argument('--samples', type=int, default=3)
args = parser.parse_args()
if not 1 <= args.samples <= 10:
    parser.error('--samples must be between 1 and 10')
root = Path(__file__).resolve().parents[2]
source = Path(args.source).resolve() if args.source else root / '.t3/honcho-source'
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
env = dict(os.environ)
if args.model:
    env['T3PO_MEMORY_MODEL'] = args.model
case = Path(__file__).with_name('case.py')
subprocess.run([sys.executable, str(case), str(source), str(out)], check=True)
rows = []
for sample in range(1, args.samples + 1):
    filename = f'response-{sample}.json'
    with (out / f'run-{sample}.log').open('w') as log:
        inference = subprocess.run(['node', str(root / 'apps/server/scripts/honcho-codex-worker.ts'), str(out / 'request.json'), str(out / filename)], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
        validation = subprocess.run([sys.executable, str(case), str(source), str(out), 'validate', filename], stdout=log, stderr=subprocess.STDOUT) if inference.returncode == 0 else None
    rows.append({'sample': sample, 'passed': validation is not None and validation.returncode == 0})
summary = {'case': 'decision-blocker-next-action-with-unrelated-peer', 'samples': rows, 'billing': 'ChatGPT subscription allowance; API-key fallback disabled', 'tokenUsage': 'not collected', 'scope': 'extraction protocol and Honcho validator, not database persistence or background processing'}
(out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
sys.exit(0 if all(row['passed'] for row in rows) else 1)
