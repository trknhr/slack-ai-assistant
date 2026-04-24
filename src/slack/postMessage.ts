import { normalizeTextForSlack, splitTextForSlack } from "../shared/text";

export interface SlackPostMessageInput {
  channel: string;
  text: string;
  threadTs?: string;
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

    for (const chunk of chunks) {
      const response = await this.call("chat.postMessage", {
        channel: input.channel,
        text: chunk,
        thread_ts: input.threadTs,
      });
      firstMessageTs ??= response.ts;
    }

    return {
      ts: firstMessageTs,
    };
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
