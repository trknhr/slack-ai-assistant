export interface AnthropicManagedAgentsClientOptions {
  apiKeyProvider: () => Promise<string>;
  beta: string;
  apiBaseUrl?: string;
  anthropicVersion?: string;
}

export interface ClaudeContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export type ClaudeInputBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      source:
        | {
            type: "base64";
            media_type: string;
            data: string;
          }
        | {
            type: "url";
            url: string;
          };
    }
  | {
      type: "document";
      title?: string;
      context?: string;
      source:
        | {
            type: "base64";
            media_type: string;
            data: string;
          }
        | {
            type: "text";
            media_type: "text/plain";
            data: string;
          }
        | {
            type: "url";
            url: string;
          }
        | {
            type: "file";
            file_id: string;
          };
    };

export interface ClaudeSessionEvent {
  id: string;
  type: string;
  name?: string;
  input?: Record<string, unknown>;
  processed_at?: string | null;
  content?: ClaudeContentBlock[];
  stop_reason?: {
    type?: string;
    event_ids?: string[];
    [key: string]: unknown;
  };
  error?: {
    type?: string;
    message?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CreateMemoryStoreInput {
  name: string;
  description: string;
}

export interface CreateMemoryStoreResponse {
  id: string;
}

export class AnthropicApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload: string,
  ) {
    super(message);
  }
}

export class AnthropicManagedAgentsClient {
  private readonly apiBaseUrl: string;
  private readonly anthropicVersion: string;

  constructor(private readonly options: AnthropicManagedAgentsClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.anthropic.com";
    this.anthropicVersion = options.anthropicVersion ?? "2023-06-01";
  }

  async createMemoryStore(input: CreateMemoryStoreInput): Promise<CreateMemoryStoreResponse> {
    return this.request<CreateMemoryStoreResponse>("/v1/memory_stores", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async listSessionEvents(
    sessionId: string,
    options: { order?: "asc" | "desc"; limit?: number } = {},
  ): Promise<ClaudeSessionEvent[]> {
    const query = new URLSearchParams();
    if (options.order) {
      query.set("order", options.order);
    }
    if (options.limit) {
      query.set("limit", String(options.limit));
    }

    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const response = await this.request<{ data?: ClaudeSessionEvent[] }>(
      `/v1/sessions/${sessionId}/events${suffix}`,
      { method: "GET" },
    );
    return response.data ?? [];
  }

  async request<T>(path: string, init: RequestInit): Promise<T> {
    const apiKey = await this.options.apiKeyProvider();
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": this.anthropicVersion,
        "anthropic-beta": this.options.beta,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    const payload = await response.text();
    if (!response.ok) {
      throw new AnthropicApiError(
        `Anthropic request failed with status ${response.status}`,
        response.status,
        payload,
      );
    }

    return (payload ? JSON.parse(payload) : {}) as T;
  }
}
