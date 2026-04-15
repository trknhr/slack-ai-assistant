export function splitTextForSlack(text: string, maxLength = 3000): string[] {
  const normalized = text.trim();

  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const next = normalized.slice(cursor, cursor + maxLength);
    const breakIndex = next.lastIndexOf("\n\n");
    const sliceLength = breakIndex > maxLength / 2 ? breakIndex : next.length;
    chunks.push(normalized.slice(cursor, cursor + sliceLength).trim());
    cursor += sliceLength;
  }

  return chunks.filter(Boolean);
}
