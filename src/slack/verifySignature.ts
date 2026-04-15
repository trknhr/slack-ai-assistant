import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifySlackSignatureInput {
  rawBody: string;
  signature?: string;
  timestamp?: string;
  signingSecret: string;
}

export function verifySlackSignature(input: VerifySlackSignatureInput): boolean {
  const { rawBody, signature, timestamp, signingSecret } = input;

  if (!signature || !timestamp) {
    return false;
  }

  const requestTimestamp = Number(timestamp);
  if (!Number.isFinite(requestTimestamp)) {
    return false;
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - requestTimestamp);
  if (ageSeconds > 60 * 5) {
    return false;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const digest = createHmac("sha256", signingSecret).update(base).digest("hex");
  const expected = `v0=${digest}`;

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
