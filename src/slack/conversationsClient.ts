import { SlackFileReference } from "../shared/contracts";

interface SlackRepliesResponse {
  ok: boolean;
  error?: string;
  response_metadata?: {
    next_cursor?: string;
  };
  messages?: Array<Record<string, unknown>>;
}

export interface SlackThreadMessage {
  ts: string;
  threadTs?: string;
  text: string;
  userId?: string;
  botId?: string;
  subtype?: string;
  files: SlackFileReference[];
}

export class SlackConversationsClient {
  constructor(private readonly tokenProvider: () => Promise<string>) {}

  async listReplies(channel: string, threadTs: string): Promise<SlackThreadMessage[]> {
    const messages: SlackThreadMessage[] = [];
    let cursor: string | undefined;

    do {
      const payload = await this.call("conversations.replies", {
        channel,
        ts: threadTs,
        limit: 200,
        cursor,
      });

      for (const message of payload.messages ?? []) {
        const parsed = toSlackThreadMessage(message);
        if (parsed) {
          messages.push(parsed);
        }
      }

      cursor = payload.response_metadata?.next_cursor || undefined;
    } while (cursor);

    messages.sort((left, right) => left.ts.localeCompare(right.ts));
    return messages;
  }

  private async call(method: string, body: Record<string, unknown>): Promise<SlackRepliesResponse> {
    const token = await this.tokenProvider();
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Slack API ${method} failed with status ${response.status}`);
    }

    const payload = (await response.json()) as SlackRepliesResponse;
    if (!payload.ok) {
      throw new Error(`Slack API ${method} returned error: ${payload.error}`);
    }

    return payload;
  }
}

function toSlackThreadMessage(message: Record<string, unknown>): SlackThreadMessage | null {
  const ts = typeof message.ts === "string" ? message.ts : "";
  if (!ts) {
    return null;
  }

  const text = typeof message.text === "string" ? message.text : "";
  const files = extractFiles(message.files);
  if (!text.trim() && files.length === 0) {
    return null;
  }

  return {
    ts,
    threadTs: typeof message.thread_ts === "string" ? message.thread_ts : undefined,
    text,
    userId: typeof message.user === "string" ? message.user : undefined,
    botId: typeof message.bot_id === "string" ? message.bot_id : undefined,
    subtype: typeof message.subtype === "string" ? message.subtype : undefined,
    files,
  };
}

function extractFiles(value: unknown): SlackFileReference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => toSlackFileReference(entry))
    .filter((entry): entry is SlackFileReference => entry !== null);
}

function toSlackFileReference(value: unknown): SlackFileReference | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const file = value as Record<string, unknown>;
  const id = typeof file.id === "string" ? file.id : "";
  if (!id) {
    return null;
  }

  return {
    id,
    name: typeof file.name === "string" ? file.name : undefined,
    title: typeof file.title === "string" ? file.title : undefined,
    mimetype: typeof file.mimetype === "string" ? file.mimetype : undefined,
    fileAccess: typeof file.file_access === "string" ? file.file_access : undefined,
    urlPrivate: typeof file.url_private === "string" ? file.url_private : undefined,
    urlPrivateDownload:
      typeof file.url_private_download === "string" ? file.url_private_download : undefined,
    permalink: typeof file.permalink === "string" ? file.permalink : undefined,
    isExternal: typeof file.is_external === "boolean" ? file.is_external : undefined,
    externalUrl: typeof file.external_url === "string" ? file.external_url : undefined,
    size: typeof file.size === "number" ? file.size : undefined,
  };
}
