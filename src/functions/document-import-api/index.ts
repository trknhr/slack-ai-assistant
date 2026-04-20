import { createHash, randomUUID } from "node:crypto";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { loadImportApiEnv } from "../../config/env";
import {
  createImportUploadRequestSchema,
  ingestMarkdownRequestSchema,
  queueMarkdownExtractionRequestSchema,
  queueImportRequestSchema,
} from "../../imports/contracts";
import { SourceDocument } from "../../documents/sourceDocument";
import { SourceDocumentRepository } from "../../repo/sourceDocumentRepository";
import { logger } from "../../shared/logger";
import { defaultExtensionForMimeType, isSupportedLocalImportMimeType } from "../../slack/fileSupport";

const env = loadImportApiEnv();
const s3 = new S3Client({});
const sqs = new SQSClient({});
const sourceDocumentRepository = new SourceDocumentRepository(env.SOURCE_DOCUMENTS_TABLE_NAME);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  const log = logger.child({ requestId, component: "document-import-api" });

  try {
    if (event.httpMethod === "POST" && event.resource === "/imports/uploads") {
      return createUpload(event, log);
    }

    if (event.httpMethod === "POST" && event.resource === "/imports/documents") {
      return queueDocumentImport(event, log);
    }

    if (event.httpMethod === "POST" && event.resource === "/imports/markdown") {
      return ingestMarkdown(event, log);
    }

    if (event.httpMethod === "POST" && event.resource === "/imports/extractions/markdown") {
      return queueMarkdownExtraction(event, log);
    }

    if (
      event.httpMethod === "GET" &&
      event.resource === "/imports/workspaces/{workspaceId}/sources/{sourceId}"
    ) {
      return getSourceStatus(event);
    }

    if (
      event.httpMethod === "GET" &&
      event.resource === "/imports/workspaces/{workspaceId}/sources/{sourceId}/markdown"
    ) {
      return getExtractedMarkdown(event);
    }

    return response(404, { ok: false, error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown import API error";
    log.error("Document import API failed", { error: message });
    return response(500, { ok: false, error: "internal_error", message });
  }
}

async function createUpload(
  event: APIGatewayProxyEvent,
  log: typeof logger,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody(event);
  const input = createImportUploadRequestSchema.parse(body);
  if (!isSupportedLocalImportMimeType(input.mimeType)) {
    return response(400, {
      ok: false,
      error: "unsupported_mime_type",
      supported: ["application/pdf", "image/jpeg", "image/png"],
    });
  }

  if (input.fileSize > env.MAX_SLACK_FILE_BYTES) {
    return response(400, {
      ok: false,
      error: "file_too_large",
      maxBytes: env.MAX_SLACK_FILE_BYTES,
    });
  }

  const sourceId = `src_${randomUUID()}`;
  const now = new Date().toISOString();
  const s3Key = buildLocalImportS3Key(input.workspaceId, sourceId, input.fileName, input.mimeType, now);

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: env.DOCUMENT_ARCHIVE_BUCKET_NAME,
      Key: s3Key,
      ContentType: input.mimeType,
      Metadata: {
        source_id: sourceId,
        workspace_id: input.workspaceId,
        checksum: input.checksum,
      },
    }),
    { expiresIn: 900 },
  );

  const document: SourceDocument = {
    sourceId,
    workspaceId: input.workspaceId,
    sourceType: "local_file",
    sourceRef: input.sourcePath ?? input.fileName,
    title: input.fileName,
    uploadedByUserId: input.userId,
    mimeType: input.mimeType,
    size: input.fileSize,
    checksum: input.checksum,
    s3Bucket: env.DOCUMENT_ARCHIVE_BUCKET_NAME,
    s3Key,
    status: "upload_pending",
    createdAt: now,
    updatedAt: now,
  };
  await sourceDocumentRepository.save(document);

  log.info("Document upload prepared", {
    sourceId,
    workspaceId: input.workspaceId,
    mimeType: input.mimeType,
  });

  return response(200, {
    sourceId,
    uploadUrl,
    s3Bucket: env.DOCUMENT_ARCHIVE_BUCKET_NAME,
    s3Key,
    statusUrl: buildStatusUrl(event, input.workspaceId, sourceId),
  });
}

