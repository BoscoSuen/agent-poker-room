#!/bin/sh
# Poker Garden deploy helper. Usage: ./deploy.sh web | engine | all
set -e
cd "$(dirname "$0")"
web() { (cd packages/web && npx vite build && wrangler pages deploy dist --project-name pokergarden --commit-dirty=true); }
engine() {
  rsync -a --delete --exclude node_modules --exclude dist --exclude data --exclude .git --exclude .env --exclude .env.local --exclude .wrangler ./ mbp:~/project/pokergarden/
  ssh mbp 'export PATH=$HOME/opt/node/bin:$PATH; cd ~/project/pokergarden && npm install --no-audit --no-fund >/dev/null && launchctl kickstart -k gui/$(id -u)/dev.pokergarden.engine && sleep 4 && curl -s http://127.0.0.1:8787/health && echo'
}
case "${1:-all}" in web) web;; engine) engine;; all) web; engine;; esac
