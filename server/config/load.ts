// Loads the YAML/JSON config file plus environment overrides and validates it.
// Invalid configuration is reported with the offending path so operators can fix it quickly.

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError, TemplateRegistry, validateReferences } from './resolve.ts';
import { AppConfigSchema, type AppConfig } from './schema.ts';

export interface LoadedConfig {
  config: AppConfig;
  templates: TemplateRegistry;
  /** Path of the file it was loaded from (null = defaults only). */
  source: string | null;
}

/** Process-level settings that come from the environment, not from the config file. */
export interface RuntimeOptions {
  host: string;
  port: number;
  /** Separate listener for /healthz, /readyz and /metrics (null = serve them on the main port only). */
  healthPort: number | null;
  configPath: string | null;
  staticDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'json' | 'pretty';
}

export function runtimeFromEnv(env: NodeJS.ProcessEnv, defaults: Partial<RuntimeOptions> = {}): RuntimeOptions {
  const int = (v: string | undefined, fallback: number | null): number | null => {
    if (v === undefined || v === '') return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new ConfigError(`invalid port number: ${v}`);
    return n;
  };
  const level = env.LOG_LEVEL ?? defaults.logLevel ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new ConfigError(`invalid LOG_LEVEL: ${level}`);
  return {
    host: env.HOST ?? defaults.host ?? '0.0.0.0',
    port: int(env.PORT, defaults.port ?? 8080)!,
    healthPort: int(env.HEALTH_PORT, defaults.healthPort ?? null),
    configPath: env.COLO_CONFIG || defaults.configPath || null,
    staticDir: env.COLO_STATIC_DIR ?? defaults.staticDir ?? 'dist',
    logLevel: level as RuntimeOptions['logLevel'],
    logFormat: (env.LOG_FORMAT ?? defaults.logFormat ?? 'json') === 'pretty' ? 'pretty' : 'json',
  };
}

/** A few common settings can be given as environment variables (handy for `docker run`). */
function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const o: Record<string, Record<string, unknown>> = {};
  const set = (section: string, key: string, value: unknown) => ((o[section] ??= {})[key] = value);
  if (env.COLO_PUBLIC_URL) set('server', 'publicUrl', env.COLO_PUBLIC_URL);
  if (env.COLO_AUTH_MODE) set('auth', 'mode', env.COLO_AUTH_MODE);
  if (env.COLO_STORAGE_DRIVER) set('storage', 'driver', env.COLO_STORAGE_DRIVER);
  if (env.COLO_STORAGE_DIR) set('storage', 'dir', env.COLO_STORAGE_DIR);
  if (env.COLO_ASSETS_DIR) set('assets', 'dir', env.COLO_ASSETS_DIR);
  if (env.COLO_DEFAULT_LANGUAGE) set('i18n', 'defaultLanguage', env.COLO_DEFAULT_LANGUAGE);
  return o;
}

function mergeSection(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const cur = out[k];
    out[k] =
      cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object'
        ? { ...(cur as Record<string, unknown>), ...(v as Record<string, unknown>) }
        : v;
  }
  return out;
}

/** Parse + validate a config object (already read from YAML/JSON). */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = {}, source: string | null = null): LoadedConfig {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new ConfigError('the config file must contain a mapping at the top level');
  }
  const merged = mergeSection((raw as Record<string, unknown>) ?? {}, envOverrides(env));
  const result = AppConfigSchema.safeParse(merged);
  if (!result.success) throw new ConfigError(`invalid configuration${source ? ` in ${source}` : ''}:\n${z.prettifyError(result.error)}`);
  const config = result.data;
  const templates = new TemplateRegistry(config.templates);
  validateReferences(config, templates);
  return { config, templates, source };
}

export function loadConfig(path: string | null, env: NodeJS.ProcessEnv = {}): LoadedConfig {
  if (!path) return parseConfig({}, env, null);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read config file ${path}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text, { maxAliasCount: 100 });
  } catch (e) {
    throw new ConfigError(`cannot parse ${path}: ${(e as Error).message}`);
  }
  return parseConfig(raw, env, path);
}