async function queueDocumentImport(
  event: APIGatewayProxyEvent,
  log: typeof logger,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody(event);
  const input = queueImportRequestSchema.parse(body);
  const existing = await sourceDocumentRepository.get(input.workspaceId, input.sourceId);
  if (!existing) {
    return response(404, { ok: false, error: "source_not_found" });
  }

  if (!existing.s3Key || !existing.s3Bucket) {
    return response(400, { ok: false, error: "missing_archive_location" });
  }

  await s3.send(
    new HeadObjectCommand({
      Bucket: existing.s3Bucket,
      Key: existing.s3Key,
    }),
  );

  const now = new Date().toISOString();
  await sourceDocumentRepository.save({
    ...existing,
    status: "queued",
    errorMessage: undefined,
    updatedAt: now,
  });

  await enqueueDocumentImport(event.requestContext.requestId, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    sourceId: input.sourceId,
    prompt: input.prompt,
    queuedAt: now,
  });

  log.info("Document import queued", {
    sourceId: input.sourceId,
    workspaceId: input.workspaceId,
  });

  return response(202, {
    ok: true,
    sourceId: input.sourceId,
    statusUrl: buildStatusUrl(event, input.workspaceId, input.sourceId),
  });
}

async function ingestMarkdown(
  event: APIGatewayProxyEvent,
  log: typeof logger,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody(event);
  const input = ingestMarkdownRequestSchema.parse(body);
  const size = Buffer.byteLength(input.markdown, "utf-8");
  if (size > env.MAX_SLACK_FILE_BYTES) {
    return response(400, {
      ok: false,
      error: "file_too_large",
      maxBytes: env.MAX_SLACK_FILE_BYTES,
    });
  }

  const sourceId = `src_${randomUUID()}`;
  const now = new Date().toISOString();
  const checksum = createHash("sha256").update(input.markdown, "utf8").digest("hex");
  const s3Key = buildMarkdownImportS3Key(
    input.workspaceId,
    sourceId,
    input.sourcePath ?? input.title,
    now,
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: env.DOCUMENT_ARCHIVE_BUCKET_NAME,
      Key: s3Key,
      Body: input.markdown,
      ContentType: "text/markdown; charset=utf-8",
      Metadata: {
        source_id: sourceId,
        workspace_id: input.workspaceId,
        checksum,
      },
    }),
  );

  const document: SourceDocument = {
    sourceId,
    workspaceId: input.workspaceId,
    sourceType: "local_file",
    sourceRef: input.sourcePath ?? input.title,
    title: input.title,
    uploadedByUserId: input.userId,
    mimeType: "text/markdown",
    size,
    checksum,
    s3Bucket: env.DOCUMENT_ARCHIVE_BUCKET_NAME,
    s3Key,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await sourceDocumentRepository.save(document);
  await enqueueDocumentImport(event.requestContext.requestId, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    sourceId,
    prompt: input.prompt,
    queuedAt: now,
  });

  log.info("Markdown import queued", {
    sourceId,
    workspaceId: input.workspaceId,
    sourcePath: input.sourcePath,
  });

  return response(202, {
    ok: true,
    sourceId,
    statusUrl: buildStatusUrl(event, input.workspaceId, sourceId),
  });
}

async function queueMarkdownExtraction(
  event: APIGatewayProxyEvent,
  log: typeof logger,
): Promise<APIGatewayProxyResult> {
  const body = parseJsonBody(event);
  const input = queueMarkdownExtractionRequestSchema.parse(body);
  const existing = await sourceDocumentRepository.get(input.workspaceId, input.sourceId);
  if (!existing) {
    return response(404, { ok: false, error: "source_not_found" });
  }

  if (!existing.s3Key || !existing.s3Bucket) {
    return response(400, { ok: false, error: "missing_archive_location" });
  }

  if (existing.mimeType !== "application/pdf") {
    return response(400, {
      ok: false,
      error: "unsupported_mime_type",
      supported: ["application/pdf"],
    });
  }

  await s3.send(
    new HeadObjectCommand({
      Bucket: existing.s3Bucket,
      Key: existing.s3Key,
    }),
  );

  const now = new Date().toISOString();
  await sourceDocumentRepository.save({
    ...existing,
    extractionStatus: "queued",
    extractionErrorMessage: undefined,
    updatedAt: now,
  });

  await enqueueDocumentImport(event.requestContext.requestId, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    sourceId: input.sourceId,
    operation: "extract_markdown",
    prompt: input.prompt,
    queuedAt: now,
  });

  log.info("Markdown extraction queued", {
    sourceId: input.sourceId,
    workspaceId: input.workspaceId,
  });

  return response(202, {
    ok: true,
    sourceId: input.sourceId,
    statusUrl: buildStatusUrl(event, input.workspaceId, input.sourceId),
  });
}

