import { createHash } from "node:crypto";
import type { SQSEvent } from "aws-lambda";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SecretsProvider } from "../../aws/secretsProvider";
import { createUserGoogleCalendarClient } from "../../calendar/userGoogleCalendar";
import { AnthropicManagedAgentsClient } from "../../claude/client";
import { createSession } from "../../claude/createSession";
import { sendUserMessage } from "../../claude/sendUserMessage";
import { waitForCompletion } from "../../claude/waitForCompletion";
import { loadImportWorkerEnv } from "../../config/env";
import { SourceDocument } from "../../documents/sourceDocument";
import { buildClaudeContentBlocksForDocument } from "../../documents/contentBlocks";
import { DocumentImportQueueMessage, documentImportQueueMessageSchema } from "../../imports/contracts";
import { DOCUMENT_IMPORT_MEMORY_INSTRUCTIONS } from "../../memory/instructions";
import { CalendarDraftRepository } from "../../repo/calendarDraftRepository";
import { GoogleOAuthConnectionRepository } from "../../repo/googleOAuthConnectionRepository";
import { MemoryItemRepository } from "../../repo/memoryItemRepository";
import { SourceDocumentRepository } from "../../repo/sourceDocumentRepository";
import { TaskEventRepository } from "../../repo/taskEventRepository";
import { TaskStateRepository } from "../../repo/taskStateRepository";
import { logger } from "../../shared/logger";
import { defaultExtensionForMimeType } from "../../slack/fileSupport";
import { CustomToolExecutor } from "../../tools/executeCustomTool";

const DEFAULT_IMPORT_PROMPT = [
  "Analyze the uploaded household document.",
  DOCUMENT_IMPORT_MEMORY_INSTRUCTIONS,
].join(" ");

const DEFAULT_MARKDOWN_EXTRACTION_PROMPT = [
  "Transcribe the attached PDF into clean Markdown.",
  "Preserve the document structure with headings, paragraphs, lists, and tables when possible.",
  "Do not summarize, omit sections, or add commentary.",
  "If text is unreadable, keep the surrounding structure and mark the uncertain span with [unclear].",
  "Return only Markdown.",
].join(" ");

const env = loadImportWorkerEnv();
const s3 = new S3Client({});
const secretsProvider = new SecretsProvider();
const claudeClient = new AnthropicManagedAgentsClient({
  apiKeyProvider: () => secretsProvider.getSecretString(env.ANTHROPIC_API_KEY_SECRET_ID),
  beta: env.ANTHROPIC_MANAGED_AGENTS_BETA,
});
const calendarDraftRepository = new CalendarDraftRepository(env.CALENDAR_DRAFTS_TABLE_NAME);
const googleOAuthConnectionRepository = new GoogleOAuthConnectionRepository(env.GOOGLE_OAUTH_CONNECTIONS_TABLE_NAME);
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
      if (queueMessage.operation === "extract_markdown") {
        await extractMarkdown(source, queueMessage, bytes, log);
      } else {
        await importDocument(source, queueMessage, bytes, log);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown import worker error";
      await sourceDocumentRepository.save(
        queueMessage.operation === "extract_markdown"
          ? {
              ...source,
              extractionStatus: "failed",
              extractionErrorMessage: message,
              updatedAt: new Date().toISOString(),
            }
          : {
              ...source,
              status: "failed",
              errorMessage: message,
              updatedAt: new Date().toISOString(),
            },
      );
      log.error(
        queueMessage.operation === "extract_markdown"
          ? "Markdown extraction failed"
          : "Document import failed",
        { error: message },
      );
      throw error;
    }
  }
}

function buildImportPrompt(sourceRef: string, prompt?: string): string {
  return `${prompt ?? DEFAULT_IMPORT_PROMPT}\n\nSource path: ${sourceRef}`;
}

function buildMarkdownExtractionPrompt(sourceRef: string, prompt?: string): string {
  return `${prompt ?? DEFAULT_MARKDOWN_EXTRACTION_PROMPT}\n\nSource path: ${sourceRef}`;
}

