import { spawn, type ChildProcess } from 'node:child_process';
import { config } from './config.js';
import { log } from './log.js';

export interface Tunnel { url: string; proc: ChildProcess; close(): void }

/** Spawn a Cloudflare Quick Tunnel to the local engine port and resolve its public URL. */
export function openTunnel(): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.tunnel.bin, ['tunnel', '--url', `http://127.0.0.1:${config.port}`, '--no-autoupdate', '--protocol', 'http2'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let done = false;
    const timeout = setTimeout(() => { if (!done) { done = true; proc.kill(); reject(new Error('cloudflared: timeout waiting for URL\n' + buf.slice(-800))); } }, 45_000);
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !done) {
        done = true; clearTimeout(timeout);
        const t: Tunnel = { url: m[0], proc, close: () => { try { proc.kill(); } catch { /* ignore */ } } };
        log('tunnel', `up ${t.url}`);
        resolve(t);
      }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.on('exit', (code) => { log('tunnel', `cloudflared exited ${code}`); if (!done) { done = true; clearTimeout(timeout); reject(new Error('cloudflared exited: ' + buf.slice(-800))); } });
    proc.on('error', (e) => { if (!done) { done = true; clearTimeout(timeout); reject(e); } });
  });
}
