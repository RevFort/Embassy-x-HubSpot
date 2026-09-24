import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';

export interface IntegrationLogEntry {
  requestId: string;
  payload?: unknown;
  status: number;
  responseId: string;
  errorcode?: string;
  action?: string;
  contactId?: string;
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

  async write(entry: IntegrationLogEntry): Promise<void> {
    const at = new Date().toISOString();
    const line = JSON.stringify({ at, ...entry, payload: this.includePayload ? entry.payload : undefined });
    try {
      this.ready ??= mkdir(this.dir, { recursive: true });
      await this.ready;
      await appendFile(join(this.dir, `integration-${at.slice(0, 10)}.jsonl`), `${line}\n`);
    } catch (err) {
      // Never fail the API call because the log could not be written; stdout still has it.
      this.log.error({ err }, 'Could not write integration log');
    }
    const { payload: _payload, ...rest } = entry;
    (entry.status === 200 ? this.log.info.bind(this.log) : this.log.warn.bind(this.log))(rest, 'lead processed');
  }
}
