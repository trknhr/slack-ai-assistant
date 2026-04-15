import { AnthropicManagedAgentsClient, ClaudeInputBlock } from "./client";
import { sendSessionEvents } from "./sendSessionEvents";

export interface SendUserMessageInput {
  sessionId: string;
  content: ClaudeInputBlock[];
}

export async function sendUserMessage(
  client: AnthropicManagedAgentsClient,
  input: SendUserMessageInput,
): Promise<void> {
  await sendSessionEvents(client, input.sessionId, [
    {
      type: "user.message",
      content: input.content,
    },
  ]);
}
