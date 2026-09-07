import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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

  async list(): Promise<ScheduledMessage[]> {
    return await this.exclusive(async () =>
      (await this.read()).sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt)),
    );
  }

  async cancel(id: string): Promise<boolean> {
    return await this.exclusive(async () => {
      const entries = await this.read();
      const remaining = entries.filter((entry) => entry.id !== id);
      if (remaining.length === entries.length) {
        return false;
      }
      await this.write(remaining);
      return true;
    });
  }

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

  async deliverDue(send: (entry: ScheduledMessage) => Promise<string | undefined>): Promise<void> {
    await this.exclusive(async () => {
      let entries = await this.read();
      const errors: unknown[] = [];
      for (const due of entries.filter((entry) => Date.parse(entry.dueAt) <= Date.now())) {
        let entry = due;
        try {
          while (true) {
            const remaining = await send(entry);
            entries = remaining
              ? entries.map((item) =>
                  item.id === entry.id ? { ...item, content: remaining } : item,
                )
              : entries.filter((item) => item.id !== entry.id);
            await this.write(entries);
            if (!remaining) break;
            entry = { ...entry, content: remaining };
          }
        } catch (error) {
          // Leave failed and unsent content on disk; continue with other due reminders.
          errors.push(error);
          entries = await this.read();
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Some reminders could not be delivered.');
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
      if (!Array.isArray(value) || !value.every((entry) => this.isEntry(entry))) {
        throw new Error('Invalid scheduled-message file; refusing to overwrite it.');
      }
      return value;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
  }

  private async write(entries: ScheduledMessage[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
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
