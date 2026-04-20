import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CreateImportUploadResponse,
  EnqueueImportResponse,
  createImportUploadResponseSchema,
  enqueueImportResponseSchema,
} from "../src/imports/contracts";
import { parseJsonResponse, signedJsonRequest, inferRegionFromApiBaseUrl } from "./apiClient";

interface CliOptions {
  apiBaseUrl: string;
  region: string;
  workspaceId: string;
  userId: string;
  wait: boolean;
  prompt?: string;
  outputDir: string;
  inputs: string[];
}

type ExtractionStatus = "queued" | "processing" | "extracted" | "failed";

interface SourceStatusResponse {
  sourceId: string;
  title: string;
  extractionStatus?: ExtractionStatus;
  extractionErrorMessage?: string;
  extractedMarkdownUrl?: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const files = await collectPdfFiles(options.inputs);
  if (files.length === 0) {
    throw new Error("No PDF files were found. Supported extensions: .pdf");
  }

  console.log(`Found ${files.length} PDF file(s) to extract.`);
  for (const filePath of files) {
    await extractSingleFile(options, filePath);
  }
}

async function extractSingleFile(options: CliOptions, filePath: string): Promise<void> {
  const bytes = await fs.readFile(filePath);
  const fileName = path.basename(filePath);
  const sourcePath = path.relative(process.cwd(), filePath);
  const checksum = createHash("sha256").update(bytes).digest("hex");

  const upload = await postJson<CreateImportUploadResponse>(options, `${options.apiBaseUrl}/imports/uploads`, {
    workspaceId: options.workspaceId,
    userId: options.userId,
    fileName,
    mimeType: "application/pdf",
    fileSize: bytes.byteLength,
    checksum,
    sourcePath,
  });

  await uploadBytes(upload.uploadUrl, "application/pdf", new Uint8Array(bytes));
  const response = await postJson<EnqueueImportResponse>(
    options,
    `${options.apiBaseUrl}/imports/extractions/markdown`,
    {
      workspaceId: options.workspaceId,
      userId: options.userId,
      sourceId: upload.sourceId,
      prompt: options.prompt,
    },
  );

  console.log(`Queued markdown extraction ${sourcePath} -> ${response.sourceId}`);
  if (!options.wait) {
    return;
  }

  const status = await waitForExtraction(options, response.statusUrl);
  if (status.extractionStatus !== "extracted" || !status.extractedMarkdownUrl) {
    throw new Error(status.extractionErrorMessage ?? `Extraction failed for ${sourcePath}`);
  }

  const markdown = await getText(options, status.extractedMarkdownUrl);
  const outputPath = buildOutputPath(options.outputDir, sourcePath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, markdown, "utf-8");
  console.log(`[extracted] ${sourcePath} -> ${path.relative(process.cwd(), outputPath)}`);
}

async function collectPdfFiles(inputs: string[]): Promise<string[]> {
  const files: string[] = [];

  for (const input of inputs) {
    const resolved = path.resolve(input);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      files.push(...(await walkDirectory(resolved)));
      continue;
    }
    if (stat.isFile() && isPdfPath(resolved)) {
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
    if (entry.isFile() && isPdfPath(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function isPdfPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pdf");
}

async function uploadBytes(uploadUrl: string, mimeType: string, bytes: Uint8Array): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "content-type": mimeType,
    },
    body: bytes as unknown as BodyInit,
  });

  if (!response.ok) {
    throw new Error(`Upload failed with status ${response.status}`);
  }
}

async function waitForExtraction(options: CliOptions, statusUrl: string): Promise<SourceStatusResponse> {
  const terminalStatuses = new Set<ExtractionStatus>(["extracted", "failed"]);
  const deadline = Date.now() + 10 * 60 * 1000;

  while (Date.now() < deadline) {
    const status = await getJson<SourceStatusResponse>(options, statusUrl);
    if (status.extractionStatus && terminalStatuses.has(status.extractionStatus)) {
      return status;
    }
    await sleep(3000);
  }

  throw new Error(`Timed out waiting for markdown extraction: ${statusUrl}`);
}

async function postJson<T = unknown>(options: CliOptions, url: string, body: unknown): Promise<T> {
  const response = await signedJsonRequest({ region: options.region }, url, "POST", body);
  const payload = await parseJsonResponse<unknown>(response);
  if (payload && typeof payload === "object" && "uploadUrl" in payload) {
    return createImportUploadResponseSchema.parse(payload) as T;
  }
  if (payload && typeof payload === "object" && "statusUrl" in payload && "sourceId" in payload) {
    return enqueueImportResponseSchema.parse(payload) as T;
  }
  return payload as T;
}

async function getJson<T>(options: CliOptions, url: string): Promise<T> {
  const response = await signedJsonRequest({ region: options.region }, url, "GET");
  return parseJsonResponse<T>(response);
}

async function getText(options: CliOptions, url: string): Promise<string> {
  const response = await signedJsonRequest({ region: options.region }, url, "GET");
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Request failed with status ${response.status}`);
  }
  return text;
}

function buildOutputPath(outputDir: string, sourcePath: string): string {
  const relative = sourcePath.replace(/\.pdf$/i, ".md");
  return path.resolve(outputDir, relative);
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    apiBaseUrl: process.env.IMPORTS_API_BASE_URL,
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    workspaceId: process.env.SLACK_WORKSPACE_ID,
    userId: process.env.SLACK_USER_ID,
    wait: false,
    outputDir: "private-notes/extracted-markdown",
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
      case "--output-dir":
        options.outputDir = argv[++index];
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
    outputDir: options.outputDir ?? "private-notes/extracted-markdown",
    inputs: options.inputs!,
  };
}

function printUsage(): void {
  console.log([
    "Usage:",
    "  ts-node scripts/extract-pdf-markdown.ts --api-base-url https://.../prod --workspace-id T... --user-id U... [--region ap-northeast-1] [--wait] [--output-dir private-notes/extracted-markdown] <file-or-directory> [...]",
    "",
    "Supported formats:",
    "  .pdf",
    "",
    "The API routes use AWS_IAM and are signed with your current AWS credentials.",
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
