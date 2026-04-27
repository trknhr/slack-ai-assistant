import { z } from "zod";

const requiredString = z.string().min(1);
const trueValues = new Set(["1", "true", "yes", "on"]);

const booleanFromEnv = z
  .string()
  .optional()
  .transform((value) => (value ? trueValues.has(value.toLowerCase()) : false));

const stringArrayFromCsv = z
  .string()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
      : [],
  );

const baseEnvSchema = z.object({
  SESSION_TABLE_NAME: requiredString,
  CONVERSATION_SESSIONS_TABLE_NAME: requiredString,
  CONVERSATION_TURNS_TABLE_NAME: requiredString,
  USER_MEMORY_TABLE_NAME: requiredString,
  MEMORY_ITEMS_TABLE_NAME: requiredString,
  TASKS_TABLE_NAME: requiredString,
  TASK_EVENTS_TABLE_NAME: requiredString,
  PROCESSED_EVENTS_TABLE_NAME: requiredString,
  TASK_TABLE_NAME: requiredString,
  SLACK_SIGNING_SECRET_SECRET_ID: requiredString,
  SLACK_BOT_TOKEN_SECRET_ID: requiredString,
  ANTHROPIC_API_KEY_SECRET_ID: requiredString,
  ANTHROPIC_AGENT_ID: requiredString,
  ANTHROPIC_ENVIRONMENT_ID: requiredString,
  ANTHROPIC_VAULT_IDS: stringArrayFromCsv,
  ANTHROPIC_MANAGED_AGENTS_BETA: requiredString.default("managed-agents-2026-04-01"),
  EVENT_DEDUP_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  AGENT_RESPONSE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  TOP_LEVEL_CONTEXT_TURN_LIMIT: z.coerce.number().int().positive().default(10),
  MAX_SLACK_FILE_BYTES: z.coerce.number().int().positive().default(10_000_000),
  ENABLE_USER_MEMORY: booleanFromEnv,
  DEFAULT_SCHEDULE_CHANNEL: requiredString,
});

const ingressEnvSchema = baseEnvSchema.extend({
  SLACK_QUEUE_URL: requiredString,
});

const toolRuntimeEnvSchema = baseEnvSchema.extend({
  CALENDAR_DRAFTS_TABLE_NAME: requiredString,
  GOOGLE_CALENDAR_SECRET_ID: requiredString,
  GOOGLE_CALENDAR_TIME_ZONE: requiredString.default("Asia/Tokyo"),
});

const workerEnvSchema = toolRuntimeEnvSchema.extend({
  SOURCE_DOCUMENTS_TABLE_NAME: requiredString,
  SLACK_ATTACHMENT_ARCHIVE_BUCKET_NAME: requiredString,
});

const importApiEnvSchema = baseEnvSchema.extend({
  SOURCE_DOCUMENTS_TABLE_NAME: requiredString,
  DOCUMENT_IMPORT_QUEUE_URL: requiredString,
  DOCUMENT_ARCHIVE_BUCKET_NAME: requiredString,
});

const importWorkerEnvSchema = toolRuntimeEnvSchema.extend({
  SOURCE_DOCUMENTS_TABLE_NAME: requiredString,
  DOCUMENT_ARCHIVE_BUCKET_NAME: requiredString,
});

const chatApiEnvSchema = toolRuntimeEnvSchema;

const schedulerEnvSchema = toolRuntimeEnvSchema;

const slackInteractionsEnvSchema = toolRuntimeEnvSchema;

export type IngressEnv = z.infer<typeof ingressEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type ImportApiEnv = z.infer<typeof importApiEnvSchema>;
export type ImportWorkerEnv = z.infer<typeof importWorkerEnvSchema>;
export type ChatApiEnv = z.infer<typeof chatApiEnvSchema>;
export type SchedulerEnv = z.infer<typeof schedulerEnvSchema>;
export type SlackInteractionsEnv = z.infer<typeof slackInteractionsEnvSchema>;

export function loadIngressEnv(): IngressEnv {
  return ingressEnvSchema.parse(process.env);
}

export function loadWorkerEnv(): WorkerEnv {
  return workerEnvSchema.parse(process.env);
}

export function loadImportApiEnv(): ImportApiEnv {
  return importApiEnvSchema.parse(process.env);
}

export function loadImportWorkerEnv(): ImportWorkerEnv {
  return importWorkerEnvSchema.parse(process.env);
}

export function loadChatApiEnv(): ChatApiEnv {
  return chatApiEnvSchema.parse(process.env);
}

export function loadSchedulerEnv(): SchedulerEnv {
  return schedulerEnvSchema.parse(process.env);
}

export function loadSlackInteractionsEnv(): SlackInteractionsEnv {
  return slackInteractionsEnvSchema.parse(process.env);
}
