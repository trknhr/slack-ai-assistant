import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { SecretsProvider } from "../../aws/secretsProvider";
import { loadIngressEnv } from "../../config/env";
import { EventDedupRepository } from "../../repo/eventDedupRepository";
import { logger } from "../../shared/logger";
import { extractSlackQueueMessage, parseSlackEnvelope } from "../../slack/parseEvent";
import { verifySlackSignature } from "../../slack/verifySignature";

const env = loadIngressEnv();
const sqs = new SQSClient({});
const secretsProvider = new SecretsProvider();
const eventDedupRepository = new EventDedupRepository(env.PROCESSED_EVENTS_TABLE_NAME);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  const log = logger.child({ requestId, component: "slack-events-ingress" });
  const rawBody = decodeBody(event.body ?? "", event.isBase64Encoded);
  const signingSecret = await secretsProvider.getSecretString(env.SLACK_SIGNING_SECRET_SECRET_ID);

  const signature =
    event.headers["X-Slack-Signature"] ?? event.headers["x-slack-signature"] ?? undefined;
  const timestamp =
    event.headers["X-Slack-Request-Timestamp"] ??
    event.headers["x-slack-request-timestamp"] ??
    undefined;

  const verified = verifySlackSignature({
    rawBody,
    signature,
    timestamp,
    signingSecret,
  });

  if (!verified) {
    log.warn("Slack signature verification failed");
    return response(401, { ok: false, error: "invalid_signature" });
  }

  const envelope = parseSlackEnvelope(rawBody);
  if (envelope.type === "url_verification") {
    return response(200, { challenge: envelope.challenge });
  }

  if (!envelope.event_id) {
    return response(200, { ok: true, ignored: true });
  }

  const accepted = await eventDedupRepository.markProcessed(
    envelope.event_id,
    env.EVENT_DEDUP_TTL_SECONDS,
  );

  if (!accepted) {
    log.info("Duplicate Slack event ignored", { eventId: envelope.event_id });
    return response(200, { ok: true, duplicate: true });
  }

  const correlationId = `${requestId}:${envelope.event_id}`;
  const queueMessage = extractSlackQueueMessage(envelope, correlationId);

  if (!queueMessage) {
    log.info("Slack event ignored", { eventId: envelope.event_id });
    return response(200, { ok: true, ignored: true });
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: env.SLACK_QUEUE_URL,
      MessageBody: JSON.stringify(queueMessage),
    }),
  );

  log.info("Slack event enqueued", {
    eventId: queueMessage.eventId,
    channelId: queueMessage.channelId,
    conversationTs: queueMessage.conversationTs,
    replyThreadTs: queueMessage.replyThreadTs,
    contextScope: queueMessage.contextScope,
  });

  return response(200, { ok: true });
}

function decodeBody(body: string, isBase64Encoded: boolean | undefined): string {
  return isBase64Encoded ? Buffer.from(body, "base64").toString("utf-8") : body;
}

function response(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  };
}
