# slack-ai-assistant

AWS Lambda + CDK scaffold for running a Slack-based assistant on top of Claude Managed Agents.

This repository provides the application glue around Managed Agents:

- Slack Events API ingestion
- asynchronous Slack processing with SQS
- scheduled runs through EventBridge Scheduler
- session mapping and event deduplication
- attachment handling for PDFs, images, and text files
- custom tool execution backed by DynamoDB for memories and tasks

The goal is to keep reasoning and sandboxing inside Claude Managed Agents while handling webhooks, state, and integrations in AWS.

## Architecture

```text
Slack mention / DM
  -> API Gateway
  -> Lambda (slack-events-ingress)
  -> SQS
  -> Lambda (slack-events-worker)
  -> Claude Managed Agent
  -> Slack reply

Scheduled reminder
  -> EventBridge Scheduler
  -> Lambda (scheduled-agent-runner)
  -> Claude Managed Agent
  -> Slack post

State
  -> DynamoDB
```

## What is included

- `slack-events-ingress` Lambda
- `slack-events-worker` Lambda
- `scheduled-agent-runner` Lambda
- API Gateway
- SQS + DLQ
- 7 DynamoDB tables
- EventBridge Scheduler
- Claude Managed Agents session + event loop integration
- custom tool execution loop for memory and task persistence

## DynamoDB tables

- `SlackThreadSessionsTable`
  Maps Slack `workspace/channel/thread` to Claude `session_id`
- `ProcessedEventsTable`
  Stores Slack event IDs for deduplication
- `ScheduledTasksTable`
  Stores scheduled task definitions
- `UserMemoriesTable`
  Maps users to Claude memory store IDs
- `MemoryItemsTable`
  Stores durable semi-structured memories
- `TasksTable`
  Stores current task state
- `TaskEventsTable`
  Stores task history

## Repository layout

```text
bin/
lib/
scripts/
src/
  aws/
  claude/
  config/
  functions/
  memory/
  repo/
  shared/
  slack/
  tasks/
  tools/
```

## Prerequisites

1. Create these AWS Secrets Manager secrets:
   - `/slack-ai-assistant/slack-signing-secret`
   - `/slack-ai-assistant/slack-bot-token`
   - `/slack-ai-assistant/anthropic-api-key`
2. Prepare a Claude Managed Agent `agent_id` and `environment_id`
3. If your MCP setup requires it, prepare one or more `vault_ids`
4. Bootstrap CDK in the target AWS account and region

## Deploy

```bash
npm install
npx cdk deploy \
  -c anthropicAgentId=agent_0123456789 \
  -c anthropicEnvironmentId=env_0123456789 \
  -c anthropicVaultIds=vlt_0123456789 \
  -c defaultScheduleChannel=C0123456789
```

Notes:

- `defaultScheduleChannel` lets the scheduled runner create a fallback task automatically if `daily-summary` is missing.
- `anthropicVaultIds` accepts a comma-separated list.

## Sync custom tools to the Managed Agent

The repository stores custom tool definitions in `src/tools/anthropic-custom-tools.json`.

Sync them to your agent with:

```bash
npm run sync-agent-tools -- --agent-id=agent_0123456789
```

Optional overrides:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_API_KEY_SECRET_ID`
- `ANTHROPIC_MANAGED_AGENTS_BETA`
- `ANTHROPIC_CUSTOM_TOOLS_FILE`

## Current scope

- `ENABLE_USER_MEMORY=false` by default
- EventBridge Scheduler triggers `daily-summary`
- scheduled task definitions live in `ScheduledTasksTable`
- fallback scheduled tasks can be created from `outputChannelId` in the invoke payload or from `defaultScheduleChannel`
- if your agent requires MCP authentication via vaults, pass `anthropicVaultIds=vlt_...` at deploy time or include `vaultIds` in the scheduled invoke payload

Example scheduled task item:

```json
{
  "pk": "TASK#daily-summary",
  "taskId": "daily-summary",
  "name": "Daily Summary",
  "prompt": "Summarize yesterday's activity and post a concise update.",
  "workspaceId": "T0123456789",
  "outputChannelId": "C0123456789",
  "enabled": true,
  "reuseSession": false,
  "createdAt": "2026-04-13T00:00:00.000Z",
  "updatedAt": "2026-04-13T00:00:00.000Z"
}
```

## Attachments

Slack file support currently covers:

- PDFs
- images
- text-like files

Requirements and limits:

- your Slack app must include `files:read`
- the current default max file size is `10MB` per file
- unsupported or oversized files are degraded into text notes instead of breaking the conversation

## Managed Agent notes

- beta header: `managed-agents-2026-04-01`
- thread conversations are modeled as `Slack thread = Claude session`
- user-level Claude memory stores can be attached through `resources[]`
- custom tool execution is handled by the Lambda side when the agent emits `agent.custom_tool_use`

## Security

- Do not commit real tokens, secret values, vault IDs, agent IDs, or environment IDs.
- Do not commit `cdk.out/` artifacts or other generated deployment outputs.
- Keep Slack signing secrets, bot tokens, and Anthropic API keys in Secrets Manager only.

## License

MIT
