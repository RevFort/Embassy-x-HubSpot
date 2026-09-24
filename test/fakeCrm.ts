import { HubSpotError, type Crm, type CrmProperties, type CrmRecord, type FilterGroup } from '../src/hubspot/client.js';

/**
 * In-memory stand-in for HubSpot. Mirrors the behaviours that matter for de-duplication:
 * - search can lag behind writes (`searchLag`), like HubSpot's index
 * - contact email is unique (409 with "Existing ID")
 */
export class FakeCrm implements Crm {
  readonly objects = new Map<string, Map<string, Record<string, string>>>();
  readonly associations: { fromType: string; fromId: string; toType: string; toId: string }[] = [];
  /** When true, records created through `create` are invisible to `search` (index lag). */
  searchLag = false;
  private readonly unsearchable = new Set<string>();
  private nextId = 1000;
  /** Hook to inject failures: return an error to throw it. */
  failOn?: (op: string, objectType: string, props?: CrmProperties) => Error | undefined;

  seed(objectType: string, props: Record<string, string>, id = String(this.nextId++)): string {
    this.table(objectType).set(id, { hs_object_id: id, ...props });
    return id;
  }

  link(fromType: string, fromId: string, toType: string, toId: string) {
    this.associations.push({ fromType, fromId, toType, toId }, { fromType: toType, fromId: toId, toType: fromType, toId: fromId });
  }

  all(objectType: string): CrmRecord[] {
    return [...this.table(objectType)].map(([id, p]) => ({ id, properties: { ...p } }));
  }

  get(objectType: string, id: string): Record<string, string> | undefined {
    return this.table(objectType).get(id);
  }

  async search(objectType: string, filterGroups: FilterGroup[], properties: string[]): Promise<CrmRecord[]> {
    this.maybeFail('search', objectType);
    return this.all(objectType)
      .filter((r) => !this.unsearchable.has(`${objectType}:${r.id}`))
      .filter((r) =>
        filterGroups.some((g) =>
          g.filters.every((f) => {
            const v = r.properties[f.propertyName]?.toLowerCase();
            if (v === undefined) return false;
            return f.operator === 'EQ' ? v === f.value?.toLowerCase() : (f.values ?? []).some((x) => x.toLowerCase() === v);
          }),
        ),
      )
      .map((r) => pick(r, properties));
  }

  async batchRead(objectType: string, ids: string[], properties: string[]): Promise<CrmRecord[]> {
    this.maybeFail('batchRead', objectType);
    return ids.flatMap((id) => {
      const p = this.get(objectType, id);
      return p ? [pick({ id, properties: p }, properties)] : [];
    });
  }

  async create(objectType: string, props: CrmProperties): Promise<string> {
    this.maybeFail('create', objectType, props);
    const clean = Object.fromEntries(Object.entries(props).filter(([, v]) => v != null)) as Record<string, string>;
    if (objectType === 'contacts' && clean.email) {
      const dup = this.all('contacts').find((c) => c.properties.email === clean.email);
      if (dup) throw new HubSpotError(`Contact already exists. Existing ID: ${dup.id}`, 409, {});
    }
    const now = new Date(Date.now() + this.nextId).toISOString();
    const id = this.seed(objectType, { createdate: now, lastmodifieddate: now, ...clean });
    if (this.searchLag) this.unsearchable.add(`${objectType}:${id}`);
    return id;
  }

  async update(objectType: string, id: string, props: CrmProperties): Promise<void> {
    this.maybeFail('update', objectType, props);
    const rec = this.get(objectType, id);
    if (!rec) throw new HubSpotError(`${objectType} ${id} not found`, 404, {});
    for (const [k, v] of Object.entries(props)) if (v != null) rec[k] = v;
  }

  /** Test helper (not part of Crm). */
  async associatedIds(fromType: string, fromId: string, toType: string): Promise<string[]> {
    return this.associations.filter((a) => a.fromType === fromType && a.fromId === fromId && a.toType === toType).map((a) => a.toId);
  }

  async associateDefault(fromType: string, fromId: string, toType: string, toId: string): Promise<void> {
    this.maybeFail('associate', `${fromType}->${toType}`);
    this.link(fromType, fromId, toType, toId);
  }

  private table(objectType: string) {
    let t = this.objects.get(objectType);
    if (!t) this.objects.set(objectType, (t = new Map()));
    return t;
  }

  private maybeFail(op: string, objectType: string, props?: CrmProperties) {
    const err = this.failOn?.(op, objectType, props);
    if (err) throw err;
  }
}

function pick(r: CrmRecord, properties: string[]): CrmRecord {
  return { id: r.id, properties: Object.fromEntries(properties.map((p) => [p, r.properties[p] ?? null])) };
}
