import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

const credentialsProvider = defaultProvider();

export interface SignedApiOptions {
  region: string;
}

export async function postJson<T = unknown>(
  options: SignedApiOptions,
  url: string,
  body: unknown,
): Promise<T> {
  const response = await signedJsonRequest(options, url, "POST", body);

  return parseJsonResponse<T>(response);
}

export async function getJson<T>(options: SignedApiOptions, url: string): Promise<T> {
  const response = await signedJsonRequest(options, url, "GET");

  return parseJsonResponse<T>(response);
}

export async function signedJsonRequest(
  options: SignedApiOptions,
  url: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<Response> {
  const target = new URL(url);
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  const signer = new SignatureV4({
    credentials: credentialsProvider,
    region: options.region,
    service: "execute-api",
    sha256: Sha256,
  });

  const signed = await signer.sign(
    new HttpRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port ? Number(target.port) : undefined,
      method,
      path: `${target.pathname}${target.search}`,
      headers: {
        host: target.host,
        accept: "application/json",
        ...(bodyText
          ? {
              "content-type": "application/json; charset=utf-8",
            }
          : {}),
      },
      body: bodyText,
    }),
  );

  const headers = new Headers();
  for (const [key, value] of Object.entries(signed.headers)) {
    if (value !== undefined) {
      headers.set(key, value);
    }
  }

  return fetch(url, {
    method,
    headers,
    body: bodyText,
  });
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const errorMessage =
      payload && typeof payload.message === "string"
        ? payload.message
        : `Request failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  return payload as T;
}

export function inferRegionFromApiBaseUrl(apiBaseUrl?: string): string | undefined {
  if (!apiBaseUrl) {
    return undefined;
  }

  try {
    const hostname = new URL(apiBaseUrl).hostname;
    const match = hostname.match(/\.execute-api\.([a-z0-9-]+)\./);
    return match?.[1];
  } catch {
    return undefined;
  }
}
