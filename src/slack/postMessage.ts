import { splitTextForSlack } from "../shared/text";

export interface SlackPostMessageInput {
  channel: string;
  text: string;
  threadTs?: string;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

export class SlackWebClient {
  constructor(private readonly tokenProvider: () => Promise<string>) {}

  async postMessage(input: SlackPostMessageInput): Promise<void> {
    const chunks = splitTextForSlack(input.text);

    for (const chunk of chunks) {
      await this.call("chat.postMessage", {
        channel: input.channel,
        text: chunk,
        thread_ts: input.threadTs,
      });
    }
  }

  private async call(method: string, body: Record<string, unknown>): Promise<void> {
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
  }
}
