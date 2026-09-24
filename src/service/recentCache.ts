/**
 * HubSpot's search index lags writes by a few seconds, so a contact created moments ago may not
 * be found by the next search. Remember identifier -> contact ID for records we created or
 * matched recently; reading by ID is immediately consistent.
 */
export class RecentContactCache {
  private readonly entries = new Map<string, { contactId: string; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  remember(keys: string[], contactId: string): void {
    const expiresAt = this.now() + this.ttlMs;
    for (const key of keys) this.entries.set(key, { contactId, expiresAt });
  }

  contactIdsFor(keys: string[]): string[] {
    const now = this.now();
    const ids = new Set<string>();
    for (const key of keys) {
      const e = this.entries.get(key);
      if (!e) continue;
      if (e.expiresAt <= now) this.entries.delete(key);
      else ids.add(e.contactId);
    }
    return [...ids];
  }

  prune(): void {
    const now = this.now();
    for (const [k, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(k);
  }
}
