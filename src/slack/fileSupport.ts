export function inferMimeTypeFromName(name?: string): string | undefined {
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

export function isTextLikeMimeType(mimeType?: string): boolean {
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

export function isSupportedSlackArchiveMimeType(mimeType?: string): boolean {
  if (!mimeType) {
    return false;
  }

  return mimeType === "application/pdf" || mimeType.startsWith("image/") || isTextLikeMimeType(mimeType);
}

export function isSupportedLocalImportMimeType(mimeType?: string): boolean {
  if (!mimeType) {
    return false;
  }

  return (
    mimeType === "application/pdf" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/png"
  );
}

export function defaultExtensionForMimeType(mimeType?: string): string {
  switch (mimeType) {
    case "application/pdf":
      return ".pdf";
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "application/json":
      return ".json";
    case "text/markdown":
      return ".md";
    case "text/csv":
      return ".csv";
    default:
      return isTextLikeMimeType(mimeType) ? ".txt" : "";
  }
}
