import type { SQSEvent } from "aws-lambda";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SecretsProvider } from "../../aws/secretsProvider";
import { AnthropicManagedAgentsClient } from "../../claude/client";
import { createSession } from "../../claude/createSession";
import { sendUserMessage } from "../../claude/sendUserMessage";
import { waitForCompletion } from "../../claude/waitForCompletion";
import { loadImportWorkerEnv } from "../../config/env";
import { buildClaudeContentBlocksForDocument } from "../../documents/contentBlocks";
import { documentImportQueueMessageSchema } from "../../imports/contracts";
import { MemoryItemRepository } from "../../repo/memoryItemRepository";
import { SourceDocumentRepository } from "../../repo/sourceDocumentRepository";
import { TaskEventRepository } from "../../repo/taskEventRepository";
import { TaskStateRepository } from "../../repo/taskStateRepository";
import { logger } from "../../shared/logger";
import { CustomToolExecutor } from "../../tools/executeCustomTool";

const DEFAULT_IMPORT_PROMPT = [
  "Analyze the uploaded household document.",
  "Save durable facts with save_memory when they are useful long-term.",
  "Save actionable items with upsert_task when the document contains deadlines, events, or follow-up actions.",
  "Do not save low-value noise.",
  "Reply with a concise summary of what you captured.",
].join(" ");

const env = loadImportWorkerEnv();
const s3 = new S3Client({});
const secretsProvider = new SecretsProvider();
const claudeClient = new AnthropicManagedAgentsClient({
  apiKeyProvider: () => secretsProvider.getSecretString(env.ANTHROPIC_API_KEY_SECRET_ID),
  beta: env.ANTHROPIC_MANAGED_AGENTS_BETA,
});
const memoryItemRepository = new MemoryItemRepository(env.MEMORY_ITEMS_TABLE_NAME);
const taskEventRepository = new TaskEventRepository(env.TASK_EVENTS_TABLE_NAME);
const taskStateRepository = new TaskStateRepository(env.TASKS_TABLE_NAME);
const sourceDocumentRepository = new SourceDocumentRepository(env.SOURCE_DOCUMENTS_TABLE_NAME);

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    const queueMessage = documentImportQueueMessageSchema.parse(JSON.parse(record.body));
    const log = logger.child({
      correlationId: queueMessage.correlationId,
      sourceId: queueMessage.sourceId,
      component: "document-import-worker",
    });

    const source = await sourceDocumentRepository.get(queueMessage.workspaceId, queueMessage.sourceId);
    if (!source) {
      throw new Error(`Source document ${queueMessage.sourceId} was not found`);
    }
    if (!source.s3Bucket || !source.s3Key) {
      throw new Error(`Source document ${queueMessage.sourceId} is missing archive coordinates`);
    }

    await sourceDocumentRepository.save({
      ...source,
      status: "processing",
      errorMessage: undefined,
      updatedAt: new Date().toISOString(),
    });

    try {
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: source.s3Bucket,
          Key: source.s3Key,
        }),
      );
      if (!object.Body) {
        throw new Error("S3 object body is empty");
      }

      const bytes = Buffer.from(await object.Body.transformToByteArray());
      const session = await createSession(claudeClient, {
        agentId: env.ANTHROPIC_AGENT_ID,
        environmentId: env.ANTHROPIC_ENVIRONMENT_ID,
        vaultIds: env.ANTHROPIC_VAULT_IDS,
        title: `Imported document ${source.title}`,
        metadata: {
          source: "local_import",
          source_id: source.sourceId,
          workspace_id: source.workspaceId,
        },
      });

      const seenEventIds = new Set(
        (await claudeClient.listSessionEvents(session.id, { order: "asc" })).map((sessionEvent) => sessionEvent.id),
      );

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
        sessionId: session.id,
        content: [
          {
            type: "text",
            text: buildImportPrompt(source.sourceRef, queueMessage.prompt),
          },
          ...buildClaudeContentBlocksForDocument(source.title, source.mimeType, bytes),
        ],
      });

      const completion = await waitForCompletion(claudeClient, {
        sessionId: session.id,
        sinceEventIds: seenEventIds,
        timeoutMs: env.AGENT_RESPONSE_TIMEOUT_MS,
        onCustomToolUse: (sessionEvent) => customToolExecutor.execute(sessionEvent),
      });
      const summary = customToolExecutor.getSummary();

      await sourceDocumentRepository.save({
        ...source,
        status: "imported",
        summary: completion.text,
        importedTaskIds: summary.taskIds,
        savedMemoryIds: summary.savedMemoryIds,
        errorMessage: undefined,
        updatedAt: new Date().toISOString(),
      });

      log.info("Document imported", {
        sessionId: session.id,
        taskCount: summary.taskIds.length,
        memoryCount: summary.savedMemoryIds.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown import worker error";
      await sourceDocumentRepository.save({
        ...source,
        status: "failed",
        errorMessage: message,
        updatedAt: new Date().toISOString(),
      });
      log.error("Document import failed", { error: message });
      throw error;
    }
  }
}

function buildImportPrompt(sourceRef: string, prompt?: string): string {
  return `${prompt ?? DEFAULT_IMPORT_PROMPT}\n\nSource path: ${sourceRef}`;
}
