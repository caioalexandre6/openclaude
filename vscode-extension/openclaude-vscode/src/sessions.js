const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_SESSIONS_PER_PROJECT = 20;
const MAX_LINES_TO_SCAN = 30;

/**
 * Convert a project slug directory name back to a human-readable path.
 * e.g. "C--Users-caioa-fontes" → "C:\Users\caioa\fontes"
 */
function slugToPath(slug) {
  // Match drive letter pattern like "C--Users-..."
  const driveMatch = slug.match(/^([A-Za-z])--(.+)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toUpperCase();
    const rest = driveMatch[2].replace(/-/g, path.sep);
    return `${drive}:${path.sep}${rest}`;
  }

  // Unix-style: "c--Users-caioa-fontes" or just replace -- with /
  return slug.replace(/--/g, path.sep).replace(/-/g, path.sep);
}

/**
 * Get a short display name for a project path.
 */
function getProjectDisplayName(projectPath) {
  const parts = projectPath.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return projectPath;
  if (parts.length === 1) return parts[0];
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * Read the first N lines from a file without loading the whole file.
 */
function readFirstLines(filePath, maxLines) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const bufSize = 8192;
    const buf = Buffer.alloc(bufSize);
    const lines = [];
    let partial = '';
    let done = false;

    while (!done && lines.length < maxLines) {
      const bytesRead = fs.readSync(fd, buf, 0, bufSize, null);
      if (bytesRead === 0) break;

      const chunk = partial + buf.slice(0, bytesRead).toString('utf8');
      const parts = chunk.split('\n');
      partial = parts.pop() || '';

      for (const line of parts) {
        if (line.trim()) {
          lines.push(line.trim());
        }
        if (lines.length >= maxLines) {
          done = true;
          break;
        }
      }
    }

    if (partial.trim() && lines.length < maxLines) {
      lines.push(partial.trim());
    }

    fs.closeSync(fd);
    return lines;
  } catch {
    return [];
  }
}

/**
 * Extract a short preview from message content.
 */
function extractMessagePreview(content) {
  if (typeof content === 'string') {
    return content.slice(0, 120).replace(/\s+/g, ' ').trim();
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        const text = block.text.trim();
        if (text) return text.slice(0, 120).replace(/\s+/g, ' ').trim();
      }
    }
  }

  return '';
}

/**
 * Parse a JSONL session file and return a summary.
 * Returns null if the file can't be parsed or has no useful content.
 */
function parseSessionFile(filePath, sessionId) {
  const lines = readFirstLines(filePath, MAX_LINES_TO_SCAN);
  if (lines.length === 0) return null;

  let slug = null;
  let timestamp = null;
  let cwd = null;
  let firstUserPreview = '';
  let name = null;

  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== 'object') continue;

    // Capture session metadata from any entry
    if (!slug && parsed.slug) slug = parsed.slug;
    if (!cwd && parsed.cwd) cwd = parsed.cwd;
    if (!name && parsed.name) name = parsed.name;

    if (parsed.type === 'user' && parsed.message) {
      if (!timestamp && parsed.timestamp) timestamp = parsed.timestamp;

      if (!firstUserPreview && parsed.message.content) {
        const preview = extractMessagePreview(parsed.message.content);
        if (
          preview &&
          !preview.startsWith('<ide_') &&
          !preview.startsWith('<local-command') &&
          !preview.startsWith('<command-name>') &&
          !preview.startsWith('This session is being continued') &&
          !preview.startsWith('{') &&
          preview.length > 3
        ) {
          firstUserPreview = preview;
        }
      }

      if (timestamp && firstUserPreview) break;
    }

    if (!timestamp && parsed.timestamp) timestamp = parsed.timestamp;
  }

  if (!timestamp) return null;

  const displayName = name || (slug ? slug.replace(/-/g, ' ') : sessionId.slice(0, 8));

  return {
    sessionId,
    filePath,
    slug: slug || sessionId.slice(0, 8),
    displayName,
    timestamp,
    cwd: cwd || null,
    preview: firstUserPreview || '(no preview)',
  };
}

/**
 * Read all sessions for a single project directory.
 */
function readProjectSessions(projectDir) {
  let entries;
  try {
    entries = fs.readdirSync(projectDir);
  } catch {
    return [];
  }

  const jsonlFiles = entries
    .filter(name => name.endsWith('.jsonl'))
    .map(name => ({
      name,
      sessionId: name.replace(/\.jsonl$/, ''),
      filePath: path.join(projectDir, name),
    }))
    .filter(f => {
      // Validate it looks like a UUID
      return /^[0-9a-f-]{36}$/.test(f.sessionId);
    });

  if (jsonlFiles.length === 0) return [];

  // Sort by mtime descending (most recent first) without parsing all files
  const withMtime = jsonlFiles.map(f => {
    try {
      const stat = fs.statSync(f.filePath);
      return { ...f, mtime: stat.mtimeMs };
    } catch {
      return { ...f, mtime: 0 };
    }
  });

  withMtime.sort((a, b) => b.mtime - a.mtime);

  const sessions = [];
  for (const file of withMtime.slice(0, MAX_SESSIONS_PER_PROJECT)) {
    const summary = parseSessionFile(file.filePath, file.sessionId);
    if (summary) sessions.push(summary);
  }

  return sessions;
}

/**
 * Read all sessions across all projects.
 * Returns an array of project objects, each with sessions sorted by recency.
 */
function readAllProjects() {
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }

  const projects = [];

  for (const dirName of projectDirs) {
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, dirName);

    let stat;
    try {
      stat = fs.statSync(projectDir);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) continue;

    const sessions = readProjectSessions(projectDir);
    if (sessions.length === 0) continue;

    // Sort sessions by timestamp descending
    sessions.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });

    const resolvedPath = slugToPath(dirName);
    projects.push({
      dirName,
      projectPath: resolvedPath,
      displayName: getProjectDisplayName(resolvedPath),
      sessions,
      latestTimestamp: sessions[0]?.timestamp || '',
    });
  }

  // Sort projects by most recent session
  projects.sort((a, b) => {
    const ta = a.latestTimestamp ? new Date(a.latestTimestamp).getTime() : 0;
    const tb = b.latestTimestamp ? new Date(b.latestTimestamp).getTime() : 0;
    return tb - ta;
  });

  return projects;
}

/**
 * Format a timestamp into a human-readable relative date.
 */
function formatRelativeTime(isoTimestamp) {
  try {
    const date = new Date(isoTimestamp);
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `${diffD}d ago`;
    return date.toLocaleDateString();
  } catch {
    return '';
  }
}

module.exports = {
  readAllProjects,
  formatRelativeTime,
  CLAUDE_PROJECTS_DIR,
};
