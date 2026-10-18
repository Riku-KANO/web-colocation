// Reloads the config file when it changes. Kubernetes updates a mounted ConfigMap by swapping a
// `..data` symlink inside the directory, so the directory is watched rather than the file.
// Invalid new configs are logged and ignored (the running config stays in effect).

import { watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../log.ts';
import { loadConfig, type LoadedConfig } from './load.ts';

export function watchConfig(path: string, env: NodeJS.ProcessEnv, log: Logger, onChange: (loaded: LoadedConfig) => void, debounceMs = 500): () => void {
  let timer: NodeJS.Timeout | undefined;
  let last = '';
  let watcher: FSWatcher | null = null;
  const reload = () => {
    try {
      const loaded = loadConfig(path, env);
      const fingerprint = JSON.stringify(loaded.config);
      if (fingerprint === last) return;
      last = fingerprint;
      onChange(loaded);
    } catch (e) {
      log.error('config reload failed; keeping the previous configuration', { error: (e as Error).message });
    }
  };
  try {
    last = JSON.stringify(loadConfig(path, env).config);
    watcher = watch(dirname(path), { persistent: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(reload, debounceMs);
    });
  } catch (e) {
    log.warn('config file watching is unavailable', { error: (e as Error).message });
  }
  return () => {
    clearTimeout(timer);
    watcher?.close();
  };
}
