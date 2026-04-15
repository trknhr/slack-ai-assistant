import { AnthropicManagedAgentsClient, ClaudeInputBlock } from "./client";

export type ClaudeUserEvent =
  | {
      type: "user.message";
      content: ClaudeInputBlock[];
    }
  | {
      type: "user.custom_tool_result";
      custom_tool_use_id: string;
      content?: ClaudeInputBlock[];
      is_error?: boolean;
    };

export async function sendSessionEvents(
  client: AnthropicManagedAgentsClient,
  sessionId: string,
  events: ClaudeUserEvent[],
): Promise<void> {
  await client.request<{ data: Array<{ id: string; type: string }> }>(
    `/v1/sessions/${sessionId}/events`,
    {
      method: "POST",
      body: JSON.stringify({ events }),
    },
  );
}
