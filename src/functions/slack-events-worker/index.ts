import type { SQSEvent } from "aws-lambda";
import { SecretsProvider } from "../../aws/secretsProvider";
import { AnthropicManagedAgentsClient } from "../../claude/client";
import { createSession } from "../../claude/createSession";
import { sendUserMessage } from "../../claude/sendUserMessage";
import { waitForCompletion } from "../../claude/waitForCompletion";
import { loadWorkerEnv } from "../../config/env";
import { MemoryStoreService } from "../../memory/getOrCreateMemoryStore";
import { MemoryItemRepository } from "../../repo/memoryItemRepository";
import { SessionRepository } from "../../repo/sessionRepository";
import { TaskEventRepository } from "../../repo/taskEventRepository";
import { TaskStateRepository } from "../../repo/taskStateRepository";
import { UserMemoryRepository } from "../../repo/userMemoryRepository";
import { slackQueueMessageSchema, ThreadSessionRecord } from "../../shared/contracts";
import { logger } from "../../shared/logger";
import { SlackFilesClient } from "../../slack/filesClient";
import { SlackWebClient } from "../../slack/postMessage";
import { CustomToolExecutor } from "../../tools/executeCustomTool";

const env = loadWorkerEnv();
const secretsProvider = new SecretsProvider();
const claudeClient = new AnthropicManagedAgentsClient({
  apiKeyProvider: () => secretsProvider.getSecretString(env.ANTHROPIC_API_KEY_SECRET_ID),
  beta: env.ANTHROPIC_MANAGED_AGENTS_BETA,
});
const slackClient = new SlackWebClient(() =>
  secretsProvider.getSecretString(env.SLACK_BOT_TOKEN_SECRET_ID),
);
const slackFilesClient = new SlackFilesClient(
  () => secretsProvider.getSecretString(env.SLACK_BOT_TOKEN_SECRET_ID),
  env.MAX_SLACK_FILE_BYTES,
);
const memoryItemRepository = new MemoryItemRepository(env.MEMORY_ITEMS_TABLE_NAME);
const sessionRepository = new SessionRepository(env.SESSION_TABLE_NAME);
const taskEventRepository = new TaskEventRepository(env.TASK_EVENTS_TABLE_NAME);
const taskStateRepository = new TaskStateRepository(env.TASKS_TABLE_NAME);
const userMemoryRepository = new UserMemoryRepository(env.USER_MEMORY_TABLE_NAME);
const memoryStoreService = new MemoryStoreService(userMemoryRepository, claudeClient);

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const queueMessage = slackQueueMessageSchema.parse(JSON.parse(record.body));
    const log = logger.child({
      correlationId: queueMessage.correlationId,
      eventId: queueMessage.eventId,
      component: "slack-events-worker",
    });

    const now = new Date().toISOString();
    const existingSession = await sessionRepository.findByThread(
      queueMessage.workspaceId,
      queueMessage.channelId,
      queueMessage.threadTs,
    );

    let memoryStoreId = existingSession?.memoryStoreId;
    if (env.ENABLE_USER_MEMORY) {
      const memoryStore = await memoryStoreService.getOrCreateMemoryStore({
        workspaceId: queueMessage.workspaceId,
        userId: queueMessage.userId,
      });
      memoryStoreId = memoryStore.memoryStoreId;
    }

    const sessionRecord =
      existingSession ??
      createThreadSession(
        queueMessage.workspaceId,
        queueMessage.channelId,
        queueMessage.threadTs,
        memoryStoreId,
      );

    if (!existingSession) {
      const session = await createSession(claudeClient, {
        agentId: env.ANTHROPIC_AGENT_ID,
        environmentId: env.ANTHROPIC_ENVIRONMENT_ID,
        vaultIds: env.ANTHROPIC_VAULT_IDS,
        title: `Slack thread ${queueMessage.channelId}/${queueMessage.threadTs}`,
        metadata: {
          workspace_id: queueMessage.workspaceId,
          channel_id: queueMessage.channelId,
          thread_ts: queueMessage.threadTs,
          source: "slack",
        },
        memoryResources: memoryStoreId
          ? [
              {
                memoryStoreId,
                access: "read_write",
                prompt: "User preferences and durable project context. Check before you answer.",
              },
            ]
          : [],
      });
      sessionRecord.sessionId = session.id;
      sessionRecord.lastUsedAt = now;
      await sessionRepository.save(sessionRecord);
    }

    const seenEventIds = new Set(
      (await claudeClient.listSessionEvents(sessionRecord.sessionId, { order: "asc" })).map(
        (sessionEvent) => sessionEvent.id,
      ),
    );

    const attachmentBlocks = await slackFilesClient.buildContentBlocks(queueMessage.files);
    const customToolExecutor = new CustomToolExecutor(
      {
        memoryItems: memoryItemRepository,
        tasks: taskStateRepository,
        taskEvents: taskEventRepository,
      },
      {
        workspaceId: queueMessage.workspaceId,
        userId: queueMessage.userId,
        logger: log,
      },
    );

    await sendUserMessage(claudeClient, {
      sessionId: sessionRecord.sessionId,
      content: [
        {
          type: "text",
          text: queueMessage.text,
        },
        ...attachmentBlocks,
      ],
    });

    const completion = await waitForCompletion(claudeClient, {
      sessionId: sessionRecord.sessionId,
      sinceEventIds: seenEventIds,
      timeoutMs: env.AGENT_RESPONSE_TIMEOUT_MS,
      onCustomToolUse: (event) => customToolExecutor.execute(event),
    });

    await slackClient.postMessage({
      channel: queueMessage.channelId,
      threadTs: queueMessage.threadTs,
      text: completion.text,
    });

    await sessionRepository.save({
      ...sessionRecord,
      memoryStoreId,
      lastUsedAt: now,
    });

    log.info("Slack thread processed", {
      sessionId: sessionRecord.sessionId,
      status: completion.status,
      attachmentCount: queueMessage.files.length,
    });
  }
}

function createThreadSession(
  workspaceId: string,
  channelId: string,
  threadTs: string,
  memoryStoreId?: string,
): ThreadSessionRecord {
  const now = new Date().toISOString();
  return {
    workspaceId,
    channelId,
    threadTs,
    sessionId: "",
    memoryStoreId,
    createdAt: now,
    lastUsedAt: now,
  };
}
