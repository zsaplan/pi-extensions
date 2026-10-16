import {defaults} from './defaults.js';

export function resolve(env: Record<string, string | undefined>) {
  return {
    ...defaults,
    timeoutMs:
      env.TIMEOUT_MS === undefined
        ? defaults.timeoutMs
        : Number(env.TIMEOUT_MS),
  };
}
