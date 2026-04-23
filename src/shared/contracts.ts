import { z } from "zod";

export const slackQueueMessageSchema = z.object({
  correlationId: z.string().min(1),
  eventId: z.string().min(1),
  workspaceId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  messageTs: z.string().min(1),
  userId: z.string().min(1),
  text: z.string().min(1),
  source: z.enum(["app_mention", "dm", "thread_reply"]),
  receivedAt: z.string().min(1),
  files: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().optional(),
        title: z.string().optional(),
        mimetype: z.string().optional(),
        fileAccess: z.string().optional(),
        urlPrivate: z.string().url().optional(),
        urlPrivateDownload: z.string().url().optional(),
        permalink: z.string().url().optional(),
        isExternal: z.boolean().optional(),
        externalUrl: z.string().url().optional(),
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .default([]),
});

export type SlackQueueMessage = z.infer<typeof slackQueueMessageSchema>;

export type SlackFileReference = SlackQueueMessage["files"][number];

export interface ThreadSessionRecord {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  sessionId: string;
  memoryStoreId?: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface UserMemoryRecord {
  workspaceId: string;
  userId: string;
  memoryStoreId: string;
  profileSummary?: string;
  createdAt: string;
  updatedAt: string;
}
