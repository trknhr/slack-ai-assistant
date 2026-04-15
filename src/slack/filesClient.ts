import { SlackFileReference } from "../shared/contracts";
import { ClaudeInputBlock } from "../claude/client";

interface SlackApiFileInfoResponse {
  ok: boolean;
  error?: string;
  file?: {
    id?: string;
    name?: string;
    title?: string;
    mimetype?: string;
    file_access?: string;
    url_private?: string;
    url_private_download?: string;
    permalink?: string;
    is_external?: boolean;
    external_url?: string;
    size?: number;
  };
}

export class SlackFilesClient {
  constructor(
    private readonly tokenProvider: () => Promise<string>,
    private readonly maxFileBytes: number,
  ) {}

  async buildContentBlocks(files: SlackFileReference[]): Promise<ClaudeInputBlock[]> {
    const blocks: ClaudeInputBlock[] = [];

    for (const file of files.slice(0, 3)) {
      try {
        const resolved = await this.resolveFile(file);
        blocks.push(...(await this.toContentBlocks(resolved)));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown attachment error";
        blocks.push({
          type: "text",
          text: `Attachment note: Could not read ${file.name ?? file.title ?? file.id}. ${message}`,
        });
      }
    }

    if (files.length > 3) {
      blocks.push({
        type: "text",
        text: `Attachment note: ${files.length - 3} additional file(s) were omitted to keep the request bounded.`,
      });
    }

    return blocks;
  }

  private async resolveFile(file: SlackFileReference): Promise<SlackFileReference> {
    if (file.fileAccess !== "check_file_info" && (file.urlPrivate || file.urlPrivateDownload)) {
      return file;
    }

    const token = await this.tokenProvider();
    const response = await fetch(`https://slack.com/api/files.info?file=${encodeURIComponent(file.id)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`files.info failed with status ${response.status}. Ensure the app has files:read.`);
    }

    const payload = (await response.json()) as SlackApiFileInfoResponse;
    if (!payload.ok || !payload.file) {
      throw new Error(
        `files.info returned error: ${payload.error ?? "missing file object"}. Ensure the app has files:read.`,
      );
    }

    return {
      id: payload.file.id ?? file.id,
      name: payload.file.name ?? file.name,
      title: payload.file.title ?? file.title,
      mimetype: payload.file.mimetype ?? file.mimetype,
      fileAccess: payload.file.file_access ?? file.fileAccess,
      urlPrivate: payload.file.url_private ?? file.urlPrivate,
      urlPrivateDownload: payload.file.url_private_download ?? file.urlPrivateDownload,
      permalink: payload.file.permalink ?? file.permalink,
      isExternal: payload.file.is_external ?? file.isExternal,
      externalUrl: payload.file.external_url ?? file.externalUrl,
      size: payload.file.size ?? file.size,
    };
  }

  private async toContentBlocks(file: SlackFileReference): Promise<ClaudeInputBlock[]> {
    const label = file.name ?? file.title ?? file.id;

    if (file.isExternal && file.externalUrl) {
      return [
        {
          type: "text",
          text: `Attached external file: ${label}. URL: ${file.externalUrl}`,
        },
      ];
    }

    if (file.size && file.size > this.maxFileBytes) {
      return [
        {
          type: "text",
          text: `Attachment note: ${label} was skipped because it is larger than ${this.maxFileBytes} bytes.`,
        },
      ];
    }

    const downloadUrl = file.urlPrivateDownload ?? file.urlPrivate;
    if (!downloadUrl) {
      return [
        {
          type: "text",
          text: `Attachment note: ${label} did not include a downloadable URL.`,
        },
      ];
    }

    const token = await this.tokenProvider();
    const response = await fetch(downloadUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `download failed with status ${response.status}. Ensure the app has files:read and access to this channel.`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.byteLength > this.maxFileBytes) {
      return [
        {
          type: "text",
          text: `Attachment note: ${label} exceeded the ${this.maxFileBytes} byte limit after download.`,
        },
      ];
    }

    const mimeType = file.mimetype ?? inferMimeTypeFromName(file.name);

    if (mimeType === "application/pdf") {
      return [
        {
          type: "document",
          title: label,
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: buffer.toString("base64"),
          },
        },
      ];
    }

    if (mimeType && mimeType.startsWith("image/")) {
      return [
        {
          type: "text",
          text: `Attached image: ${label}`,
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mimeType,
            data: buffer.toString("base64"),
          },
        },
      ];
    }

    if (isTextLikeMimeType(mimeType)) {
      return [
        {
          type: "document",
          title: label,
          source: {
            type: "text",
            media_type: "text/plain",
            data: buffer.toString("utf-8"),
          },
        },
      ];
    }

    return [
      {
        type: "text",
        text: `Attachment note: ${label} (${mimeType ?? "unknown mime type"}) is not yet supported for inline analysis.`,
      },
    ];
  }
}

function inferMimeTypeFromName(name?: string): string | undefined {
  if (!name) {
    return undefined;
  }

  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".csv")) {
    return "text/plain";
  }
  if (lower.endsWith(".json")) {
    return "application/json";
  }
  return undefined;
}

function isTextLikeMimeType(mimeType?: string): boolean {
  if (!mimeType) {
    return false;
  }

  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/javascript"
  );
}
