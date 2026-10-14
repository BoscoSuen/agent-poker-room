import { serve } from '@hono/node-server';
import { app } from './http.js';
import { attachWebSocket } from './ws.js';
import { startLobbySync } from './lobby.js';
import { reapIdle } from './registry.js';
import { config } from './config.js';
import { log } from './log.js';

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log('server', `listening on http://${info.address}:${info.port}`, { llm: config.llm.model, tunnel: config.tunnel.enabled, publicUrl: config.publicUrl || null });
});
attachWebSocket(server as any);
startLobbySync();
setInterval(reapIdle, 60_000);

// Graceful shutdown: kill tunnels so cloudflared children don't outlive the engine.
import { games } from './registry.js';
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log('server', `${sig}: closing ${games.size} game(s)`);
    for (const g of games.values()) { try { g.rt.close(); } catch { /* ignore */ } }
    setTimeout(() => process.exit(0), 300);
  });
}
