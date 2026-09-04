import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ScheduledMessage {
  id: string;
  content: string;
  createdAt: string;
  dueAt: string;
}

export default class ScheduledMessageStore {
  private readonly path = process.env.SCHEDULED_MESSAGES_PATH ?? 'scheduled-messages.json';
  private lock = Promise.resolve();

  async schedule(content: string, delayMinutes: number): Promise<ScheduledMessage> {
    return await this.exclusive(async () => {
      const entry = {
        id: randomUUID(),
        content,
        createdAt: new Date().toISOString(),
        dueAt: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
      };
      await this.write([...(await this.read()), entry]);
      return entry;
    });
  }

  async takeDue(): Promise<ScheduledMessage[]> {
    return await this.exclusive(async () => {
      const entries = await this.read();
      const now = Date.now();
      const due = entries.filter((entry) => Date.parse(entry.dueAt) <= now);
      if (due.length > 0) {
        const dueIds = new Set(due.map((entry) => entry.id));
        await this.write(entries.filter((entry) => !dueIds.has(entry.id)));
      }
      return due;
    });
  }

  async restore(entry: ScheduledMessage): Promise<void> {
    await this.exclusive(async () => {
      await this.write([entry, ...(await this.read()).filter((item) => item.id !== entry.id)]);
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release = () => {};
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async read(): Promise<ScheduledMessage[]> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      return Array.isArray(value)
        ? value.filter((entry): entry is ScheduledMessage => this.isEntry(entry))
        : [];
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
        console.warn(`Failed to read scheduled messages from ${this.path}:`, error.message);
      }
      return [];
    }
  }

  private async write(entries: ScheduledMessage[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  }

  private isEntry(value: unknown): value is ScheduledMessage {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const entry = value as Record<string, unknown>;
    return (
      typeof entry.id === 'string' &&
      typeof entry.content === 'string' &&
      typeof entry.createdAt === 'string' &&
      typeof entry.dueAt === 'string' &&
      Number.isFinite(Date.parse(entry.dueAt))
    );
  }
}
