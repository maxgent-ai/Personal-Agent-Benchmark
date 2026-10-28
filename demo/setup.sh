#!/bin/sh
# Installs what the demo needs: the benchmark build, the pi packages, and browser-use in a local venv.
set -e
cd "$(dirname "$0")"
[ -d ../node_modules ] || (cd .. && npm ci)
(cd .. && npm run build)
npm install --no-audit --no-fund
uv venv -q --allow-existing --python 3.12 .venv
uv pip install -q --python .venv/bin/python "browser-use==0.13.14"
[ -f .env ] || cp .env.example .env
echo "Ready. Put your OpenRouter key in demo/.env, then: node run.ts"
