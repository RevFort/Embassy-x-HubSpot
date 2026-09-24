/**
 * In-process mutex keyed by customer identifier (phone/email). Two requests carrying the same
 * phone number are processed one after the other, so the second sees what the first created.
 *
 * Scope: a single running instance. If the service is scaled out to several instances,
 * replace this with a distributed lock (e.g. Redis / Azure Blob lease).
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    // Acquire in sorted order so two callers with overlapping keys cannot deadlock.
    const sorted = [...new Set(keys)].sort();
    const releases: (() => void)[] = [];
    try {
      for (const key of sorted) releases.push(await this.acquire(key));
      return await fn();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  private async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => (release = r));
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    return () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}
