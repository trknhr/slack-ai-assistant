import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { UserMemoryRecord } from "../shared/contracts";
import { documentClient } from "./documentClient";

function buildPk(workspaceId: string, userId: string): string {
  return `WORKSPACE#${workspaceId}#USER#${userId}`;
}

export class UserMemoryRepository {
  constructor(private readonly tableName: string) {}

  async find(workspaceId: string, userId: string): Promise<UserMemoryRecord | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildPk(workspaceId, userId),
        },
      }),
    );

    if (!response.Item) {
      return null;
    }

    return {
      workspaceId,
      userId,
      memoryStoreId: response.Item.memory_store_id,
      profileSummary: response.Item.profile_summary,
      createdAt: response.Item.created_at,
      updatedAt: response.Item.updated_at,
    };
  }

  async save(record: UserMemoryRecord): Promise<void> {
    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildPk(record.workspaceId, record.userId),
          memory_store_id: record.memoryStoreId,
          profile_summary: record.profileSummary,
          created_at: record.createdAt,
          updated_at: record.updatedAt,
        },
      }),
    );
  }
}
