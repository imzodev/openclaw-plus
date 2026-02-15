import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import { readFile as fsReadFile } from "node:fs/promises";
import os from "node:os";
import { resolve, isAbsolute, extname } from "node:path";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { assertSandboxPath } from "./sandbox-paths.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const codeReadSchema = Type.Object({
  file_path: Type.String({
    description: "Path to the source file to read (relative or absolute).",
  }),
  offset: Type.Optional(
    Type.Number({
      description: "1-indexed start line. If omitted, reads from the beginning.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        "Number of lines to read. If omitted, reads the entire file (up to internal cap).",
    }),
  ),
  anchor_line: Type.Optional(
    Type.Number({
      description:
        "A line number to anchor on. The tool will expand to show the full code block (function, class, if-block, etc.) " +
        "containing this line, using indentation analysis. Overrides offset/limit when set.",
    }),
  ),
});

export type CodeReadInput = Static<typeof codeReadSchema>;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function expandPath(filePath: string): string {
  const normalized = filePath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/")) {
    return os.homedir() + normalized.slice(1);
  }
  return normalized;
}

function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  return resolve(cwd, expanded);
}

// ---------------------------------------------------------------------------
// Semantic block extraction (indentation-based)
// ---------------------------------------------------------------------------

/**
 * Given a line number, expand outward to find the enclosing code block.
 * Uses indentation to determine block boundaries.
 * Returns [startLine, endLine] (1-indexed, inclusive).
 */
function findEnclosingBlock(
  lines: string[],
  anchorLine: number,
  contextBefore: number = 3,
): { start: number; end: number } {
  const idx = anchorLine - 1; // 0-indexed
  if (idx < 0 || idx >= lines.length) {
    return { start: 1, end: Math.min(lines.length, 50) };
  }

  const anchorIndent = getIndent(lines[idx]);

  // Walk backward to find the block start (a line with less indentation)
  let blockStart = idx;
  for (let i = idx - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim().length === 0) {
      continue; // skip blank lines
    }
    const indent = getIndent(line);
    if (indent < anchorIndent) {
      blockStart = i;
      break;
    }
    if (indent === anchorIndent) {
      blockStart = i;
    }
  }

  // Walk forward to find the block end
  let blockEnd = idx;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) {
      continue;
    }
    const indent = getIndent(line);
    if (indent < anchorIndent) {
      // Include the closing brace/line
      blockEnd = i;
      break;
    }
    blockEnd = i;
  }

  // Add context before the block start
  const start = Math.max(0, blockStart - contextBefore);
  // Add a small buffer after
  const end = Math.min(lines.length - 1, blockEnd + 2);

  return { start: start + 1, end: end + 1 }; // 1-indexed
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  if (!match) {
    return 0;
  }
  // Count spaces (tabs = 4 spaces equivalent)
  let count = 0;
  for (const ch of match[1]) {
    if (ch === "\t") {
      count += 4;
    } else {
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// File operations interface
// ---------------------------------------------------------------------------

export interface CodeReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
}

const defaultOps: CodeReadOperations = {
  readFile: (path) => fsReadFile(path),
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface CodeReadToolOptions {
  operations?: CodeReadOperations;
}

export function createCodeReadTool(
  cwd: string,
  options?: CodeReadToolOptions,
): AgentTool<typeof codeReadSchema> {
  const ops = options?.operations ?? defaultOps;

  return {
    name: "code_read",
    label: "code_read",
    description:
      "Read a source file with line numbers. Supports three modes:\n" +
      "1. Full file: just provide file_path (capped at 2000 lines).\n" +
      "2. Slice: provide offset + limit to read a specific range.\n" +
      "3. Semantic block: provide anchor_line to auto-expand and show the full enclosing code block " +
      "(function, class, method) using indentation analysis.\n" +
      "Output always includes line numbers for use with code_edit and code_apply_diff.",
    parameters: codeReadSchema,
    execute: async (_toolCallId, args, signal): Promise<AgentToolResult<unknown>> => {
      const { file_path, offset, limit, anchor_line } = args;

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      if (!file_path || !file_path.trim()) {
        throw new Error("Missing required parameter: file_path");
      }

      const absolutePath = resolveToCwd(file_path, cwd);
      const _ext = extname(absolutePath).toLowerCase();

      const buffer = await ops.readFile(absolutePath);
      const content = buffer.toString("utf-8");
      const allLines = content.split("\n");
      const totalLines = allLines.length;

      let startLine: number; // 1-indexed
      let endLine: number; // 1-indexed, inclusive
      let mode: string;

      if (anchor_line && anchor_line > 0) {
        // Semantic block mode
        const block = findEnclosingBlock(allLines, anchor_line);
        startLine = block.start;
        endLine = block.end;
        mode = `semantic block around line ${anchor_line}`;
      } else if (offset && offset > 0) {
        // Slice mode
        startLine = offset;
        const lineCount = limit && limit > 0 ? limit : MAX_LINES;
        endLine = Math.min(totalLines, startLine + lineCount - 1);
        mode = `lines ${startLine}-${endLine}`;
      } else {
        // Full file mode
        startLine = 1;
        endLine = Math.min(totalLines, MAX_LINES);
        mode = endLine < totalLines ? `first ${endLine} of ${totalLines} lines` : "full file";
      }

      // Clamp
      startLine = Math.max(1, startLine);
      endLine = Math.min(totalLines, endLine);

      // Extract and format lines
      const selectedLines = allLines.slice(startLine - 1, endLine);
      const numbered = selectedLines.map((line, i) => {
        const lineNum = startLine + i;
        const truncated =
          line.length > MAX_LINE_LENGTH ? line.substring(0, MAX_LINE_LENGTH) + " ..." : line;
        return `${lineNum}\t${truncated}`;
      });

      const header = `${file_path} (${totalLines} lines, showing ${mode})`;
      const body = numbered.join("\n");

      const parts: string[] = [header, "", body];

      // If truncated, add a note
      if (endLine < totalLines) {
        parts.push("");
        parts.push(
          `... ${totalLines - endLine} more lines. Use offset=${endLine + 1} to continue reading.`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: parts.join("\n"),
          },
        ],
        details: undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Sandbox-aware factory
// ---------------------------------------------------------------------------

export function createSandboxedCodeReadTool(params: {
  root: string;
  bridge: SandboxFsBridge;
}): AgentTool<typeof codeReadSchema> {
  const { root, bridge } = params;

  const ops: CodeReadOperations = {
    readFile: (filePath) => bridge.readFile({ filePath, cwd: root }),
  };

  const base = createCodeReadTool(root, { operations: ops });

  return {
    ...base,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const filePath = args.file_path;
      if (typeof filePath === "string" && filePath.trim()) {
        await assertSandboxPath({ filePath, cwd: root, root });
      }
      return base.execute(toolCallId, args, signal, onUpdate);
    },
  };
}