async function getSourceStatus(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const workspaceId = event.pathParameters?.workspaceId;
  const sourceId = event.pathParameters?.sourceId;
  if (!workspaceId || !sourceId) {
    return response(400, { ok: false, error: "missing_path_parameters" });
  }

  const source = await sourceDocumentRepository.get(workspaceId, sourceId);
  if (!source) {
    return response(404, { ok: false, error: "source_not_found" });
  }

  return response(200, {
    ...source,
    extractedMarkdownUrl:
      source.extractionStatus === "extracted" && source.extractedMarkdownS3Key
        ? buildExtractedMarkdownUrl(event, workspaceId, sourceId)
        : undefined,
  });
}

async function getExtractedMarkdown(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const workspaceId = event.pathParameters?.workspaceId;
  const sourceId = event.pathParameters?.sourceId;
  if (!workspaceId || !sourceId) {
    return response(400, { ok: false, error: "missing_path_parameters" });
  }

  const source = await sourceDocumentRepository.get(workspaceId, sourceId);
  if (!source) {
    return response(404, { ok: false, error: "source_not_found" });
  }

  if (
    source.extractionStatus !== "extracted" ||
    !source.extractedMarkdownS3Bucket ||
    !source.extractedMarkdownS3Key
  ) {
    return response(404, { ok: false, error: "extracted_markdown_not_found" });
  }

  const object = await s3.send(
    new GetObjectCommand({
      Bucket: source.extractedMarkdownS3Bucket,
      Key: source.extractedMarkdownS3Key,
    }),
  );
  if (!object.Body) {
    return response(500, { ok: false, error: "empty_markdown_body" });
  }

  const markdown = Buffer.from(await object.Body.transformToByteArray()).toString("utf-8");
  return {
    statusCode: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
    },
    body: markdown,
  };
}

async function enqueueDocumentImport(
  requestId: string,
  input: {
    workspaceId: string;
    userId: string;
    sourceId: string;
    operation?: "import" | "extract_markdown";
    prompt?: string;
    queuedAt: string;
  },
): Promise<void> {
  const correlationId = `${requestId}:${input.sourceId}`;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: env.DOCUMENT_IMPORT_QUEUE_URL,
      MessageBody: JSON.stringify({
        correlationId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        sourceId: input.sourceId,
        operation: input.operation ?? "import",
        prompt: input.prompt,
        queuedAt: input.queuedAt,
      }),
    }),
  );
}

function buildLocalImportS3Key(
  workspaceId: string,
  sourceId: string,
  fileName: string,
  mimeType: string,
  timestamp: string,
): string {
  const date = new Date(timestamp);
  const year = `${date.getUTCFullYear()}`;
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const safeName = sanitizeFileName(fileName, sourceId, mimeType);
  return `raw/private/imports/${workspaceId}/${year}/${month}/${sourceId}/${safeName}`;
}

function buildMarkdownImportS3Key(
  workspaceId: string,
  sourceId: string,
  title: string,
  timestamp: string,
): string {
  const date = new Date(timestamp);
  const year = `${date.getUTCFullYear()}`;
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const safeName = sanitizeFileName(title, sourceId, "text/markdown");
  return `raw/private/notes/${workspaceId}/${year}/${month}/${sourceId}/${safeName}`;
}

function sanitizeFileName(fileName: string, sourceId: string, mimeType: string): string {
  const trimmed = fileName.trim();
  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const safeBase = normalized.length > 0 ? normalized : sourceId;
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(safeBase);
  return hasExtension ? safeBase : `${safeBase}${defaultExtensionForMimeType(mimeType)}`;
}

function buildStatusUrl(event: APIGatewayProxyEvent, workspaceId: string, sourceId: string): string {
  return `https://${event.requestContext.domainName}/${event.requestContext.stage}/imports/workspaces/${encodeURIComponent(
    workspaceId,
  )}/sources/${encodeURIComponent(sourceId)}`;
}

function buildExtractedMarkdownUrl(
  event: APIGatewayProxyEvent,
  workspaceId: string,
  sourceId: string,
): string {
  return `https://${event.requestContext.domainName}/${event.requestContext.stage}/imports/workspaces/${encodeURIComponent(
    workspaceId,
  )}/sources/${encodeURIComponent(sourceId)}/markdown`;
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
