# Poker Garden

7–9 player No-Limit Hold'em with friends and AI agents at one table. Engine runs on the home server (`mbp`), lobby + PWA on Cloudflare Pages (`pokergarden.pages.dev`), each table is exposed through its own Cloudflare Quick Tunnel.

Design doc: https://claude.ai/artifact/PgB6Aydf5awGDndTi8rxCi

## Layout

| path | what |
|---|---|
| `packages/engine` | pure TS NLH engine (`Table`, `viewFor` redaction, evaluator). `npm test`, `npx tsx test/selfplay.ts 10000` |
| `packages/server` | Hono + ws gateway, bot runner (weak / default / aggressive / gto), tunnel + lobby sync. `npm run bench -w packages/server` |
| `packages/web` | Vite + Preact PWA and Pages Functions (`functions/api`: whitelist login, KV lobby) |
| `services/pokerskill` | PokerSkill prompt sidecar (docker, port 8321) used by the GTO persona |

## Run locally

```sh
npm install                      # if ~/.npm has root-owned files: npm_config_cache=~/.npm-pg npm install
TUNNEL=0 PORT=8790 npm run server   # engine on 127.0.0.1:8790 (LLM via http://127.0.0.1:8317/v1)
npm run web                      # vite on :5173
curl -s -X POST localhost:8790/admin/games -H 'content-type: application/json' -d '{"config":{"name":"dev"}}'
# open http://localhost:5173/g/<id>?api=http://127.0.0.1:8790&host=<hostKey>
```

## Deploy

```sh
./deploy.sh web      # build + wrangler pages deploy (run from repo root; functions/ is picked up from packages/web)
./deploy.sh engine   # rsync to mbp:~/project/pokergarden and restart launchd service dev.pokergarden.engine
```

Engine env lives in `mbp:~/project/pokergarden/.env` (ENGINE_KEY, LLM_*, LOBBY_URL, CLOUDFLARED). Pages config: KV binding `DB`, var `ALLOWED_EMAILS` (dashboard), secrets `SESSION_SECRET` / `ENGINE_KEY` (`wrangler pages secret put`).

## Flow

1. Host logs in on pokergarden.pages.dev (whitelisted email) → **Create table** → KV `pending`.
2. Engine polls `/api/pending` (outbound only), spawns `cloudflared tunnel`, PATCHes the game `live` with its URL + host key.
3. Host opens `/g/<id>`, takes a seat, presses **Start** → empty seats are filled with agents up to *autoFillTo*. Guests join by the same link with a nickname.
4. Agents only ever see `viewFor(seat)` (own cards + public state) and reply with one structured action; deck commit (sha256) is shown per hand and the nonce revealed at the end.
