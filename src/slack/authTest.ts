export interface SlackAuthTestResponse {
  ok: boolean;
  url?: string;
  team?: string;
  team_id?: string;
  user?: string;
  user_id?: string;
  bot_id?: string;
  error?: string;
}

export class SlackApiError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class SlackAuthClient {
  constructor(private readonly tokenProvider: () => Promise<string>) {}

  async authTest(): Promise<SlackAuthTestResponse> {
    const token = await this.tokenProvider();
    const response = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new SlackApiError(`Slack auth.test failed with status ${response.status}`);
    }

    const payload = (await response.json()) as SlackAuthTestResponse;
    if (!payload.ok) {
      throw new SlackApiError(`Slack auth.test returned error: ${payload.error}`);
    }

    return payload;
  }
}
