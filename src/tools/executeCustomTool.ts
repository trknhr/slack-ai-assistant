import { z } from "zod";
import { ClaudeInputBlock, ClaudeSessionEvent } from "../claude/client";
import { MemoryItemRepository } from "../repo/memoryItemRepository";
import { TaskEventRepository } from "../repo/taskEventRepository";
import { TaskStateRepository } from "../repo/taskStateRepository";
import { Logger } from "../shared/logger";
import { TaskStatus } from "../tasks/taskState";

const searchMemoriesSchema = z.object({
  query: z.string().min(1),
  entity_key: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const saveMemorySchema = z.object({
  text: z.string().min(1),
  entity_key: z.string().min(1).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().min(1)).optional(),
  importance: z.number().min(0).max(1).optional(),
});

const listTasksSchema = z.object({
  statuses: z.array(z.enum(["open", "in_progress", "done", "cancelled"])).optional(),
  due_before: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const upsertTaskSchema = z.object({
  task_id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
  due_at: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  calendar_event_id: z.string().optional(),
  source_type: z.string().optional(),
  source_ref: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const markTaskDoneSchema = z.object({
  task_id: z.string().min(1),
  completed_at: z.string().optional(),
});

export interface ToolExecutionContext {
  workspaceId: string;
  userId?: string;
  logger: Logger;
}

interface ToolRepositories {
  memoryItems: MemoryItemRepository;
  tasks: TaskStateRepository;
  taskEvents: TaskEventRepository;
}

export interface ToolExecutionResult {
  content: ClaudeInputBlock[];
  isError?: boolean;
}

export interface ToolExecutionSummary {
  savedMemoryIds: string[];
  taskIds: string[];
}

export class CustomToolExecutor {
  private readonly savedMemoryIds = new Set<string>();
  private readonly taskIds = new Set<string>();

  constructor(
    private readonly repositories: ToolRepositories,
    private readonly context: ToolExecutionContext,
  ) {}

  async execute(toolUseEvent: ClaudeSessionEvent): Promise<ToolExecutionResult> {
    const toolName = typeof toolUseEvent.name === "string" ? toolUseEvent.name : "";
    const input =
      toolUseEvent.input && typeof toolUseEvent.input === "object"
        ? (toolUseEvent.input as Record<string, unknown>)
        : {};

    this.context.logger.info("Executing custom tool", {
      toolName,
      toolEventId: toolUseEvent.id,
    });

    try {
      switch (toolName) {
        case "search_memories":
          return this.searchMemories(input);
        case "save_memory":
          return this.saveMemory(input);
        case "list_tasks":
          return this.listTasks(input);
        case "upsert_task":
          return this.upsertTask(input);
        case "mark_task_done":
          return this.markTaskDone(input);
        default:
          return errorResult(`Unknown custom tool: ${toolName}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown tool execution error";
      return errorResult(message);
    }
  }

  getSummary(): ToolExecutionSummary {
    return {
      savedMemoryIds: [...this.savedMemoryIds],
      taskIds: [...this.taskIds],
    };
  }

  private async searchMemories(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = searchMemoriesSchema.parse(input);
    const memories = await this.repositories.memoryItems.search({
      workspaceId: this.context.workspaceId,
      query: parsed.query,
      entityKey: parsed.entity_key,
      limit: parsed.limit,
    });

    return jsonResult({
      count: memories.length,
      memories: memories.map((memory) => ({
        memory_id: memory.memoryId,
        entity_key: memory.entityKey,
        text: memory.text,
        attributes: memory.attributes ?? {},
        tags: memory.tags ?? [],
        importance: memory.importance ?? 0,
        updated_at: memory.updatedAt,
      })),
    });
  }

  private async saveMemory(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = saveMemorySchema.parse(input);
    const memory = await this.repositories.memoryItems.save({
      workspaceId: this.context.workspaceId,
      entityKey: parsed.entity_key,
      text: parsed.text,
      attributes: parsed.attributes,
      tags: parsed.tags,
      importance: parsed.importance,
      sourceType: "agent",
      createdByUserId: this.context.userId,
    });
    this.savedMemoryIds.add(memory.memoryId);

    return jsonResult({
      saved: true,
      memory_id: memory.memoryId,
      entity_key: memory.entityKey,
      text: memory.text,
      updated_at: memory.updatedAt,
    });
  }

  private async listTasks(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = listTasksSchema.parse(input);
    const tasks = await this.repositories.tasks.list({
      workspaceId: this.context.workspaceId,
      statuses: parsed.statuses as TaskStatus[] | undefined,
      dueBefore: parsed.due_before,
      limit: parsed.limit,
      ownerUserId: this.context.userId,
    });

    return jsonResult({
      count: tasks.length,
      tasks: tasks.map((task) => ({
        task_id: task.taskId,
        title: task.title,
        description: task.description,
        status: task.status,
        due_at: task.dueAt,
        priority: task.priority,
        calendar_event_id: task.calendarEventId,
        updated_at: task.updatedAt,
        completed_at: task.completedAt,
      })),
    });
  }

  private async upsertTask(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = upsertTaskSchema.parse(input);
    const existing = parsed.task_id
      ? await this.repositories.tasks.get(this.context.workspaceId, parsed.task_id)
      : null;
    const task = await this.repositories.tasks.upsert({
      workspaceId: this.context.workspaceId,
      taskId: parsed.task_id,
      title: parsed.title,
      description: parsed.description,
      status: parsed.status ?? existing?.status ?? "open",
      dueAt: parsed.due_at,
      priority: parsed.priority,
      ownerUserId: existing?.ownerUserId ?? this.context.userId,
      calendarEventId: parsed.calendar_event_id,
      sourceType: parsed.source_type ?? "agent",
      sourceRef: parsed.source_ref,
      metadata: parsed.metadata,
      completedAt: parsed.status === "done" ? existing?.completedAt ?? new Date().toISOString() : undefined,
      completedByUserId: parsed.status === "done" ? this.context.userId : undefined,
    });
    this.taskIds.add(task.taskId);

    await this.repositories.taskEvents.save({
      taskId: task.taskId,
      type: existing ? "updated" : "created",
      payload: {
        title: task.title,
        status: task.status,
        due_at: task.dueAt,
      },
    });

    return jsonResult({
      saved: true,
      task_id: task.taskId,
      title: task.title,
      status: task.status,
      due_at: task.dueAt,
      calendar_event_id: task.calendarEventId,
      updated_at: task.updatedAt,
    });
  }

  private async markTaskDone(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const parsed = markTaskDoneSchema.parse(input);
    const task = await this.repositories.tasks.markDone({
      workspaceId: this.context.workspaceId,
      taskId: parsed.task_id,
      completedByUserId: this.context.userId,
      completedAt: parsed.completed_at,
    });
    this.taskIds.add(task.taskId);

    await this.repositories.taskEvents.save({
      taskId: task.taskId,
      type: "marked_done",
      payload: {
        completed_at: task.completedAt,
        completed_by_user_id: task.completedByUserId,
      },
    });

    return jsonResult({
      saved: true,
      task_id: task.taskId,
      status: task.status,
      completed_at: task.completedAt,
    });
  }
}

function jsonResult(payload: unknown): ToolExecutionResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResult(message: string): ToolExecutionResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
}
