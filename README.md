# slack-ai-assistant

AWS Lambda + CDK scaffold for running a Slack-based assistant on top of Claude Managed Agents.

This repository provides the application glue around Managed Agents:

- Slack Events API ingestion
- asynchronous Slack processing with SQS
- scheduled runs through EventBridge Scheduler
- session mapping and event deduplication
- attachment handling for PDFs, images, and text files
- raw Slack attachment archival to private S3 storage
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

Local bulk import
  -> CLI script
  -> API Gateway
  -> Lambda (document-import-api)
  -> S3 presigned upload
  -> SQS
  -> Lambda (document-import-worker)
  -> Claude Managed Agent

State
  -> DynamoDB

Raw attachment archive
  -> private S3
```

## What is included

- `slack-events-ingress` Lambda
- `slack-events-worker` Lambda
- `document-import-api` Lambda
- `document-import-worker` Lambda
- `scheduled-agent-runner` Lambda
- API Gateway
- SQS + DLQ
- 8 DynamoDB tables
- private S3 bucket for supported Slack attachments
- EventBridge Scheduler
- Claude Managed Agents session + event loop integration
- custom tool execution loop for memory and task persistence
- local bulk import for `pdf`, `jpg/jpeg`, and `png`

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
- `SourceDocumentsTable`
  Stores archived Slack attachment metadata and archive status

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
  documents/
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

## Local bulk import

Bulk import uses the existing private S3 archive bucket plus `SourceDocumentsTable`.

Supported formats:

- `.pdf`
- `.jpg`
- `.jpeg`
- `.png`

Recommended local input directory:

- `private-docs/`

It is ignored by git by default.

Example:

```bash
npm run import-local-docs -- \
  --api-base-url https://YOUR_API_ID.execute-api.ap-northeast-1.amazonaws.com/prod \
  --workspace-id T0123456789 \
  --user-id U0123456789 \
  --region ap-northeast-1 \
  --wait \
  private-docs
```

Flow:

1. The script requests a presigned upload URL from `/imports/uploads`.
2. It uploads the original file to private S3.
3. It queues processing through `/imports/documents`.
4. The import worker sends the file to Claude and persists tasks and memories through the existing custom tools.
5. The script can poll `/imports/workspaces/{workspaceId}/sources/{sourceId}` until completion.

Security:

- `imports/*` endpoints use `AWS_IAM` authorization.
- The local script signs requests with SigV4 using your current AWS credentials.
- Your IAM principal must have `execute-api:Invoke` permission for the import routes.

## Markdown ingestion

Markdown ingestion uses the same `SourceDocumentsTable`, private S3 archive bucket, and import worker.

Supported formats:

- `.md`
- `.markdown`

Recommended local input directory:

- `private-notes/`

It is ignored by git by default.

Example:

```bash
npm run ingest-markdown -- \
  --api-base-url https://YOUR_API_ID.execute-api.ap-northeast-1.amazonaws.com/prod \
  --workspace-id T0123456789 \
  --user-id U0123456789 \
  --region ap-northeast-1 \
  --wait \
  private-notes
```

Flow:

1. The script reads local markdown files and posts them to `/imports/markdown`.
2. The API stores the original markdown in private S3 under `raw/private/notes/...`.
3. It queues processing through the existing document import worker.
4. The worker sends the note to Claude and persists tasks and memories through the existing custom tools.
5. The script can poll `/imports/workspaces/{workspaceId}/sources/{sourceId}` until completion.

Security:

- `/imports/markdown` also uses `AWS_IAM` authorization.
- The local script signs requests with SigV4 using your current AWS credentials.
- Your IAM principal must have `execute-api:Invoke` permission for the import routes.

## Direct chat from your terminal

For quick questions outside Slack, you can call the Managed Agent through an IAM-protected API route:

- `POST /chat/messages`

The repository also includes a signed local CLI:

```bash
npm run ask-agent -- \
  --api-base-url https://YOUR_API_ID.execute-api.ap-northeast-1.amazonaws.com/prod \
  --workspace-id T0123456789 \
  --user-id local-importer-teru \
  --region ap-northeast-1 \
  "今日のやることは？"
```

The response includes:

- `session_id`
- Claude's text response
- any saved memory IDs
- any task IDs touched during the answer

To continue the same conversation, pass the returned `session_id` back:

```bash
npm run ask-agent -- \
  --api-base-url https://YOUR_API_ID.execute-api.ap-northeast-1.amazonaws.com/prod \
  --workspace-id T0123456789 \
  --user-id local-importer-teru \
  --region ap-northeast-1 \
  --session-id sess_... \
  "今夜中のものだけ教えて"
```

Notes:

- `/chat/messages` uses `AWS_IAM` authorization.
- The route is synchronous and best suited to short questions.
- For long-running workflows, keep using Slack, scheduled jobs, or import workers.

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
- supported Slack attachments are archived to a private S3 bucket before being sent to Claude
- unsupported or oversized files are recorded as skipped metadata and degraded into text notes instead of breaking the conversation

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