async function importDocument(
  source: SourceDocument,
  queueMessage: DocumentImportQueueMessage,
  bytes: Buffer,
  log: typeof logger,
): Promise<void> {
  await sourceDocumentRepository.save({
    ...source,
    status: "processing",
    errorMessage: undefined,
    updatedAt: new Date().toISOString(),
  });

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
      calendarDrafts: calendarDraftRepository,
    },
    {
      workspaceId: queueMessage.workspaceId,
      userId: queueMessage.userId,
      logger: log,
    },
    {
      googleCalendarProvider: () =>
        createUserGoogleCalendarClient({
          workspaceId: queueMessage.workspaceId,
          userId: queueMessage.userId,
          defaultTimeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
          googleCalendarSecretId: env.GOOGLE_CALENDAR_SECRET_ID,
          googleOAuthStartUrl: env.GOOGLE_OAUTH_START_URL,
          secretsProvider,
          connections: googleOAuthConnectionRepository,
        }),
      defaultCalendarTimeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
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
}

async function extractMarkdown(
  source: SourceDocument,
  queueMessage: DocumentImportQueueMessage,
  bytes: Buffer,
  log: typeof logger,
): Promise<void> {
  await sourceDocumentRepository.save({
    ...source,
    extractionStatus: "processing",
    extractionErrorMessage: undefined,
    updatedAt: new Date().toISOString(),
  });

  const session = await createSession(claudeClient, {
    agentId: env.ANTHROPIC_AGENT_ID,
    environmentId: env.ANTHROPIC_ENVIRONMENT_ID,
    vaultIds: env.ANTHROPIC_VAULT_IDS,
    title: `Markdown extraction ${source.title}`,
    metadata: {
      source: "markdown_extraction",
      source_id: source.sourceId,
      workspace_id: source.workspaceId,
    },
  });

  const seenEventIds = new Set(
    (await claudeClient.listSessionEvents(session.id, { order: "asc" })).map((sessionEvent) => sessionEvent.id),
  );

  await sendUserMessage(claudeClient, {
    sessionId: session.id,
    content: [
      {
        type: "text",
        text: buildMarkdownExtractionPrompt(source.sourceRef, queueMessage.prompt),
      },
      ...buildClaudeContentBlocksForDocument(source.title, source.mimeType, bytes),
    ],
  });

  const completion = await waitForCompletion(claudeClient, {
    sessionId: session.id,
    sinceEventIds: seenEventIds,
    timeoutMs: env.AGENT_RESPONSE_TIMEOUT_MS,
    onCustomToolUse: async () => ({
      isError: true,
      content: [
        {
          type: "text",
          text: "Custom tools are not available during markdown extraction.",
        },
      ],
    }),
  });

  const markdown = completion.text.trim();
  const now = new Date().toISOString();
  const checksum = createHash("sha256").update(markdown, "utf8").digest("hex");
  const s3Key = buildExtractedMarkdownS3Key(source.workspaceId, source.sourceId, source.title, now);

  await s3.send(
    new PutObjectCommand({
      Bucket: env.DOCUMENT_ARCHIVE_BUCKET_NAME,
      Key: s3Key,
      Body: markdown,
      ContentType: "text/markdown; charset=utf-8",
      Metadata: {
        source_id: source.sourceId,
        workspace_id: source.workspaceId,
        checksum,
      },
    }),
  );

  await sourceDocumentRepository.save({
    ...source,
    extractionStatus: "extracted",
    extractionErrorMessage: undefined,
    extractedMarkdownS3Bucket: env.DOCUMENT_ARCHIVE_BUCKET_NAME,
    extractedMarkdownS3Key: s3Key,
    extractedMarkdownChecksum: checksum,
    extractedMarkdownSize: Buffer.byteLength(markdown, "utf-8"),
    updatedAt: now,
  });

  log.info("Markdown extracted", {
    sessionId: session.id,
    extractedMarkdownS3Key: s3Key,
  });
}

function buildExtractedMarkdownS3Key(
  workspaceId: string,
  sourceId: string,
  title: string,
  timestamp: string,
): string {
  const date = new Date(timestamp);
  const year = `${date.getUTCFullYear()}`;
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const safeName = sanitizeFileName(title, sourceId, "text/markdown");
  return `derived/private/extractions/${workspaceId}/${year}/${month}/${sourceId}/${safeName}`;
}

function sanitizeFileName(fileName: string, sourceId: string, mimeType: string): string {
  const trimmed = fileName.trim();
  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const safeBase = normalized.length > 0 ? normalized : sourceId;
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(safeBase);
  return hasExtension ? safeBase : `${safeBase}${defaultExtensionForMimeType(mimeType)}`;
}
