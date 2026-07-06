/**
 * Parses a response body that contains zero or more top-level JSON objects
 * concatenated together, with or without newline separators between them
 * (the Leads DB `/export?format=jsonl` endpoint has been observed to return
 * both compact one-object-per-line output and pretty-printed multi-line
 * objects with no separator). Scans character-by-character tracking brace
 * depth and string state so braces inside string values never throw off the
 * object boundaries.
 */
export function parseJsonLines(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const results: Record<string, unknown>[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (char === "\\") {
        escapeNext = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        objectStart = i;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        const objectText = trimmed.slice(objectStart, i + 1);
        results.push(JSON.parse(objectText) as Record<string, unknown>);
        objectStart = -1;
      }
    }
  }

  return results;
}
