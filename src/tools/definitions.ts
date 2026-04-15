export const customToolDefinitions = [
  {
    name: "search_memories",
    description: "Search saved memories and facts relevant to a person, topic, or past event.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or question to search memories for." },
        entity_key: {
          type: "string",
          description: "Optional stable entity key such as person:hanako or family:parents.",
        },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "save_memory",
    description: "Save a durable memory such as preferences, birthdays, gift history, and personal context.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Human-readable memory text to save." },
        entity_key: { type: "string" },
        attributes: { type: "object" },
        tags: { type: "array", items: { type: "string" } },
        importance: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["text"],
    },
  },
  {
    name: "list_tasks",
    description: "List current tasks with filters for status and due date.",
    input_schema: {
      type: "object",
      properties: {
        statuses: {
          type: "array",
          items: { type: "string", enum: ["open", "in_progress", "done", "cancelled"] },
        },
        due_before: { type: "string", description: "RFC3339 timestamp upper bound for due date." },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "upsert_task",
    description: "Create or update a task after reasoning about future work or calendar events.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["open", "in_progress", "done", "cancelled"] },
        due_at: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        calendar_event_id: { type: "string" },
        source_type: { type: "string" },
        source_ref: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["title"],
    },
  },
  {
    name: "mark_task_done",
    description: "Mark a task as done when the user says it is completed or the agent confirms completion.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        completed_at: { type: "string" },
      },
      required: ["task_id"],
    },
  },
] as const;
