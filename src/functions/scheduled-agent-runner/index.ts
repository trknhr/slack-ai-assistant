import type { EventBridgeEvent } from "aws-lambda";
import { SecretsProvider } from "../../aws/secretsProvider";
import { GoogleCalendarClient } from "../../calendar/googleCalendarClient";
import { AnthropicManagedAgentsClient } from "../../claude/client";
import { createSession } from "../../claude/createSession";
import { sendUserMessage } from "../../claude/sendUserMessage";
import { waitForCompletion } from "../../claude/waitForCompletion";
import { loadSchedulerEnv } from "../../config/env";
import { SCHEDULED_MEMORY_RESOURCE_PROMPT } from "../../memory/instructions";
import { CalendarDraftRepository } from "../../repo/calendarDraftRepository";
import { MemoryItemRepository } from "../../repo/memoryItemRepository";
import { SessionRepository } from "../../repo/sessionRepository";
import { TaskEventRepository } from "../../repo/taskEventRepository";
import { TaskRepository } from "../../repo/taskRepository";
import { TaskStateRepository } from "../../repo/taskStateRepository";
import { logger } from "../../shared/logger";
import { SlackAuthClient } from "../../slack/authTest";
import { SlackWebClient } from "../../slack/postMessage";
import { ScheduledTask } from "../../tasks/taskDefinition";
import { CustomToolExecutor } from "../../tools/executeCustomTool";

interface SchedulerPayload {
  taskId?: string;
  workspaceId?: string;
  outputChannelId?: string;
  prompt?: string;
  name?: string;
  vaultIds?: string[];
  persistTask?: boolean;
}

const SCHEDULE_TIMEZONE = "Asia/Tokyo";

const env = loadSchedulerEnv();
const secretsProvider = new SecretsProvider();
const claudeClient = new AnthropicManagedAgentsClient({
  apiKeyProvider: () => secretsProvider.getSecretString(env.ANTHROPIC_API_KEY_SECRET_ID),
  beta: env.ANTHROPIC_MANAGED_AGENTS_BETA,
});
const slackClient = new SlackWebClient(() =>
  secretsProvider.getSecretString(env.SLACK_BOT_TOKEN_SECRET_ID),
);
const calendarDraftRepository = new CalendarDraftRepository(env.CALENDAR_DRAFTS_TABLE_NAME);
const googleCalendarClient = new GoogleCalendarClient({
  secretProvider: () => secretsProvider.getSecretString(env.GOOGLE_CALENDAR_SECRET_ID),
  defaultTimeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
});
const slackAuthClient = new SlackAuthClient(() =>
  secretsProvider.getSecretString(env.SLACK_BOT_TOKEN_SECRET_ID),
);
const memoryItemRepository = new MemoryItemRepository(env.MEMORY_ITEMS_TABLE_NAME);
const taskRepository = new TaskRepository(env.TASK_TABLE_NAME);
const taskEventRepository = new TaskEventRepository(env.TASK_EVENTS_TABLE_NAME);
const taskStateRepository = new TaskStateRepository(env.TASKS_TABLE_NAME);
const sessionRepository = new SessionRepository(env.SESSION_TABLE_NAME);

