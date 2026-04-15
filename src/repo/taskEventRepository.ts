import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { TaskEventRecord } from "../tasks/taskState";
import { documentClient } from "./documentClient";

function buildPk(taskId: string): string {
  return `TASK#${taskId}`;
}

function buildSk(createdAt: string, eventId: string): string {
  return `EVENT#${createdAt}#${eventId}`;
}

export class TaskEventRepository {
  constructor(private readonly tableName: string) {}

  async save(
    event: Omit<TaskEventRecord, "eventId" | "createdAt"> & {
      eventId?: string;
      createdAt?: string;
    },
  ): Promise<TaskEventRecord> {
    const record: TaskEventRecord = {
      ...event,
      eventId: event.eventId ?? `tevt_${randomUUID()}`,
      createdAt: event.createdAt ?? new Date().toISOString(),
    };

    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildPk(record.taskId),
          sk: buildSk(record.createdAt, record.eventId),
          taskId: record.taskId,
          eventId: record.eventId,
          type: record.type,
          payload: record.payload,
          createdAt: record.createdAt,
        },
      }),
    );

    return record;
  }
}
