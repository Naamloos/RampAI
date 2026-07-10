interface SearchHit {
  _id: string;
  _score?: number;
  _source?: {
    text?: string;
    updatedAt?: string;
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
    const response = await this.request<{ _id: string }>(`/${this.index}/_doc`, {
      method: 'POST',
      body: JSON.stringify({ text, createdAt: now, updatedAt: now }),
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
    const exists = await fetch(`${this.url}/${this.index}`, { method: 'HEAD' });
    if (exists.ok) {
      return;
    }

    await this.request(`/${this.index}`, {
      method: 'PUT',
      body: JSON.stringify({
        mappings: {
          properties: {
            text: { type: 'text' },
            createdAt: { type: 'date' },
            updatedAt: { type: 'date' },
          },
        },
      }),
    });
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...init.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`Elasticsearch ${response.status}: ${await response.text()}`);
    }

    return (await response.json()) as T;
  }
}
