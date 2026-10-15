import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface EsConfig {
  key?: string;
  server?: string;
  port?: number | string;
  host?: string;
  outputDir?: string;
}

export const DEFAULT_CONFIG_PATH = join(homedir(), '.encrypted-share.json');

export function loadConfig(configPath?: string): EsConfig {
  const targetPath = configPath ?? DEFAULT_CONFIG_PATH;
  if (!existsSync(targetPath)) return {};
  try {
    return JSON.parse(readFileSync(targetPath, 'utf8')) as EsConfig;
  } catch {
    console.warn(`Warning: failed to parse config file at ${targetPath}`);
    return {};
  }
}
