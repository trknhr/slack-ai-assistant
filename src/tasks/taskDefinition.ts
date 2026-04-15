import { z } from "zod";

export const scheduledTaskSchema = z.object({
  taskId: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  workspaceId: z.string().min(1),
  outputChannelId: z.string().min(1),
  enabled: z.boolean(),
  reuseSession: z.boolean().default(false),
  memoryStoreId: z.string().optional(),
  vaultIds: z.array(z.string().min(1)).optional(),
  agentIdOverride: z.string().optional(),
  environmentIdOverride: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;

export function buildScheduledTaskPk(taskId: string): string {
  return `TASK#${taskId}`;
}
