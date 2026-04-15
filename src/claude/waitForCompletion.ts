import { AnthropicManagedAgentsClient, ClaudeSessionEvent } from "./client";
import { sendSessionEvents } from "./sendSessionEvents";

export interface CustomToolExecutionResult {
  content?: Array<{
    type: "text";
    text: string;
  } | {
    type: "image";
    source:
      | { type: "base64"; media_type: string; data: string }
      | { type: "url"; url: string };
  } | {
    type: "document";
    title?: string;
    context?: string;
    source:
      | { type: "base64"; media_type: string; data: string }
      | { type: "text"; media_type: "text/plain"; data: string }
      | { type: "url"; url: string }
      | { type: "file"; file_id: string };
  }>;
  isError?: boolean;
}

export interface WaitForCompletionInput {
  sessionId: string;
  sinceEventIds?: Iterable<string>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onCustomToolUse?: (event: ClaudeSessionEvent) => Promise<CustomToolExecutionResult>;
}

export interface WaitForCompletionResult {
  text: string;
  events: ClaudeSessionEvent[];
  status: "idle" | "terminated";
}

export async function waitForCompletion(
  client: AnthropicManagedAgentsClient,
  input: WaitForCompletionInput,
): Promise<WaitForCompletionResult> {
  const seen = new Set(input.sinceEventIds ?? []);
  const collected: ClaudeSessionEvent[] = [];
  const timeoutMs = input.timeoutMs ?? 120_000;
  const pollIntervalMs = input.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  const handledToolUseIds = new Set<string>();

  while (Date.now() < deadline) {
    const events = await client.listSessionEvents(input.sessionId, { order: "asc" });
    const fresh = events.filter((event) => !seen.has(event.id));

    for (const event of fresh) {
      seen.add(event.id);
      collected.push(event);
    }

    const sessionError = [...fresh].reverse().find((event) => event.type === "session.error");
    if (sessionError) {
      const message =
        typeof sessionError.error?.message === "string"
          ? sessionError.error.message
          : "Claude session failed";
      throw new Error(message);
    }

    const terminalEvent = [...fresh]
      .reverse()
      .find(
        (event) => event.type === "session.status_idle" || event.type === "session.status_terminated",
      );

    if (terminalEvent) {
      if (
        terminalEvent.type === "session.status_idle" &&
        terminalEvent.stop_reason?.type === "requires_action"
      ) {
        const pendingEventIds = terminalEvent.stop_reason.event_ids ?? [];
        if (!input.onCustomToolUse) {
          throw new Error(
            "Claude session requires custom tool input, but no custom tool executor was provided.",
          );
        }

        const pendingToolEvents = pendingEventIds
          .map((eventId) => events.find((event) => event.id === eventId))
          .filter((event): event is ClaudeSessionEvent => Boolean(event));

        const unsupportedEvent = pendingToolEvents.find(
          (event) => event.type !== "agent.custom_tool_use",
        );
        if (unsupportedEvent) {
          throw new Error(`Unsupported requires_action event type: ${unsupportedEvent.type}`);
        }

        for (const toolUseEvent of pendingToolEvents) {
          if (handledToolUseIds.has(toolUseEvent.id)) {
            continue;
          }

          const result = await input.onCustomToolUse(toolUseEvent);
          await sendSessionEvents(client, input.sessionId, [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: toolUseEvent.id,
              content: result.content,
              is_error: result.isError,
            },
          ]);
          handledToolUseIds.add(toolUseEvent.id);
        }

        await sleep(250);
        continue;
      }

      const text = collected
        .filter((event) => event.type === "agent.message")
        .flatMap((event) => event.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n\n")
        .trim();

      return {
        text: text || "(No text response returned)",
        events: collected,
        status: terminalEvent.type === "session.status_idle" ? "idle" : "terminated",
      };
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for Claude session ${input.sessionId}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
