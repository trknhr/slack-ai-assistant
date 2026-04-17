import { ClaudeInputBlock } from "../claude/client";
import { isTextLikeMimeType } from "../slack/fileSupport";

export function buildClaudeContentBlocksForDocument(
  title: string,
  mimeType: string | undefined,
  buffer: Buffer,
): ClaudeInputBlock[] {
  if (mimeType === "application/pdf") {
    return [
      {
        type: "document",
        title,
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
        text: `Attached image: ${title}`,
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
        title,
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
      text: `Attachment note: ${title} (${mimeType ?? "unknown mime type"}) is not supported for inline analysis.`,
    },
  ];
}
