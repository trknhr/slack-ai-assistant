import { promises as fs } from "node:fs";
import path from "node:path";
import {
  EnqueueImportResponse,
  enqueueImportResponseSchema,
} from "../src/imports/contracts";
import { inferRegionFromApiBaseUrl, parseJsonResponse, signedJsonRequest } from "./apiClient";

interface CliOptions {
  apiBaseUrl: string;
  region: string;
  workspaceId: string;
  userId: string;
  wait: boolean;
  prompt?: string;
  inputs: string[];
}

type ImportStatus =
  | "upload_pending"
  | "uploaded"
  | "queued"
  | "processing"
  | "imported"
  | "failed"
  | "skipped_unsupported"
  | "skipped_oversize"
  | "archive_failed";

interface SourceStatusResponse {
  sourceId: string;
  title: string;
  status: ImportStatus;
  summary?: string;
  errorMessage?: string;
  importedTaskIds?: string[];
  savedMemoryIds?: string[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const files = await collectMarkdownFiles(options.inputs);
  if (files.length === 0) {
    throw new Error("No markdown files were found. Supported extensions: .md, .markdown");
  }

  console.log(`Found ${files.length} markdown file(s) to ingest.`);
  for (const filePath of files) {
    await ingestSingleFile(options, filePath);
  }
}

async function ingestSingleFile(options: CliOptions, filePath: string): Promise<void> {
  const markdown = await fs.readFile(filePath, "utf-8");
  if (markdown.trim().length === 0) {
    console.log(`Skipping empty markdown file: ${path.relative(process.cwd(), filePath)}`);
    return;
  }

  const fileName = path.basename(filePath);
  const sourcePath = path.relative(process.cwd(), filePath);
  const response = await postJson<EnqueueImportResponse>(
    options,
    `${options.apiBaseUrl}/imports/markdown`,
    {
      workspaceId: options.workspaceId,
      userId: options.userId,
      title: fileName,
      markdown,
      sourcePath,
      prompt: options.prompt,
    },
  );

  console.log(`Queued ${sourcePath} -> ${response.sourceId}`);
  if (!options.wait) {
    return;
  }

  const status = await waitForTerminalStatus(options, response.statusUrl);
  const taskCount = status.importedTaskIds?.length ?? 0;
  const memoryCount = status.savedMemoryIds?.length ?? 0;
  console.log(`[${status.status}] ${sourcePath}`);
  if (status.summary) {
    console.log(status.summary);
  }
  if (status.errorMessage) {
    console.log(`Error: ${status.errorMessage}`);
  }
  console.log(`Tasks: ${taskCount}, Memories: ${memoryCount}`);
}

async function collectMarkdownFiles(inputs: string[]): Promise<string[]> {
  const files: string[] = [];

  for (const input of inputs) {
    const resolved = path.resolve(input);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      files.push(...(await walkDirectory(resolved)));
      continue;
    }
    if (stat.isFile() && isMarkdownPath(resolved)) {
      files.push(resolved);
    }
  }

  return files.sort();
}

async function walkDirectory(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDirectory(fullPath)));
      continue;
    }
    if (entry.isFile() && isMarkdownPath(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function isMarkdownPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

async function waitForTerminalStatus(options: CliOptions, statusUrl: string): Promise<SourceStatusResponse> {
  const terminalStatuses = new Set<ImportStatus>([
    "imported",
    "failed",
    "skipped_unsupported",
    "skipped_oversize",
    "archive_failed",
  ]);
  const deadline = Date.now() + 10 * 60 * 1000;

  while (Date.now() < deadline) {
    const status = await getJson<SourceStatusResponse>(options, statusUrl);
    if (terminalStatuses.has(status.status)) {
      return status;
    }
    await sleep(3000);
  }

  throw new Error(`Timed out waiting for import completion: ${statusUrl}`);
}

async function postJson<T = unknown>(options: CliOptions, url: string, body: unknown): Promise<T> {
  const response = await signedJsonRequest({ region: options.region }, url, "POST", body);
  const payload = await parseJsonResponse<unknown>(response);
  if (payload && typeof payload === "object" && "statusUrl" in payload && "sourceId" in payload) {
    return enqueueImportResponseSchema.parse(payload) as T;
  }

  return payload as T;
}

async function getJson<T>(options: CliOptions, url: string): Promise<T> {
  const response = await signedJsonRequest({ region: options.region }, url, "GET");

  return parseJsonResponse<T>(response);
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    apiBaseUrl: process.env.IMPORTS_API_BASE_URL,
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    workspaceId: process.env.SLACK_WORKSPACE_ID,
    userId: process.env.SLACK_USER_ID,
    wait: false,
    inputs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--api-base-url":
        options.apiBaseUrl = argv[++index];
        break;
      case "--workspace-id":
        options.workspaceId = argv[++index];
        break;
      case "--region":
        options.region = argv[++index];
        break;
      case "--user-id":
        options.userId = argv[++index];
        break;
      case "--prompt":
        options.prompt = argv[++index];
        break;
      case "--wait":
        options.wait = true;
        break;
      case "--help":
        printUsage();
        process.exit(0);
      default:
        if (value.startsWith("--")) {
          throw new Error(`Unknown option: ${value}`);
        }
        options.inputs!.push(value);
    }
  }

  const inferredRegion = options.region ?? inferRegionFromApiBaseUrl(options.apiBaseUrl);

  if (!options.apiBaseUrl || !inferredRegion || !options.workspaceId || !options.userId || options.inputs!.length === 0) {
    printUsage();
    throw new Error("Missing required options");
  }

  return {
    apiBaseUrl: options.apiBaseUrl.replace(/\/+$/, ""),
    region: inferredRegion,
    workspaceId: options.workspaceId,
    userId: options.userId,
    wait: options.wait ?? false,
    prompt: options.prompt,
    inputs: options.inputs!,
  };
}

function printUsage(): void {
  console.log([
    "Usage:",
    "  ts-node scripts/ingest-markdown.ts --api-base-url https://.../prod --workspace-id T... --user-id U... [--region ap-northeast-1] [--wait] <file-or-directory> [...]",
    "",
    "Supported formats:",
    "  .md .markdown",
    "",
    "Recommended local input directory:",
    "  private-notes/",
    "",
    "AWS credentials with execute-api:Invoke are required.",
  ].join("\n"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
