/**
 * Generic, code-defined string sanitization applied to every raw field
 * BEFORE field-mapping, independent of the (schema-only, this slice)
 * `sanitization_rules` table. See PRD §10 / locked slice-2 decision.
 */

/** C0 control characters and DEL, excluding tab/newline/carriage-return (whitespace collapsing handles those). */
const CONTROL_CHARS_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Latin-1/Windows-1252 mis-decoding of UTF-8 bytes typically shows up as Ã/Â followed by a high-bit byte. */
const MOJIBAKE_HINT_PATTERN = /[ÂÃ][\x80-\xBF]/;

const NULL_LIKE_VALUES = new Set(["", "null", "n/a", "-"]);

/** Removes non-printable control characters, keeping normal whitespace intact. */
export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS_PATTERN, "");
}

/**
 * Repairs UTF-8 bytes that were mis-decoded as Latin-1/Windows-1252 (e.g.
 * "cafÃ©" -> "café"). Only rewrites the value when a mojibake hint is
 * present AND the repaired result decodes cleanly (no replacement chars) —
 * otherwise returns the original value untouched.
 */
export function fixMojibake(value: string): string {
  if (!MOJIBAKE_HINT_PATTERN.test(value)) {
    return value;
  }
  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    if (!repaired.includes("�")) {
      return repaired;
    }
  } catch {
    // fall through to return the original value
  }
  return value;
}

/** Trims leading/trailing whitespace and collapses internal whitespace runs to a single space. */
export function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** Normalizes null-like string literals (case-insensitive) to `null`; passes through any other value. */
export function normalizeNullLike(value: string): string | null {
  return NULL_LIKE_VALUES.has(value.toLowerCase()) ? null : value;
}

const STRING_TRANSFORMS: readonly ((value: string) => string)[] = [
  stripControlChars,
  fixMojibake,
  collapseWhitespace,
];

/**
 * Sanitizes a single raw value before mapping. Strings are run through the
 * strip -> mojibake-fix -> collapse-whitespace -> null-normalize pipeline.
 * `null`/`undefined` become `null`. Any other type is coerced to its string
 * representation (mapping only ever deals with string/`{ id }` payload
 * values downstream).
 */
export function sanitizeValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return String(value);
  }

  const cleaned = STRING_TRANSFORMS.reduce((acc, transform) => transform(acc), value);
  return normalizeNullLike(cleaned);
}

/** Applies `sanitizeValue` to every field of a raw record, preserving its keys. */
export function sanitizeRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    sanitized[key] = sanitizeValue(value);
  }
  return sanitized;
}
