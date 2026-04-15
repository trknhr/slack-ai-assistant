import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  ScheduledTask,
  buildScheduledTaskPk,
  scheduledTaskSchema,
} from "../tasks/taskDefinition";
import { documentClient } from "./documentClient";

export class TaskRepository {
  constructor(private readonly tableName: string) {}

  async get(taskId: string): Promise<ScheduledTask | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildScheduledTaskPk(taskId),
        },
      }),
    );

    if (!response.Item) {
      return null;
    }

    return scheduledTaskSchema.parse({
      taskId: response.Item.taskId,
      name: response.Item.name,
      prompt: response.Item.prompt,
      workspaceId: response.Item.workspaceId,
      outputChannelId: response.Item.outputChannelId,
      enabled: response.Item.enabled,
      reuseSession: response.Item.reuseSession ?? false,
      memoryStoreId: response.Item.memoryStoreId,
      vaultIds: response.Item.vaultIds,
      agentIdOverride: response.Item.agentIdOverride,
      environmentIdOverride: response.Item.environmentIdOverride,
      createdAt: response.Item.createdAt,
      updatedAt: response.Item.updatedAt,
    });
  }

  async save(task: ScheduledTask): Promise<void> {
    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildScheduledTaskPk(task.taskId),
          taskId: task.taskId,
          name: task.name,
          prompt: task.prompt,
          workspaceId: task.workspaceId,
          outputChannelId: task.outputChannelId,
          enabled: task.enabled,
          reuseSession: task.reuseSession,
          memoryStoreId: task.memoryStoreId,
          vaultIds: task.vaultIds,
          agentIdOverride: task.agentIdOverride,
          environmentIdOverride: task.environmentIdOverride,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        },
      }),
    );
  }
}
