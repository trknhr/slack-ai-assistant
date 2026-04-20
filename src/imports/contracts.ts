import { z } from "zod";

export const createImportUploadRequestSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  fileSize: z.number().int().positive(),
  checksum: z.string().min(1),
  sourcePath: z.string().min(1).optional(),
});

export const createImportUploadResponseSchema = z.object({
  sourceId: z.string().min(1),
  uploadUrl: z.string().url(),
  s3Bucket: z.string().min(1),
  s3Key: z.string().min(1),
  statusUrl: z.string().min(1),
});

export const enqueueImportResponseSchema = z.object({
  ok: z.literal(true),
  sourceId: z.string().min(1),
  statusUrl: z.string().min(1),
});

export const queueImportRequestSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  sourceId: z.string().min(1),
  prompt: z.string().min(1).optional(),
});

export const queueMarkdownExtractionRequestSchema = queueImportRequestSchema;

export const ingestMarkdownRequestSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  title: z.string().min(1),
  markdown: z.string().min(1),
  sourcePath: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
});

export const documentImportQueueMessageSchema = z.object({
  correlationId: z.string().min(1),
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  sourceId: z.string().min(1),
  operation: z.enum(["import", "extract_markdown"]).default("import"),
  prompt: z.string().min(1).optional(),
  queuedAt: z.string().min(1),
});

export type CreateImportUploadRequest = z.infer<typeof createImportUploadRequestSchema>;
export type CreateImportUploadResponse = z.infer<typeof createImportUploadResponseSchema>;
export type EnqueueImportResponse = z.infer<typeof enqueueImportResponseSchema>;
export type QueueImportRequest = z.infer<typeof queueImportRequestSchema>;
export type QueueMarkdownExtractionRequest = z.infer<typeof queueMarkdownExtractionRequestSchema>;
export type IngestMarkdownRequest = z.infer<typeof ingestMarkdownRequestSchema>;
export type DocumentImportQueueMessage = z.infer<typeof documentImportQueueMessageSchema>;
