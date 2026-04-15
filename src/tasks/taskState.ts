export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

export interface TaskState {
  workspaceId: string;
  taskId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  dueAt?: string;
  priority?: "low" | "medium" | "high";
  ownerUserId?: string;
  calendarEventId?: string;
  sourceType?: string;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
  completedAt?: string;
  completedByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEventRecord {
  taskId: string;
  eventId: string;
  type: "created" | "updated" | "marked_done";
  payload?: Record<string, unknown>;
  createdAt: string;
}
