export const customToolDefinitions = [
  {
    name: "search_memories",
    description:
      "Search saved memories and facts relevant to a person, topic, or past event. If the first search is weak, retry with alternate phrasings, synonyms, or entity-focused queries before concluding the memory is missing.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords or question to search memories for. Retry with alternate wording when needed.",
        },
        entity_key: {
          type: "string",
          description:
            "Optional stable entity key such as person:hanako, project:renovation, or place:home to narrow the search.",
        },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "save_memory",
    description:
      "Save a durable memory such as a preference, stable fact, personal detail, or reusable rule. Save one memory per fact and do not save transient chatter or daily summaries.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "One concise durable fact, preference, or rule. Do not combine unrelated facts.",
        },
        entity_key: {
          type: "string",
          description: "Stable key like person:hanako, project:renovation, place:home, or vendor:costco.",
        },
        attributes: {
          type: "object",
          description: "Structured details such as aliases, dates, constraints, confidence, or source snippets.",
        },
        tags: {
          type: "array",
          description: "Short category labels such as preference, family, schedule, project, shopping, or rule.",
          items: { type: "string" },
        },
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
  {
    name: "list_calendar_events",
    description:
      "Inspect Google Calendar events before creating or changing anything. Use this to avoid duplicates and review what is already on the calendar.",
    input_schema: {
      type: "object",
      properties: {
        calendar_id: { type: "string" },
        time_min: { type: "string", description: "RFC3339 lower bound for the event search window." },
        time_max: { type: "string", description: "RFC3339 upper bound for the event search window." },
        time_zone: { type: "string", description: "IANA time zone for the response, such as Asia/Tokyo." },
        query: { type: "string", description: "Optional free-text search over summary, description, or location." },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "find_free_busy",
    description: "Check Google Calendar busy blocks in a given time range before proposing or scheduling timed events.",
    input_schema: {
      type: "object",
      properties: {
        calendar_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional calendar IDs. Omit to query the default connected calendar.",
        },
        time_min: { type: "string", description: "RFC3339 lower bound." },
        time_max: { type: "string", description: "RFC3339 upper bound." },
        time_zone: { type: "string", description: "IANA time zone for the response, such as Asia/Tokyo." },
      },
      required: ["time_min", "time_max"],
    },
  },
  {
    name: "create_calendar_draft",
    description:
      "Save calendar event candidates for review before any Google Calendar write. Present the returned draft to the user and wait for explicit approval before applying it.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        notes: { type: "string" },
        source_id: { type: "string" },
        source_ref: { type: "string" },
        calendar_id: { type: "string" },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              candidate_id: { type: "string" },
              summary: { type: "string" },
              description: { type: "string" },
              location: { type: "string" },
              all_day: { type: "boolean" },
              start_date: {
                type: "string",
                description: "Date-only YYYY-MM-DD. For all-day events, end_date is inclusive if provided.",
              },
              end_date: { type: "string", description: "Inclusive final date for an all-day event." },
              start_at: { type: "string", description: "RFC3339 start time for a timed event." },
              end_at: { type: "string", description: "RFC3339 end time for a timed event." },
              time_zone: { type: "string" },
              source_text: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              dedupe_key: {
                type: "string",
                description: "Optional stable key used to update the same Google Calendar event on re-import.",
              },
            },
            required: ["summary"],
          },
          minItems: 1,
        },
      },
      required: ["candidates"],
    },
  },
  {
    name: "list_calendar_drafts",
    description: "List recent Google Calendar drafts and their candidate statuses so you can recover or continue a review flow.",
    input_schema: {
      type: "object",
      properties: {
        statuses: {
          type: "array",
          items: { type: "string", enum: ["pending", "approved", "applied", "rejected"] },
        },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
    },
  },
  {
    name: "apply_calendar_draft",
    description:
      "Create or update Google Calendar events from a previously previewed draft only after the user explicitly approves the selected candidates.",
    input_schema: {
      type: "object",
      properties: {
        draft_id: { type: "string" },
        calendar_id: { type: "string" },
        candidate_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional subset of candidate IDs to apply. Omit to apply all pending candidates.",
        },
      },
      required: ["draft_id"],
    },
  },
  {
    name: "discard_calendar_draft",
    description:
      "Reject some or all pending candidates from a previously previewed calendar draft when the user does not want them created.",
    input_schema: {
      type: "object",
      properties: {
        draft_id: { type: "string" },
        candidate_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional subset of candidate IDs to reject. Omit to reject all pending candidates.",
        },
      },
      required: ["draft_id"],
    },
  },
] as const;
