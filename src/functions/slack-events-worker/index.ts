import type { SQSEvent } from "aws-lambda";
import { SecretsProvider } from "../../aws/secretsProvider";
import { buildSlackContextBlocks, buildTurnText } from "../../conversations/buildSlackContextBlocks";
import { AnthropicManagedAgentsClient } from "../../claude/client";
import { createSession } from "../../claude/createSession";
import { sendUserMessage } from "../../claude/sendUserMessage";
import { waitForCompletion } from "../../claude/waitForCompletion";
import { loadWorkerEnv } from "../../config/env";
import { MEMORY_RESOURCE_PROMPT } from "../../memory/instructions";
import { GoogleCalendarClient } from "../../calendar/googleCalendarClient";
import { CalendarDraftRepository } from "../../repo/calendarDraftRepository";
import { ChannelMemoryRepository } from "../../repo/channelMemoryRepository";
import { MemoryStoreService } from "../../memory/getOrCreateMemoryStore";
import { MemoryItemRepository } from "../../repo/memoryItemRepository";
import { ConversationSessionRepository } from "../../repo/conversationSessionRepository";
import { ConversationTurnRepository } from "../../repo/conversationTurnRepository";
import { SourceDocumentRepository } from "../../repo/sourceDocumentRepository";
import { TaskEventRepository } from "../../repo/taskEventRepository";
import { TaskStateRepository } from "../../repo/taskStateRepository";
import { UserMemoryRepository } from "../../repo/userMemoryRepository";
import { UserPreferenceRepository } from "../../repo/userPreferenceRepository";
import { ConversationSessionRecord, ConversationTurnRecord, slackQueueMessageSchema } from "../../shared/contracts";
import { logger } from "../../shared/logger";
import { SlackConversationsClient, SlackThreadMessage } from "../../slack/conversationsClient";
import { SlackFilesClient } from "../../slack/filesClient";
import { SlackAttachmentArchiveService } from "../../slack/slackAttachmentArchiveService";
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
const slackConversationsClient = new SlackConversationsClient(() =>
  secretsProvider.getSecretString(env.SLACK_BOT_TOKEN_SECRET_ID),
);
const slackFilesClient = new SlackFilesClient(
  () => secretsProvider.getSecretString(env.SLACK_BOT_TOKEN_SECRET_ID),
  env.MAX_SLACK_FILE_BYTES,
);
const calendarDraftRepository = new CalendarDraftRepository(env.CALENDAR_DRAFTS_TABLE_NAME);
const googleCalendarClient = new GoogleCalendarClient({
  secretProvider: () => secretsProvider.getSecretString(env.GOOGLE_CALENDAR_SECRET_ID),
  defaultTimeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
});
const memoryItemRepository = new MemoryItemRepository(env.MEMORY_ITEMS_TABLE_NAME);
const channelMemoryRepository = new ChannelMemoryRepository(env.MEMORY_ITEMS_TABLE_NAME);
const conversationSessionRepository = new ConversationSessionRepository(env.CONVERSATION_SESSIONS_TABLE_NAME);
const conversationTurnRepository = new ConversationTurnRepository(env.CONVERSATION_TURNS_TABLE_NAME);
const sourceDocumentRepository = new SourceDocumentRepository(env.SOURCE_DOCUMENTS_TABLE_NAME);
const taskEventRepository = new TaskEventRepository(env.TASK_EVENTS_TABLE_NAME);
const taskStateRepository = new TaskStateRepository(env.TASKS_TABLE_NAME);
const userMemoryRepository = new UserMemoryRepository(env.USER_MEMORY_TABLE_NAME);
const userPreferenceRepository = new UserPreferenceRepository(env.MEMORY_ITEMS_TABLE_NAME);
const memoryStoreService = new MemoryStoreService(userMemoryRepository, claudeClient);
const attachmentArchiveService = new SlackAttachmentArchiveService(
  env.SLACK_ATTACHMENT_ARCHIVE_BUCKET_NAME,
  sourceDocumentRepository,
);

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const queueMessage = slackQueueMessageSchema.parse(JSON.parse(record.body));
    const log = logger.child({
      correlationId: queueMessage.correlationId,
      eventId: queueMessage.eventId,
      component: "slack-events-worker",
    });

    const now = new Date().toISOString();
    const existingSession = await conversationSessionRepository.findByConversation(
      queueMessage.workspaceId,
      queueMessage.channelId,
      queueMessage.conversationTs,
    );

    if (queueMessage.source === "thread_reply" && !existingSession) {
      log.info("Slack thread reply ignored because no assistant session exists", {
        channelId: queueMessage.channelId,
        conversationTs: queueMessage.conversationTs,
        messageTs: queueMessage.messageTs,
      });
      continue;
    }

    let memoryStoreId = existingSession?.memoryStoreId;
    if (env.ENABLE_USER_MEMORY && !memoryStoreId) {
      const memoryStore = await memoryStoreService.getOrCreateMemoryStore({
        workspaceId: queueMessage.workspaceId,
        userId: queueMessage.userId,
      });
      memoryStoreId = memoryStore.memoryStoreId;
    }

    const sessionRecord =
      existingSession ??
      createConversationSession(
        queueMessage.workspaceId,
        queueMessage.channelId,
        queueMessage.conversationTs,
        memoryStoreId,
      );

    if (!existingSession) {
      const session = await createSession(claudeClient, {
        agentId: env.ANTHROPIC_AGENT_ID,
        environmentId: env.ANTHROPIC_ENVIRONMENT_ID,
        vaultIds: env.ANTHROPIC_VAULT_IDS,
        title: `Slack conversation ${queueMessage.channelId}/${queueMessage.conversationTs}`,
        metadata: {
          workspace_id: queueMessage.workspaceId,
          channel_id: queueMessage.channelId,
          conversation_ts: queueMessage.conversationTs,
          ...(queueMessage.replyThreadTs ? { reply_thread_ts: queueMessage.replyThreadTs } : {}),
          source: "slack",
        },
        memoryResources: memoryStoreId
          ? [
              {
                memoryStoreId,
                access: "read_write",
                prompt: MEMORY_RESOURCE_PROMPT,
              },
            ]
          : [],
      });
      sessionRecord.claudeSessionId = session.id;
      sessionRecord.lastUsedAt = now;
      await conversationSessionRepository.save(sessionRecord);

      if (queueMessage.contextScope === "thread") {
        await backfillThreadHistory(queueMessage, log);
      }
    }

    const seenEventIds = new Set(
      (await claudeClient.listSessionEvents(sessionRecord.claudeSessionId, { order: "asc" })).map(
        (sessionEvent) => sessionEvent.id,
      ),
    );

    const preparedAttachments = await slackFilesClient.prepareAttachments(queueMessage.files);
    await attachmentArchiveService.archiveAttachments({
      workspaceId: queueMessage.workspaceId,
      channelId: queueMessage.channelId,
      threadTs: queueMessage.replyThreadTs ?? queueMessage.conversationTs,
      messageTs: queueMessage.messageTs,
      userId: queueMessage.userId,
      attachments: preparedAttachments,
      logger: log,
    });
    const attachmentBlocks = slackFilesClient.buildContentBlocks(preparedAttachments);

    const priorTurns =
      queueMessage.contextScope === "thread"
        ? await conversationTurnRepository.listByConversation(
            queueMessage.workspaceId,
            queueMessage.channelId,
            queueMessage.conversationTs,
          )
        : await conversationTurnRepository.listRecentChannelTopLevelTurns(
            queueMessage.workspaceId,
            queueMessage.channelId,
            env.TOP_LEVEL_CONTEXT_TURN_LIMIT,
          );

    await conversationTurnRepository.save({
      workspaceId: queueMessage.workspaceId,
      channelId: queueMessage.channelId,
      conversationTs: queueMessage.conversationTs,
      contextScope: queueMessage.contextScope,
      role: "user",
      source: "slack",
      sourceEvent: queueMessage.source,
      threadTs: queueMessage.replyThreadTs,
      messageTs: queueMessage.messageTs,
      turnTs: queueMessage.messageTs,
      userId: queueMessage.userId,
      text: buildTurnText(queueMessage.text, queueMessage.files),
    });

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
        workspaceId: queueMessage.workspaceId,
        userId: queueMessage.userId,
        channelId: queueMessage.channelId,
        logger: log,
      },
      {
        googleCalendar: googleCalendarClient,
        defaultCalendarTimeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
      },
    );

    await sendUserMessage(claudeClient, {
      sessionId: sessionRecord.claudeSessionId,
      content: buildSlackContextBlocks({
        contextScope: queueMessage.contextScope,
        priorTurns,
        currentText: queueMessage.text,
        attachmentBlocks,
      }),
    });

    const completion = await waitForCompletion(claudeClient, {
      sessionId: sessionRecord.claudeSessionId,
      sinceEventIds: seenEventIds,
      timeoutMs: env.AGENT_RESPONSE_TIMEOUT_MS,
      onCustomToolUse: (event) => customToolExecutor.execute(event),
    });

    const postedMessage = await slackClient.postMessage({
      channel: queueMessage.channelId,
      threadTs: queueMessage.replyThreadTs,
      text: completion.text,
    });

    const assistantMessageTs = postedMessage.ts ?? createSyntheticSlackTs();
    await conversationTurnRepository.save({
      workspaceId: queueMessage.workspaceId,
      channelId: queueMessage.channelId,
      conversationTs: queueMessage.conversationTs,
      contextScope: queueMessage.contextScope,
      role: "assistant",
      source: "slack",
      sourceEvent: "assistant_reply",
      threadTs: queueMessage.replyThreadTs,
      messageTs: assistantMessageTs,
      turnTs: assistantMessageTs,
      text: completion.text,
    });

    await conversationSessionRepository.save({
      ...sessionRecord,
      memoryStoreId,
      lastUsedAt: now,
    });

    log.info("Slack conversation processed", {
      claudeSessionId: sessionRecord.claudeSessionId,
      conversationTs: queueMessage.conversationTs,
      contextScope: queueMessage.contextScope,
      status: completion.status,
      attachmentCount: queueMessage.files.length,
      archivedAttachmentCount: preparedAttachments.filter((attachment) => attachment.status === "ready").length,
    });
  }
}

