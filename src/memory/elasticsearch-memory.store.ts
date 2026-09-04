import { createHash } from 'node:crypto';

interface SearchHit {
  _id: string;
  _score?: number;
  _source?: {
    text?: string;
    updatedAt?: string;
    fingerprint?: string;
    reinforcementCount?: number;
  };
}

export interface MemorySearchResult {
  id: string;
  text: string;
  score: number;
  updatedAt?: string;
}

export default class ElasticsearchMemoryStore {
  private readonly index = process.env.ELASTICSEARCH_INDEX ?? 'rampai_memories';

  private readonly url = (process.env.ELASTICSEARCH_URL ?? 'http://localhost:9200').replace(
    /\/$/,
    '',
  );
  private readonly authorization = this.buildAuthorization();
  private indexReady?: Promise<void>;

  async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    await this.ensureIndex();

    const response = await this.request<{ hits?: { hits?: SearchHit[] } }>(
      `/${this.index}/_search`,
      {
        method: 'POST',
        body: JSON.stringify({
          size: limit,
          query: {
            match: {
              text: {
                query,
                fuzziness: 'AUTO',
              },
            },
          },
        }),
      },
    );

    return this.mapHits(response.hits?.hits ?? []);
  }

  async recent(limit = 10): Promise<MemorySearchResult[]> {
    await this.ensureIndex();

    const response = await this.request<{ hits?: { hits?: SearchHit[] } }>(
      `/${this.index}/_search`,
      {
        method: 'POST',
        body: JSON.stringify({
          size: limit,
          query: { match_all: {} },
          sort: [{ updatedAt: { order: 'desc' } }],
        }),
      },
    );

    return this.mapHits(response.hits?.hits ?? []);
  }

  private mapHits(hits: SearchHit[]): MemorySearchResult[] {
    return hits.map((hit) => {
      const result: MemorySearchResult = {
        id: hit._id,
        text: hit._source?.text ?? '',
        score: hit._score ?? 0,
      };

      if (hit._source?.updatedAt) {
        result.updatedAt = hit._source.updatedAt;
      }

      return result;
    });
  }

  async store(text: string): Promise<string> {
    await this.ensureIndex();

    const now = new Date().toISOString();
    const fingerprint = createHash('sha256')
      .update(text.toLocaleLowerCase().replace(/\s+/g, ' ').trim())
      .digest('hex');
    const duplicate = await this.request<{ hits?: { hits?: SearchHit[] } }>(
      `/${this.index}/_search`,
      {
        method: 'POST',
        body: JSON.stringify({ size: 1, query: { term: { fingerprint } } }),
      },
    );
    const existing = duplicate.hits?.hits?.[0];
    if (existing) {
      await this.request(`/${this.index}/_update/${encodeURIComponent(existing._id)}`, {
        method: 'POST',
        body: JSON.stringify({
          script: {
            source:
              'ctx._source.reinforcementCount = (ctx._source.reinforcementCount ?: 1) + 1; ctx._source.updatedAt = params.now',
            params: { now },
          },
        }),
      });
      return existing._id;
    }

    const response = await this.request<{ _id: string }>(`/${this.index}/_doc`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        createdAt: now,
        updatedAt: now,
        fingerprint,
        reinforcementCount: 1,
      }),
    });

    return response._id;
  }

  async update(id: string, text: string): Promise<string> {
    await this.ensureIndex();

    try {
      await this.request(`/${this.index}/_update/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: JSON.stringify({
          doc: {
            text,
            fingerprint: createHash('sha256')
              .update(text.toLocaleLowerCase().replace(/\s+/g, ' ').trim())
              .digest('hex'),
            updatedAt: new Date().toISOString(),
          },
        }),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('document_missing_exception')) {
        return await this.store(text);
      }

      throw error;
    }

    return id;
  }

  async delete(id: string): Promise<string> {
    await this.ensureIndex();

    try {
      await this.request(`/${this.index}/_doc/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('document_missing_exception')) {
        throw error;
      }
    }

    return id;
  }

  async ensureIndex(): Promise<void> {
    if (!this.indexReady) {
      this.indexReady = this.createIndexIfMissing().catch((error) => {
        this.indexReady = undefined;
        throw error;
      });
    }
    await this.indexReady;
  }

  private async createIndexIfMissing(): Promise<void> {
    const exists = await fetch(`${this.url}/${this.index}`, {
      method: 'HEAD',
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });

    if (exists.ok) {
      await this.request(`/${this.index}/_mapping`, {
        method: 'PUT',
        body: JSON.stringify({
          properties: {
            fingerprint: { type: 'keyword' },
            reinforcementCount: { type: 'integer' },
          },
        }),
      });
      return;
    }
    if (exists.status !== 404) {
      throw new Error(`Elasticsearch ${exists.status}: index check failed`);
    }

    await this.request(`/${this.index}`, {
      method: 'PUT',
      body: JSON.stringify({
        mappings: {
          properties: {
            text: { type: 'text' },
            createdAt: { type: 'date' },
            updatedAt: { type: 'date' },
            fingerprint: { type: 'keyword' },
            reinforcementCount: { type: 'integer' },
          },
        },
      }),
    });
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetch(`${this.url}${path}`, {
          ...init,
          headers: this.headers(init.headers),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          return (await response.json()) as T;
        }
        const body = await response.text();
        if (attempt === 2 || (response.status !== 429 && response.status < 500)) {
          throw new Error(`Elasticsearch ${response.status}: ${body}`);
        }
      } catch (error) {
        lastError = error;
        if (attempt === 2) {
          throw error;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Elasticsearch request failed');
  }

  private headers(extra?: HeadersInit): HeadersInit {
    return {
      'content-type': 'application/json',
      ...(this.authorization ? { authorization: this.authorization } : {}),
      ...extra,
    };
  }

  private buildAuthorization(): string | undefined {
    const apiKey = process.env.ELASTICSEARCH_API_KEY?.trim();
    if (apiKey) {
      return `ApiKey ${apiKey}`;
    }
    const username = process.env.ELASTICSEARCH_USERNAME?.trim();
    const password = process.env.ELASTICSEARCH_PASSWORD;
    return username && password
      ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      : undefined;
  }
}
