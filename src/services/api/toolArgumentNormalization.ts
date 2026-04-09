const STRING_ARGUMENT_TOOL_FIELDS: Record<string, string> = {
  Bash: 'command',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  Glob: 'pattern',
  Grep: 'pattern',
}

// File path fields that should have Windows backslashes normalized to forward slashes.
// Bash is intentionally excluded — backslashes may be valid in shell commands.
const FILE_PATH_FIELDS = new Set(['file_path', 'path'])

/**
 * Normalize Windows-style backslash paths to forward slashes.
 * GPT models on Windows may generate C:\Users\... paths; tools expect
 * either forward slashes or the OS separator, but backslashes in JSON
 * need to be consistent. Convert only fields known to hold file paths.
 */
function normalizeFilePaths(
  toolName: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  // Skip Bash — backslashes are valid in shell command strings
  if (toolName === 'Bash') return record

  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    if (FILE_PATH_FIELDS.has(k) && typeof v === 'string') {
      // Only normalize if the value looks like a Windows path (contains \)
      result[k] = v.includes('\\') ? v.replace(/\\/g, '/') : v
    } else {
      result[k] = v
    }
  }
  return result
}

function isBlankString(value: string): boolean {
  return value.trim().length === 0
}

function isLikelyStructuredObjectLiteral(value: string): boolean {
  // Match object-like patterns with key-value syntax:
  // {"key":, {key:, {'key':, { "key" :, etc.
  // But NOT bash compound commands like { pwd; } or { echo hi; }
  return /^\s*\{\s*['"]?\w+['"]?\s*:/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getPlainStringToolArgumentField(toolName: string): string | null {
  return STRING_ARGUMENT_TOOL_FIELDS[toolName] ?? null
}

export function hasToolFieldMapping(toolName: string): boolean {
  return toolName in STRING_ARGUMENT_TOOL_FIELDS
}

function wrapPlainStringToolArguments(
  toolName: string,
  value: string,
): Record<string, string> | null {
  const field = getPlainStringToolArgumentField(toolName)
  if (!field) return null
  return { [field]: value }
}

export function normalizeToolArguments(
  toolName: string,
  rawArguments: string | undefined,
): unknown {
  if (rawArguments === undefined) return {}

  try {
    const parsed = JSON.parse(rawArguments)
    if (isRecord(parsed)) {
      // OpenAI strict mode sends null for optional fields (schema forces all
      // fields into required[], so the model passes null instead of omitting).
      // Strip null values so Zod .optional() receives undefined, not null.
      const cleaned: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (v !== null) cleaned[k] = v
      }
      return normalizeFilePaths(toolName, cleaned)
    }
    // Parsed as a non-object JSON value (string, number, boolean, null, array)
    if (typeof parsed === 'string' && !isBlankString(parsed)) {
      return wrapPlainStringToolArguments(toolName, parsed) ?? parsed
    }
    // For blank strings, booleans, null, arrays — pass through as-is
    // and let Zod schema validation produce a meaningful error
    return parsed
  } catch {
    // rawArguments is not valid JSON — treat as a plain string
    if (isBlankString(rawArguments) || isLikelyStructuredObjectLiteral(rawArguments)) {
      // Blank or looks like a malformed object literal — don't wrap into
      // a tool field to avoid turning garbage into executable input
      return {}
    }
    return wrapPlainStringToolArguments(toolName, rawArguments) ?? {}
  }
}
