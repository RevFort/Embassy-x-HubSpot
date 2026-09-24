import type { Logger } from 'pino';

export type CrmProperties = Record<string, string | null | undefined>;

export interface CrmRecord {
  id: string;
  properties: Record<string, string | null>;
}

export interface Filter {
  propertyName: string;
  operator: 'EQ' | 'IN';
  value?: string;
  values?: string[];
}

export interface FilterGroup {
  filters: Filter[];
}

/** The slice of the HubSpot CRM API this service needs. Implemented against HubSpot and by an in-memory fake in tests. */
export interface Crm {
  search(objectType: string, filterGroups: FilterGroup[], properties: string[]): Promise<CrmRecord[]>;
  batchRead(objectType: string, ids: string[], properties: string[]): Promise<CrmRecord[]>;
  create(objectType: string, properties: CrmProperties): Promise<string>;
  update(objectType: string, id: string, properties: CrmProperties): Promise<void>;
  associateDefault(fromType: string, fromId: string, toType: string, toId: string): Promise<void>;
  propertyNames(objectType: string): Promise<Set<string>>;
}

export class HubSpotError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }

  /** HubSpot's 409 on contact create includes "Existing ID: 123". */
  get existingId(): string | undefined {
    return this.status === 409 ? /Existing ID:\s*(\d+)/i.exec(this.message)?.[1] : undefined;
  }
}

const SEARCH_PAGE_LIMIT = 100;
const MAX_FILTER_GROUPS = 5;

export class HubSpotCrm implements Crm {
  private readonly propertyCache = new Map<string, Promise<Set<string>>>();

  constructor(
    private readonly opts: { accessToken: string; baseUrl: string; timeoutMs: number; maxRetries: number },
    private readonly log: Logger,
  ) {}

  async search(objectType: string, filterGroups: FilterGroup[], properties: string[]): Promise<CrmRecord[]> {
    const byId = new Map<string, CrmRecord>();
    // HubSpot allows at most 5 filter groups (OR-ed) per search request.
    for (let i = 0; i < filterGroups.length; i += MAX_FILTER_GROUPS) {
      let after: string | undefined;
      do {
        const res = await this.request<{ results: CrmRecord[]; paging?: { next?: { after: string } } }>(
          'POST',
          `/crm/v3/objects/${objectType}/search`,
          {
            filterGroups: filterGroups.slice(i, i + MAX_FILTER_GROUPS),
            properties,
            limit: SEARCH_PAGE_LIMIT,
            ...(after ? { after } : {}),
          },
        );
        for (const r of res.results) byId.set(r.id, r);
        after = res.paging?.next?.after;
      } while (after);
    }
    return [...byId.values()];
  }

  async batchRead(objectType: string, ids: string[], properties: string[]): Promise<CrmRecord[]> {
    const out: CrmRecord[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const res = await this.request<{ results: CrmRecord[] }>('POST', `/crm/v3/objects/${objectType}/batch/read`, {
        inputs: ids.slice(i, i + 100).map((id) => ({ id })),
        properties,
      });
      out.push(...res.results);
    }
    return out;
  }

  async create(objectType: string, properties: CrmProperties): Promise<string> {
    // Not idempotent: only retried on 429 (request rejected before processing), never on 5xx/timeouts,
    // otherwise a retry could create the very duplicate this service exists to prevent.
    const res = await this.request<{ id: string }>(
      'POST',
      `/crm/v3/objects/${objectType}`,
      { properties: clean(properties) },
      false,
    );
    return res.id;
  }

  async update(objectType: string, id: string, properties: CrmProperties): Promise<void> {
    const props = clean(properties);
    if (Object.keys(props).length === 0) return;
    await this.request('PATCH', `/crm/v3/objects/${objectType}/${id}`, { properties: props });
  }

  async associateDefault(fromType: string, fromId: string, toType: string, toId: string): Promise<void> {
    await this.request('PUT', `/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`);
  }

  propertyNames(objectType: string): Promise<Set<string>> {
    let cached = this.propertyCache.get(objectType);
    if (!cached) {
      cached = this.request<{ results: { name: string }[] }>('GET', `/crm/v3/properties/${objectType}`).then(
        (r) => new Set(r.results.map((p) => p.name)),
      );
      cached.catch(() => this.propertyCache.delete(objectType));
      this.propertyCache.set(objectType, cached);
    }
    return cached;
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown, idempotent = true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.opts.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.opts.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        if (idempotent && attempt < this.opts.maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new HubSpotError(`HubSpot request failed: ${(err as Error).message}`, 0, undefined);
      }

      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
      const retryable = res.status === 429 || (idempotent && res.status >= 500);
      if (retryable && attempt < this.opts.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
        this.log.warn({ status: res.status, path, attempt, wait }, 'HubSpot retryable error');
        await sleep(wait);
        continue;
      }
      const hubspotMessage =
        parsed && typeof parsed === 'object' && 'message' in parsed ? String((parsed as { message: unknown }).message) : '';
      const message = hubspotMessage || `HubSpot ${method} ${path} failed with ${res.status}`;
      throw new HubSpotError(message, res.status, parsed);
    }
  }
}

function clean(props: CrmProperties): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

const backoff = (attempt: number) => Math.min(500 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
