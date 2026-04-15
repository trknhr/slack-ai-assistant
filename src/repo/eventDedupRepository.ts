import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./documentClient";

export class EventDedupRepository {
  constructor(private readonly tableName: string) {}

  async markProcessed(eventId: string, ttlSeconds: number): Promise<boolean> {
    const now = new Date();
    const ttl = Math.floor(now.getTime() / 1000) + ttlSeconds;

    try {
      await documentClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `EVENT#${eventId}`,
            created_at: now.toISOString(),
            ttl,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );

      return true;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "ConditionalCheckFailedException") {
        return false;
      }
      throw error;
    }
  }
}
