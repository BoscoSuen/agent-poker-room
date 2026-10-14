import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });

export function appendJsonl(file: string, obj: unknown) {
  appendFileSync(join(config.dataDir, file), JSON.stringify(obj) + '\n');
}

export function log(scope: string, msg: string, extra?: Record<string, unknown>) {
  const line = `${new Date().toISOString()} [${scope}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  console.log(line);
}
