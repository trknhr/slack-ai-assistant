import { createHash, randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SourceDocument, SourceDocumentStatus } from "../documents/sourceDocument";
import { SourceDocumentRepository } from "../repo/sourceDocumentRepository";
import { Logger } from "../shared/logger";
import { defaultExtensionForMimeType } from "./fileSupport";
import { PreparedSlackAttachment } from "./filesClient";

interface ArchiveSlackAttachmentsInput {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  attachments: PreparedSlackAttachment[];
  logger: Logger;
}

export class SlackAttachmentArchiveService {
  private readonly s3 = new S3Client({});

  constructor(
    private readonly bucketName: string,
    private readonly repository: SourceDocumentRepository,
  ) {}

  async archiveAttachments(input: ArchiveSlackAttachmentsInput): Promise<void> {
    for (const attachment of input.attachments) {
      await this.archiveAttachment(input, attachment);
    }
  }

  private async archiveAttachment(
    input: Omit<ArchiveSlackAttachmentsInput, "attachments">,
    attachment: PreparedSlackAttachment,
  ): Promise<void> {
    const sourceId = `src_${randomUUID()}`;
    const now = new Date().toISOString();
    const baseDocument: SourceDocument = {
      sourceId,
      workspaceId: input.workspaceId,
      sourceType: "slack_file",
      sourceRef: attachment.file.permalink ?? attachment.file.id,
      title: attachment.label,
      slackFileId: attachment.file.id,
      slackPermalink: attachment.file.permalink,
      channelId: input.channelId,
      threadTs: input.threadTs,
      messageTs: input.messageTs,
      uploadedByUserId: input.userId,
      mimeType: attachment.mimeType,
      size: attachment.contentBytes?.byteLength ?? attachment.file.size,
      status: mapAttachmentStatus(attachment.status),
      createdAt: now,
      updatedAt: now,
    };

    if (attachment.status !== "ready" || !attachment.contentBytes) {
      await this.persistDocument(baseDocument, input.logger);
      return;
    }

    const checksum = createHash("sha256").update(attachment.contentBytes).digest("hex");
    const s3Key = buildS3Key(input.workspaceId, sourceId, attachment.label, attachment.mimeType, now);

    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: s3Key,
          Body: attachment.contentBytes,
          ContentType: attachment.mimeType,
          Metadata: {
            source_id: sourceId,
            workspace_id: input.workspaceId,
            channel_id: input.channelId,
            slack_file_id: attachment.file.id,
          },
        }),
      );

      await this.persistDocument(
        {
          ...baseDocument,
          checksum,
          s3Bucket: this.bucketName,
          s3Key,
          status: "archived",
        },
        input.logger,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown archive error";
      input.logger.warn("Slack attachment archive failed", {
        slackFileId: attachment.file.id,
        sourceId,
        error: message,
      });

      await this.persistDocument(
        {
          ...baseDocument,
          checksum,
          status: "archive_failed",
          errorMessage: message,
        },
        input.logger,
      );
    }
  }

  private async persistDocument(document: SourceDocument, logger: Logger): Promise<void> {
    try {
      await this.repository.save(document);
    } catch (error) {
      logger.warn("Source document metadata persist failed", {
        sourceId: document.sourceId,
        slackFileId: document.slackFileId,
        error: error instanceof Error ? error.message : "Unknown repository error",
      });
    }
  }
}

function mapAttachmentStatus(status: PreparedSlackAttachment["status"]): SourceDocumentStatus {
  switch (status) {
    case "external_link":
      return "external_link";
    case "skipped_missing_url":
      return "skipped_missing_url";
    case "skipped_oversize":
      return "skipped_oversize";
    case "skipped_unsupported":
      return "skipped_unsupported";
    case "download_failed":
      return "download_failed";
    case "ready":
      return "archived";
  }
}

function buildS3Key(
  workspaceId: string,
  sourceId: string,
  label: string,
  mimeType: string | undefined,
  timestamp: string,
): string {
  const date = new Date(timestamp);
  const year = `${date.getUTCFullYear()}`;
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const fileName = sanitizeFileName(label, sourceId, mimeType);
  return `raw/private/slack/${workspaceId}/${year}/${month}/${sourceId}/${fileName}`;
}

function sanitizeFileName(label: string, sourceId: string, mimeType?: string): string {
  const trimmed = label.trim();
  const rawName = trimmed.length > 0 ? trimmed : sourceId;
  const normalized = rawName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const safeBase = normalized.length > 0 ? normalized : sourceId;
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(safeBase);
  return hasExtension ? safeBase : `${safeBase}${defaultExtensionForMimeType(mimeType)}`;
}
