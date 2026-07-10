import type { Client, ClientEvents } from 'discord.js';

abstract class AsyncEventHandler<T extends keyof ClientEvents> {
  protected client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  abstract handle(...event: ClientEvents[T]): Promise<void>;
}

export { AsyncEventHandler };
