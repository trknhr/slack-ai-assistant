import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyLineSignatureInput {
  rawBody: string;
  signature?: string;
  channelSecret: string;
}

export function verifyLineSignature(input: VerifyLineSignatureInput): boolean {
  if (!input.signature) {
    return false;
  }

  const expected = createHmac("sha256", input.channelSecret)
    .update(input.rawBody)
    .digest("base64");

  const actualBuffer = Buffer.from(input.signature);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}
