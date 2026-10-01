import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from 'pino';

const context = new AsyncLocalStorage<{ requestId: string }>();
let root: Logger | undefined;

export const initTrace = (log: Logger) => {
  root = log;
};

export const withRequest = <T>(requestId: string, fn: () => T): T => context.run({ requestId }, fn);

export const tracer = (file: string) => (step: string, data: Record<string, unknown> = {}) => {
  const store = context.getStore();
  if (!root || !store) return;
  root.info({ file, requestId: store.requestId, step, ...data }, `[${file}] ${step}`);
};
