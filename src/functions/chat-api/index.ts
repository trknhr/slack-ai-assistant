import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { SecretsProvider } from "../../aws/secretsProvider";
import { GoogleCalendarClient } from "../../calendar/googleCalendarClient";
import { chatMessageRequestSchema } from "../../chat/contracts";
import { AnthropicManagedAgentsClient } from "../../claude/client";
import { createSession } from "../../claude/createSession";
import { sendUserMessage } from "../../claude/sendUserMessage";
import { waitForCompletion } from "../../claude/waitForCompletion";
import { loadChatApiEnv } from "../../config/env";
import { MEMORY_RESOURCE_PROMPT } from "../../memory/instructions";
import { MemoryStoreService } from "../../memory/getOrCreateMemoryStore";
import { CalendarDraftRepository } from "../../repo/calendarDraftRepository";
import { ChannelMemoryRepository } from "../../repo/channelMemoryRepository";
import { MemoryItemRepository } from "../../repo/memoryItemRepository";
import { TaskEventRepository } from "../../repo/taskEventRepository";
import { TaskStateRepository } from "../../repo/taskStateRepository";
import { UserMemoryRepository } from "../../repo/userMemoryRepository";
import { UserPreferenceRepository } from "../../repo/userPreferenceRepository";
import { logger } from "../../shared/logger";
import { CustomToolExecutor } from "../../tools/executeCustomTool";

const env = loadChatApiEnv();
const secretsProvider = new SecretsProvider();
const claudeClient = new AnthropicManagedAgentsClient({
  apiKeyProvider: () => secretsProvider.getSecretString(env.ANTHROPIC_API_KEY_SECRET_ID),
  beta: env.ANTHROPIC_MANAGED_AGENTS_BETA,
});
const calendarDraftRepository = new CalendarDraftRepository(env.CALENDAR_DRAFTS_TABLE_NAME);
const googleCalendarClient = new GoogleCalendarClient({
  secretProvider: () => secretsProvider.getSecretString(env.GOOGLE_CALENDAR_SECRET_ID),
  defaultTimeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
});
const memoryItemRepository = new MemoryItemRepository(env.MEMORY_ITEMS_TABLE_NAME);
const channelMemoryRepository = new ChannelMemoryRepository(env.MEMORY_ITEMS_TABLE_NAME);
const taskEventRepository = new TaskEventRepository(env.TASK_EVENTS_TABLE_NAME);
const taskStateRepository = new TaskStateRepository(env.TASKS_TABLE_NAME);
const userMemoryRepository = new UserMemoryRepository(env.USER_MEMORY_TABLE_NAME);
const userPreferenceRepository = new UserPreferenceRepository(env.MEMORY_ITEMS_TABLE_NAME);
const memoryStoreService = new MemoryStoreService(userMemoryRepository, claudeClient);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  const log = logger.child({ requestId, component: "chat-api" });

  try {
    if (event.httpMethod === "POST" && event.resource === "/chat/messages") {
      return postMessage(event, log);
    }

    return response(404, { ok: false, error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown chat API error";
    log.error("Chat API failed", { error: message });
    const statusCode = message.startsWith("Timed out waiting for Claude session") ? 504 : 500;
    return response(statusCode, { ok: false, error: "internal_error", message });
  }
}

async function postMessage(
  event: APIGatewayProxyEvent,
  log: typeof logger,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody(event);
  const input = chatMessageRequestSchema.parse(body);
  const now = new Date().toISOString();

  let sessionId = input.sessionId;
  if (!sessionId) {
    let memoryResources: Array<{
      memoryStoreId: string;
      access: "read_write";
      prompt: string;
    }> = [];

    if (env.ENABLE_USER_MEMORY) {
      const memoryStore = await memoryStoreService.getOrCreateMemoryStore({
        workspaceId: input.workspaceId,
        userId: input.userId,
      });
      memoryResources = [
        {
          memoryStoreId: memoryStore.memoryStoreId,
          access: "read_write",
          prompt: MEMORY_RESOURCE_PROMPT,
        },
      ];
    }

    const session = await createSession(claudeClient, {
      agentId: env.ANTHROPIC_AGENT_ID,
      environmentId: env.ANTHROPIC_ENVIRONMENT_ID,
      vaultIds: env.ANTHROPIC_VAULT_IDS,
      title: `Direct chat ${input.workspaceId}/${input.userId}`,
      metadata: {
        source: "direct_chat_api",
        workspace_id: input.workspaceId,
        user_id: input.userId,
        created_at: now,
      },
      memoryResources,
    });
    sessionId = session.id;
  }

  const seenEventIds = new Set(
    (await claudeClient.listSessionEvents(sessionId, { order: "asc" })).map((sessionEvent) => sessionEvent.id),
  );
  const customToolExecutor = new CustomToolExecutor(
    {
      memoryItems: memoryItemRepository,
      channelMemories: channelMemoryRepository,
      userPreferences: userPreferenceRepository,
      tasks: taskStateRepository,
      taskEvents: taskEventRepository,
      calendarDrafts: calendarDraftRepository,
    },
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      logger: log,
    },
    {
      googleCalendar: googleCalendarClient,
      defaultCalendarTimeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
    },
  );

  await sendUserMessage(claudeClient, {
    sessionId,
    content: [
      {
        type: "text",
        text: input.text,
      },
    ],
  });

  const completion = await waitForCompletion(claudeClient, {
    sessionId,
    sinceEventIds: seenEventIds,
    timeoutMs: Math.min(env.AGENT_RESPONSE_TIMEOUT_MS, 25_000),
    onCustomToolUse: (sessionEvent) => customToolExecutor.execute(sessionEvent),
  });
  const summary = customToolExecutor.getSummary();

  return response(200, {
    ok: true,
    sessionId,
    text: completion.text,
    taskIds: summary.taskIds,
    savedMemoryIds: summary.savedMemoryIds,
  });
}

function parseJsonBody(event: APIGatewayProxyEvent): unknown {
  const body = event.body ?? "{}";
  const text = event.isBase64Encoded ? Buffer.from(body, "base64").toString("utf-8") : body;
  return JSON.parse(text);
}

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  };
}
