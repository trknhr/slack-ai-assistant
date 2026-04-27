import { normalizeTextForSlack, splitTextForSlack } from "../shared/text";

export type SlackBlock = Record<string, unknown>;

export interface SlackPostMessageInput {
  channel: string;
  text: string;
  threadTs?: string;
  blocks?: SlackBlock[];
}

export interface SlackUpdateMessageInput {
  channel: string;
  ts: string;
  text: string;
  threadTs?: string;
  blocks?: SlackBlock[];
}

interface SlackApiResponse {
  ok: boolean;
  ts?: string;
  error?: string;
}

export interface SlackPostMessageResult {
  ts: string | undefined;
}

export class SlackWebClient {
  constructor(private readonly tokenProvider: () => Promise<string>) {}

  async postMessage(input: SlackPostMessageInput): Promise<SlackPostMessageResult> {
    const chunks = splitTextForSlack(normalizeTextForSlack(input.text));
    let firstMessageTs: string | undefined;

    for (const [index, chunk] of chunks.entries()) {
      const response = await this.call("chat.postMessage", {
        channel: input.channel,
        text: chunk,
        thread_ts: input.threadTs,
        blocks: index === 0 ? input.blocks : undefined,
      });
      firstMessageTs ??= response.ts;
    }

    return {
      ts: firstMessageTs,
    };
  }

  async updateMessage(input: SlackUpdateMessageInput): Promise<void> {
    const chunks = splitTextForSlack(normalizeTextForSlack(input.text));
    const [firstChunk, ...remainingChunks] = chunks;

    await this.call("chat.update", {
      channel: input.channel,
      ts: input.ts,
      text: firstChunk,
      blocks: input.blocks,
    });

    for (const chunk of remainingChunks) {
      await this.call("chat.postMessage", {
        channel: input.channel,
        text: chunk,
        thread_ts: input.threadTs ?? input.ts,
      });
    }
  }

  private async call(method: string, body: Record<string, unknown>): Promise<SlackApiResponse> {
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

    const payload = (await response.json()) as SlackApiResponse;
    if (!payload.ok) {
      throw new Error(`Slack API ${method} returned error: ${payload.error}`);
    }

    return payload;
  }
}