function createConversationSession(
  workspaceId: string,
  channelId: string,
  conversationTs: string,
  memoryStoreId?: string,
): ConversationSessionRecord {
  const now = new Date().toISOString();
  return {
    workspaceId,
    channelId,
    conversationTs,
    claudeSessionId: "",
    memoryStoreId,
    createdAt: now,
    lastUsedAt: now,
  };
}

async function backfillThreadHistory(
  queueMessage: {
    workspaceId: string;
    channelId: string;
    conversationTs: string;
    messageTs: string;
  },
  log: ReturnType<typeof logger.child>,
): Promise<void> {
  const threadMessages = await slackConversationsClient.listReplies(
    queueMessage.channelId,
    queueMessage.conversationTs,
  );
  const priorMessages = threadMessages.filter((message) => compareSlackTs(message.ts, queueMessage.messageTs) < 0);

  for (const message of priorMessages) {
    const text = buildTurnText(message.text, message.files);
    if (!text.trim()) {
      continue;
    }

    await conversationTurnRepository.save({
      workspaceId: queueMessage.workspaceId,
      channelId: queueMessage.channelId,
      conversationTs: queueMessage.conversationTs,
      contextScope: "thread",
      role: inferBackfillRole(message),
      source: "slack",
      sourceEvent: "thread_backfill",
      threadTs: queueMessage.conversationTs,
      messageTs: message.ts,
      turnTs: message.ts,
      userId: message.userId,
      text,
    });
  }

  log.info("Slack thread history backfilled", {
    channelId: queueMessage.channelId,
    conversationTs: queueMessage.conversationTs,
    backfilledTurnCount: priorMessages.length,
  });
}

function inferBackfillRole(message: SlackThreadMessage): ConversationTurnRecord["role"] {
  return message.botId || message.subtype ? "system" : "user";
}

function compareSlackTs(left: string, right: string): number {
  return parseFloat(left) - parseFloat(right);
}

function createSyntheticSlackTs(): string {
  const milliseconds = Date.now();
  const seconds = Math.floor(milliseconds / 1000);
  const micros = `${milliseconds % 1000}`.padStart(3, "0");
  return `${seconds}.${micros}000`;
}
