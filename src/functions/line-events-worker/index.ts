import type { SQSEvent } from "aws-lambda";
import { AgentCoreRuntimeClient } from "../../agentcore/client";
import { buildAgentRuntimeResources } from "../../agentcore/contracts";
import { SecretsProvider } from "../../aws/secretsProvider";
import { buildLineContextBlocks } from "../../conversations/buildLineContextBlocks";
import { loadLineWorkerEnv } from "../../config/env";
import { LineMessagingClient } from "../../line/postMessage";
import { ConversationSessionRepository } from "../../repo/conversationSessionRepository";
import { ConversationTurnRepository } from "../../repo/conversationTurnRepository";
import { ConversationSessionRecord, lineQueueMessageSchema } from "../../shared/contracts";
import { logger } from "../../shared/logger";

const env = loadLineWorkerEnv();
const secretsProvider = new SecretsProvider();
const agentClient = new AgentCoreRuntimeClient({
  runtimeArn: env.AGENTCORE_RUNTIME_ARN,
  qualifier: env.AGENTCORE_RUNTIME_QUALIFIER,
});
const lineClient = new LineMessagingClient(() =>
  secretsProvider.getSecretString(env.LINE_CHANNEL_ACCESS_TOKEN_SECRET_ID),
);
const conversationSessionRepository = new ConversationSessionRepository(env.CONVERSATION_SESSIONS_TABLE_NAME);
const conversationTurnRepository = new ConversationTurnRepository(env.CONVERSATION_TURNS_TABLE_NAME);

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const queueMessage = lineQueueMessageSchema.parse(JSON.parse(record.body));
    const log = logger.child({
      correlationId: queueMessage.correlationId,
      eventId: queueMessage.eventId,
      component: "line-events-worker",
    });

    const now = new Date().toISOString();
    const existingSession = await conversationSessionRepository.findByConversation(
      queueMessage.workspaceId,
      queueMessage.channelId,
      queueMessage.conversationTs,
    );
    const sessionRecord =
      existingSession ??
      createConversationSession(
        queueMessage.workspaceId,
        queueMessage.channelId,
        queueMessage.conversationTs,
      );

    if (!existingSession) {
      await conversationSessionRepository.save(sessionRecord);
    }

    const priorTurns = await conversationTurnRepository.listRecentChannelTopLevelTurns(
      queueMessage.workspaceId,
      queueMessage.channelId,
      env.TOP_LEVEL_CONTEXT_TURN_LIMIT,
    );

    await conversationTurnRepository.save({
      workspaceId: queueMessage.workspaceId,
      channelId: queueMessage.channelId,
      conversationTs: queueMessage.conversationTs,
      contextScope: "channel_top_level",
      role: "user",
      source: "line",
      sourceEvent: "line_message",
      messageTs: queueMessage.messageTs,
      turnTs: queueMessage.messageTs,
      userId: queueMessage.userId,
      text: queueMessage.text,
    });

    const completion = await agentClient.invoke({
      sessionId: sessionRecord.agentRuntimeSessionId,
      runtimeUserId: queueMessage.userId,
      request: {
        content: buildLineContextBlocks({
          priorTurns,
          currentText: queueMessage.text,
        }),
        context: {
          source: "line",
          workspaceId: queueMessage.workspaceId,
          userId: queueMessage.userId,
          channelId: queueMessage.channelId,
          conversationTs: queueMessage.conversationTs,
        },
        resources: buildAgentRuntimeResources(env),
        toolContext: {
          workspaceId: queueMessage.workspaceId,
          userId: queueMessage.userId,
          channelId: queueMessage.channelId,
          memoryWritePolicy: {
            allowWorkspaceMemory: false,
            channelInferredStatus: "candidate",
            defaultOrigin: "inferred",
          },
        },
      },
    });

    await lineClient.pushText(queueMessage.responseTargetId, completion.text);

    const assistantMessageTs = createSyntheticLineTs();
    await conversationTurnRepository.save({
      workspaceId: queueMessage.workspaceId,
      channelId: queueMessage.channelId,
      conversationTs: queueMessage.conversationTs,
      contextScope: "channel_top_level",
      role: "assistant",
      source: "line",
      sourceEvent: "line_assistant_reply",
      messageTs: assistantMessageTs,
      turnTs: assistantMessageTs,
      text: completion.text,
    });

    await conversationSessionRepository.save({
      ...sessionRecord,
      agentRuntimeSessionId: completion.sessionId ?? sessionRecord.agentRuntimeSessionId,
      lastUsedAt: now,
    });

    log.info("LINE conversation processed", {
      agentRuntimeSessionId: completion.sessionId ?? sessionRecord.agentRuntimeSessionId,
      conversationTs: queueMessage.conversationTs,
      status: completion.status,
      responseTargetType: queueMessage.responseTargetType,
    });
  }
}

function createConversationSession(
  workspaceId: string,
  channelId: string,
  conversationTs: string,
): ConversationSessionRecord {
  const now = new Date().toISOString();
  return {
    workspaceId,
    channelId,
    conversationTs,
    createdAt: now,
    lastUsedAt: now,
  };
}

function createSyntheticLineTs(): string {
  return `${Date.now()}.${Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0")}`;
}
