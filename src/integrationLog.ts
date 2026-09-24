import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';

export interface IntegrationLogEntry {
  requestId: string;
  index: number;
  payload?: unknown;
  status: number;
  responseId: string;
  errorcode?: string;
  action?: string;
  contactId?: string;
  sameTransactionDuplicateOf?: number;
  warnings: string[];
  durationMs: number;
}

/**
 * Equivalent of Salesforce Integration_Logs__c: one JSON line per lead received, written to
 * <dir>/integration-YYYY-MM-DD.jsonl. Doubles as the staging record of every payload received.
 */
export class IntegrationLog {
  private ready: Promise<unknown> | undefined;

  constructor(
    private readonly dir: string,
    private readonly includePayload: boolean,
    private readonly log: Logger,
  ) {}

  async write(entries: IntegrationLogEntry[]): Promise<void> {
    const at = new Date().toISOString();
    const lines = entries
      .map((e) => JSON.stringify({ at, ...e, payload: this.includePayload ? e.payload : undefined }))
      .join('\n');
    try {
      this.ready ??= mkdir(this.dir, { recursive: true });
      await this.ready;
      await appendFile(join(this.dir, `integration-${at.slice(0, 10)}.jsonl`), `${lines}\n`);
    } catch (err) {
      // Never fail the API call because the log could not be written; stdout still has it.
      this.log.error({ err }, 'Could not write integration log');
    }
    for (const e of entries) {
      const { payload: _payload, ...rest } = e;
      (e.status === 200 ? this.log.info.bind(this.log) : this.log.warn.bind(this.log))(rest, 'lead processed');
    }
  }
}
