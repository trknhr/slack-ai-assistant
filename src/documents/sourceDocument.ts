export type SourceDocumentStatus =
  | "archived"
  | "upload_pending"
  | "uploaded"
  | "queued"
  | "processing"
  | "imported"
  | "failed"
  | "skipped_unsupported"
  | "skipped_oversize"
  | "skipped_missing_url"
  | "external_link"
  | "download_failed"
  | "archive_failed";

export interface SourceDocument {
  sourceId: string;
  workspaceId: string;
  sourceType: "slack_file" | "local_file";
  sourceRef: string;
  title: string;
  slackFileId?: string;
  slackPermalink?: string;
  channelId?: string;
  threadTs?: string;
  messageTs?: string;
  uploadedByUserId?: string;
  mimeType?: string;
  size?: number;
  checksum?: string;
  s3Bucket?: string;
  s3Key?: string;
  status: SourceDocumentStatus;
  summary?: string;
  importedTaskIds?: string[];
  savedMemoryIds?: string[];
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