export async function handler(
  event: EventBridgeEvent<string, SchedulerPayload> | SchedulerPayload,
): Promise<void> {
  const detail = "detail" in event ? event.detail : event;
  const taskId = detail.taskId ?? "daily-summary";
  const scheduledAtIso = resolveScheduledAtIso(event);
  const log = logger.child({ component: "scheduled-agent-runner", taskId });

  let task = await taskRepository.get(taskId);
  if (!task) {
    task = await buildFallbackTask(detail, taskId);
    if (detail.persistTask !== false) {
      await taskRepository.save(task);
      log.info("Persisted fallback scheduled task", {
        outputChannelId: task.outputChannelId,
        workspaceId: task.workspaceId,
      });
    }
  }

  if (!task.enabled) {
    throw new Error(`Scheduled task ${taskId} is disabled`);
  }

  const reusableSessionRecord = task.reuseSession
    ? await sessionRepository.findByThread(task.workspaceId, task.outputChannelId, task.taskId)
    : null;
  let sessionId: string | null = null;
  sessionId = reusableSessionRecord?.sessionId ?? null;

  if (!sessionId) {
    const session = await createSession(claudeClient, {
      agentId: task.agentIdOverride ?? env.ANTHROPIC_AGENT_ID,
      environmentId: task.environmentIdOverride ?? env.ANTHROPIC_ENVIRONMENT_ID,
      vaultIds: resolveVaultIds(task, detail),
      title: `Scheduled task ${task.taskId}`,
      metadata: {
        source: "scheduler",
        task_id: task.taskId,
        workspace_id: task.workspaceId,
      },
      memoryResources: task.memoryStoreId
        ? [
            {
              memoryStoreId: task.memoryStoreId,
              access: "read_write",
              prompt: SCHEDULED_MEMORY_RESOURCE_PROMPT,
            },
          ]
        : [],
    });
    sessionId = session.id;
  }

  const seenEventIds = new Set(
    (await claudeClient.listSessionEvents(sessionId, { order: "asc" })).map((sessionEvent) => sessionEvent.id),
  );
  const customToolExecutor = new CustomToolExecutor(
    {
      memoryItems: memoryItemRepository,
      tasks: taskStateRepository,
      taskEvents: taskEventRepository,
      calendarDrafts: calendarDraftRepository,
    },
    {
      workspaceId: task.workspaceId,
      logger: log,
    },
    {
      googleCalendar: googleCalendarClient,
      defaultCalendarTimeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
    },
  );

  await sendUserMessage(claudeClient, {
    sessionId,
    content: [
      {
        type: "text",
        text: buildScheduledPrompt(task.prompt, scheduledAtIso),
      },
    ],
  });

  const completion = await waitForCompletion(claudeClient, {
    sessionId,
    sinceEventIds: seenEventIds,
    timeoutMs: env.AGENT_RESPONSE_TIMEOUT_MS,
    onCustomToolUse: (event) => customToolExecutor.execute(event),
  });

  await slackClient.postMessage({
    channel: task.outputChannelId,
    text: completion.text,
  });

  if (task.reuseSession) {
    const now = new Date().toISOString();
    await sessionRepository.save({
      workspaceId: task.workspaceId,
      channelId: task.outputChannelId,
      threadTs: task.taskId,
      sessionId,
      memoryStoreId: task.memoryStoreId,
      createdAt: reusableSessionRecord?.createdAt ?? now,
      lastUsedAt: now,
    });
  }

  log.info("Scheduled task completed", { sessionId, status: completion.status });
}

async function buildFallbackTask(
  detail: SchedulerPayload,
  taskId: string,
): Promise<ScheduledTask> {
  const outputChannelId = resolveOutputChannelId(detail.outputChannelId);
  if (!outputChannelId) {
    throw new Error(
      "Scheduled task is missing and no output channel is configured. Pass outputChannelId in the invoke payload or deploy with -c defaultScheduleChannel=C123.",
    );
  }

  const auth = await slackAuthClient.authTest();
  const workspaceId = detail.workspaceId ?? auth.team_id;
  if (!workspaceId) {
    throw new Error("Unable to resolve workspaceId from Slack auth.test");
  }

  const now = new Date().toISOString();
  return {
    taskId,
    name: detail.name ?? "Daily Summary",
    prompt:
      detail.prompt ??
      "Post a short smoke-test message saying the scheduled runner is working.",
    workspaceId,
    outputChannelId,
    enabled: true,
    reuseSession: false,
    vaultIds: resolveVaultIds(undefined, detail),
    createdAt: now,
    updatedAt: now,
  };
}

function resolveOutputChannelId(payloadChannelId?: string): string | null {
  if (payloadChannelId) {
    return payloadChannelId;
  }

  if (env.DEFAULT_SCHEDULE_CHANNEL && env.DEFAULT_SCHEDULE_CHANNEL !== "C_PLACEHOLDER") {
    return env.DEFAULT_SCHEDULE_CHANNEL;
  }

  return null;
}

function resolveVaultIds(
  task?: Pick<ScheduledTask, "vaultIds">,
  detail?: Pick<SchedulerPayload, "vaultIds">,
): string[] {
  if (detail?.vaultIds && detail.vaultIds.length > 0) {
    return detail.vaultIds;
  }

  if (task?.vaultIds && task.vaultIds.length > 0) {
    return task.vaultIds;
  }

  return env.ANTHROPIC_VAULT_IDS;
}

function resolveScheduledAtIso(
  event: EventBridgeEvent<string, SchedulerPayload> | SchedulerPayload,
): string {
  if ("time" in event && typeof event.time === "string" && event.time.length > 0) {
    return event.time;
  }

  return new Date().toISOString();
}

function buildScheduledPrompt(basePrompt: string, scheduledAtIso: string): string {
  const date = new Date(scheduledAtIso);
  if (Number.isNaN(date.getTime())) {
    return basePrompt;
  }

  const parts = formatInTimeZone(date, SCHEDULE_TIMEZONE);
  return [
    "Scheduling context:",
    `- Current scheduled run time: ${parts.date} ${parts.time} (${parts.weekday})`,
    `- Time zone: ${SCHEDULE_TIMEZONE}`,
    "- Interpret relative dates such as today, yesterday, and tomorrow using this time zone, not UTC.",
    "",
    basePrompt,
  ].join("\n");
}

function formatInTimeZone(date: Date, timeZone: string): {
  date: string;
  time: string;
  weekday: string;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hourCycle: "h23",
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    weekday: parts.weekday,
  };
}
