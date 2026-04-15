import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ThreadSessionRecord } from "../shared/contracts";
import { documentClient } from "./documentClient";

function buildPk(workspaceId: string, channelId: string): string {
  return `WORKSPACE#${workspaceId}#CHANNEL#${channelId}`;
}

function buildSk(threadTs: string): string {
  return `THREAD#${threadTs}`;
}

export class SessionRepository {
  constructor(private readonly tableName: string) {}

  async findByThread(
    workspaceId: string,
    channelId: string,
    threadTs: string,
  ): Promise<ThreadSessionRecord | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildPk(workspaceId, channelId),
          sk: buildSk(threadTs),
        },
      }),
    );

    if (!response.Item) {
      return null;
    }

    return {
      workspaceId,
      channelId,
      threadTs,
      sessionId: response.Item.session_id,
      memoryStoreId: response.Item.memory_store_id,
      createdAt: response.Item.created_at,
      lastUsedAt: response.Item.last_used_at,
    };
  }

  async save(record: ThreadSessionRecord): Promise<void> {
    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildPk(record.workspaceId, record.channelId),
          sk: buildSk(record.threadTs),
          session_id: record.sessionId,
          memory_store_id: record.memoryStoreId,
          created_at: record.createdAt,
          last_used_at: record.lastUsedAt,
        },
      }),
    );
  }
}
