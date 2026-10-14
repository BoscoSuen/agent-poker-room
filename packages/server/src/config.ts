import { resolve } from 'node:path';

const env = process.env;
export const config = {
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '127.0.0.1',
  dataDir: resolve(env.DATA_DIR ?? './data'),
  llm: {
    baseUrl: env.LLM_BASE_URL ?? 'http://127.0.0.1:8317/v1',
    apiKey: env.LLM_API_KEY ?? 'sk-calpico-local',
    model: env.LLM_MODEL ?? 'gpt-6-luna',
    models: (env.LLM_MODELS ?? env.LLM_MODEL ?? 'gpt-6-luna,gpt-5.5').split(',').map((m) => m.trim()).filter(Boolean),
    reasoningEffort: env.LLM_REASONING ?? 'low',
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 8000),
  },
  pokerskillUrl: env.POKERSKILL_URL ?? 'http://127.0.0.1:8321',
  lobby: {
    url: env.LOBBY_URL ?? 'https://pokergarden.pages.dev',
    engineKey: env.ENGINE_KEY ?? '',
    pollMs: Number(env.LOBBY_POLL_MS ?? 3000),
  },
  tunnel: {
    enabled: (env.TUNNEL ?? '1') !== '0',
    bin: env.CLOUDFLARED ?? 'cloudflared',
    idleCloseMs: Number(env.TUNNEL_IDLE_MS ?? 10 * 60_000),
  },
  adminKey: env.ADMIN_KEY ?? '',
  publicUrl: env.PUBLIC_URL ?? '', // if set, used instead of a tunnel (e.g. local dev)
  botThinkMs: Number(env.BOT_THINK_MS ?? 600),
};
