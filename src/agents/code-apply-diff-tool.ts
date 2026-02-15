import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { assertSandboxPath } from "./sandbox-paths.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const codeApplyDiffSchema = Type.Object({
  file_path: Type.String({
    description: "Path to the file to modify (relative or absolute).",
  }),
  diff: Type.String({
    description: `One or more SEARCH/REPLACE blocks. Each block follows this format:

<<<<<<< SEARCH
:start_line:42
-------
[exact content to find in the file]
=======
[new content to replace with]
>>>>>>> REPLACE

The :start_line: hint narrows the search window for more reliable matching.
Multiple blocks can be included in a single call for related changes to the same file.
Blocks are applied in order from bottom to top to preserve line numbers.`,
  }),
});

export type CodeApplyDiffInput = Static<typeof codeApplyDiffSchema>;

// ---------------------------------------------------------------------------
// Diff block parsing
// ---------------------------------------------------------------------------

interface DiffBlock {
  startLine?: number;
  searchContent: string;
  replaceContent: string;
  rawBlock: string;
}

interface DiffBlockResult {
  block: DiffBlock;
  success: boolean;
  error?: string;
  matchedAtLine?: number;
}

const SEARCH_MARKER = "<<<<<<< SEARCH";
const SEPARATOR_MARKER = "=======";
const REPLACE_MARKER = ">>>>>>> REPLACE";
const DIVIDER_MARKER = "-------";
const START_LINE_RE = /^:start_line:(\d+)\s*$/;

function parseDiffBlocks(diff: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  const lines = diff.split("\n");
  let i = 0;

  while (i < lines.length) {
    // Find next SEARCH marker
    if (lines[i].trim() !== SEARCH_MARKER) {
      i++;
      continue;
    }

    const blockStartIdx = i;
    i++; // skip SEARCH marker

    // Parse optional :start_line:
    let startLine: number | undefined;
    if (i < lines.length && START_LINE_RE.test(lines[i].trim())) {
      const match = lines[i].trim().match(START_LINE_RE);
      if (match) {
        startLine = parseInt(match[1], 10);
      }
      i++;
    }

    // Skip optional divider
    if (i < lines.length && lines[i].trim() === DIVIDER_MARKER) {
      i++;
    }

    // Collect search content until separator
    const searchLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== SEPARATOR_MARKER) {
      searchLines.push(lines[i]);
      i++;
    }

    if (i >= lines.length) {
      throw new Error(
        `Invalid diff block starting at line ${blockStartIdx + 1}: missing ${SEPARATOR_MARKER} separator`,
      );
    }
    i++; // skip separator

    // Collect replace content until REPLACE marker
    const replaceLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== REPLACE_MARKER) {
      replaceLines.push(lines[i]);
      i++;
    }

    if (i >= lines.length) {
      throw new Error(
        `Invalid diff block starting at line ${blockStartIdx + 1}: missing ${REPLACE_MARKER} marker`,
      );
    }
    i++; // skip REPLACE marker

    const rawBlock = lines.slice(blockStartIdx, i).join("\n");

    blocks.push({
      startLine,
      searchContent: searchLines.join("\n"),
      replaceContent: replaceLines.join("\n"),
      rawBlock,
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Diff application
// ---------------------------------------------------------------------------

type LineEnding = "\r\n" | "\n";

function detectLineEnding(content: string): LineEnding {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeToLF(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function restoreLineEnding(contentLF: string, eol: LineEnding): string {
  if (eol === "\n") {
    return contentLF;
  }
  return contentLF.replace(/\n/g, "\r\n");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Try to find searchContent in the file content, using the startLine hint to narrow the window.
 * Returns the character index of the match, or -1 if not found.
 */
function findSearchContent(
  contentLF: string,
  searchLF: string,
  startLine?: number,
): { index: number; matchedAtLine: number } | null {
  // Strategy 1: exact match near the hinted line
  if (startLine !== undefined && startLine > 0) {
    const lines = contentLF.split("\n");
    const windowSize = 30; // search ±30 lines around the hint
    const hintIdx = startLine - 1; // 0-indexed
    const windowStart = Math.max(0, hintIdx - windowSize);
    const windowEnd = Math.min(lines.length, hintIdx + windowSize);

    // Build the windowed content and search within it
    const windowLines = lines.slice(windowStart, windowEnd);
    const windowContent = windowLines.join("\n");
    const localIdx = windowContent.indexOf(searchLF);

    if (localIdx !== -1) {
      // Convert back to global index
      const prefixLength =
        lines.slice(0, windowStart).join("\n").length + (windowStart > 0 ? 1 : 0);
      const globalIdx = prefixLength + localIdx;
      const matchedAtLine = contentLF.substring(0, globalIdx).split("\n").length;
      return { index: globalIdx, matchedAtLine };
    }
  }

  // Strategy 2: exact match anywhere in the file
  const idx = contentLF.indexOf(searchLF);
  if (idx !== -1) {
    const matchedAtLine = contentLF.substring(0, idx).split("\n").length;
    return { index: idx, matchedAtLine };
  }

  // Strategy 3: whitespace-tolerant match
  const parts = searchLF.match(/(\s+|\S+)/g) ?? [];
  if (parts.length > 0) {
    const pattern = parts
      .map((part) => {
        if (/^\s+$/.test(part)) {
          return part.includes("\n") ? "\\s+" : "[\\t ]+";
        }
        return escapeRegExp(part);
      })
      .join("");

    const regex = new RegExp(pattern);
    const match = regex.exec(contentLF);
    if (match) {
      const matchedAtLine = contentLF.substring(0, match.index).split("\n").length;
      return { index: match.index, matchedAtLine };
    }
  }

  return null;
}

/**
 * Apply a single diff block to the content. Returns the new content.
 */
function _applyBlock(contentLF: string, block: DiffBlock): DiffBlockResult {
  const searchLF = normalizeToLF(block.searchContent);
  const _replaceLF = normalizeToLF(block.replaceContent);

  if (searchLF === "") {
    return {
      block,
      success: false,
      error: "Empty search content in diff block",
    };
  }

  const found = findSearchContent(contentLF, searchLF, block.startLine);
  if (!found) {
    const preview = searchLF.length > 80 ? searchLF.substring(0, 80) + "..." : searchLF;
    const lineHint = block.startLine ? ` (hinted at line ${block.startLine})` : "";
    return {
      block,
      success: false,
      error: `Could not find search content${lineHint}: "${preview}"`,
    };
  }

  return {
    block,
    success: true,
    matchedAtLine: found.matchedAtLine,
  };
}

/**
 * Apply all diff blocks to the content, processing from bottom to top to preserve line numbers.
 */
function applyAllBlocks(
  contentLF: string,
  blocks: DiffBlock[],
): { content: string; results: DiffBlockResult[] } {
  // First, find all matches
  const matchResults: Array<{
    block: DiffBlock;
    index: number;
    matchLength: number;
    matchedAtLine: number;
    searchLF: string;
    replaceLF: string;
  }> = [];
  const failResults: DiffBlockResult[] = [];

  for (const block of blocks) {
    const searchLF = normalizeToLF(block.searchContent);
    const replaceLF = normalizeToLF(block.replaceContent);

    if (searchLF === "") {
      failResults.push({ block, success: false, error: "Empty search content" });
      continue;
    }

    const found = findSearchContent(contentLF, searchLF, block.startLine);
    if (!found) {
      const preview = searchLF.length > 80 ? searchLF.substring(0, 80) + "..." : searchLF;
      const lineHint = block.startLine ? ` (hinted at line ${block.startLine})` : "";
      failResults.push({
        block,
        success: false,
        error: `Could not find search content${lineHint}: "${preview}"`,
      });
      continue;
    }

    matchResults.push({
      block,
      index: found.index,
      matchLength: searchLF.length,
      matchedAtLine: found.matchedAtLine,
      searchLF,
      replaceLF,
    });
  }

  // Sort by index descending (apply from bottom to top)
  matchResults.sort((a, b) => b.index - a.index);

  // Apply replacements
  let result = contentLF;
  const successResults: DiffBlockResult[] = [];

  for (const match of matchResults) {
    result =
      result.substring(0, match.index) +
      match.replaceLF +
      result.substring(match.index + match.matchLength);

    successResults.push({
      block: match.block,
      success: true,
      matchedAtLine: match.matchedAtLine,
    });
  }

  // Combine results in original block order
  const allResults: DiffBlockResult[] = [];
  for (const block of blocks) {
    const success = successResults.find((r) => r.block === block);
    const fail = failResults.find((r) => r.block === block);
    if (success) {
      allResults.push(success);
    } else if (fail) {
      allResults.push(fail);
    }
  }

  return { content: result, results: allResults };
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

function formatBlockError(result: DiffBlockResult, idx: number): string {
  const lineHint = result.block.startLine ? ` (start_line: ${result.block.startLine})` : "";
  return `Block ${idx + 1}${lineHint}: ${result.error}`;
}

function formatError(message: string, suggestions: string[]): string {
  const suggestionsText = suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `${message}\n\n<error_details>\nRecovery suggestions:\n${suggestionsText}\n</error_details>`;
}

// ---------------------------------------------------------------------------
// File operations interface
// ---------------------------------------------------------------------------

export interface CodeApplyDiffOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

import { constants } from "node:fs";
import {
  access as fsAccess,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import os from "node:os";
import { resolve, isAbsolute } from "node:path";

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

const defaultCodeApplyDiffOperations: CodeApplyDiffOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface CodeApplyDiffToolOptions {
  operations?: CodeApplyDiffOperations;
}

export function createCodeApplyDiffTool(
  cwd: string,
  options?: CodeApplyDiffToolOptions,
): AgentTool<typeof codeApplyDiffSchema> {
  const ops = options?.operations ?? defaultCodeApplyDiffOperations;

  return {
    name: "code_apply_diff",
    label: "code_apply_diff",
    description:
      "Apply targeted code modifications using line-number-anchored SEARCH/REPLACE blocks. " +
      "Supports multiple blocks in a single call for related changes to the same file. " +
      "Each block uses :start_line: to narrow the search window for reliable matching. " +
      "Always read the file first to get accurate line numbers. " +
      "Prefer this tool for multi-site edits within a single file.",
    parameters: codeApplyDiffSchema,
    execute: async (_toolCallId, args, signal): Promise<AgentToolResult<unknown>> => {
      const { file_path, diff } = args;

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      if (!file_path || !file_path.trim()) {
        throw new Error(
          formatError("Missing required parameter: file_path", [
            "Provide the path to the file you want to modify",
          ]),
        );
      }

      if (!diff || !diff.trim()) {
        throw new Error(
          formatError("Missing required parameter: diff", [
            "Provide at least one SEARCH/REPLACE block",
          ]),
        );
      }

      const absolutePath = resolveToCwd(file_path, cwd);

      // Check file exists
      try {
        await ops.access(absolutePath);
      } catch {
        throw new Error(
          formatError(`File does not exist: ${file_path}`, [
            "Verify the file path is correct",
            "Use read or find to confirm the correct path",
          ]),
        );
      }

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      // Parse diff blocks
      let blocks: DiffBlock[];
      try {
        blocks = parseDiffBlocks(diff);
      } catch (err) {
        throw new Error(
          formatError(`Failed to parse diff: ${err instanceof Error ? err.message : String(err)}`, [
            "Ensure each block follows the format: <<<<<<< SEARCH / :start_line:N / ------- / [search] / ======= / [replace] / >>>>>>> REPLACE",
            "Check for missing markers or mismatched blocks",
          ]),
          { cause: err },
        );
      }

      if (blocks.length === 0) {
        throw new Error(
          formatError("No SEARCH/REPLACE blocks found in diff", [
            "Include at least one <<<<<<< SEARCH ... >>>>>>> REPLACE block",
            "Check the diff format — each block needs SEARCH, =======, and REPLACE markers",
          ]),
        );
      }

      // Read file
      const buffer = await ops.readFile(absolutePath);
      const rawContent = buffer.toString("utf-8");
      const originalEol = detectLineEnding(rawContent);
      const contentLF = normalizeToLF(rawContent);

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      // Apply all blocks
      const { content: newContentLF, results } = applyAllBlocks(contentLF, blocks);

      const successCount = results.filter((r) => r.success).length;
      const failCount = results.filter((r) => !r.success).length;

      // If all blocks failed, throw error
      if (successCount === 0) {
        const errors = results.map((r, i) => formatBlockError(r, i)).join("\n");
        throw new Error(
          formatError(
            `All ${failCount} diff block(s) failed to apply to ${file_path}:\n${errors}`,
            [
              "Use read to confirm the file's current contents and line numbers",
              "Ensure the search content matches exactly (including whitespace/indentation)",
              "Verify :start_line: values are accurate",
              "If the file has changed, re-read and rebuild the diff",
            ],
          ),
        );
      }

      // Write the result
      const finalContent = restoreLineEnding(newContentLF, originalEol);

      if (finalContent === rawContent) {
        return {
          content: [{ type: "text", text: `No changes needed for ${file_path}` }],
          details: undefined,
        };
      }

      await ops.writeFile(absolutePath, finalContent);

      // Build response
      const parts: string[] = [];
      parts.push(`Applied ${successCount}/${blocks.length} diff block(s) to ${file_path}`);

      // Report successes
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.success) {
          const lineInfo = r.matchedAtLine ? ` at line ${r.matchedAtLine}` : "";
          parts.push(`  ✓ Block ${i + 1}${lineInfo}`);
        }
      }

      // Report failures
      if (failCount > 0) {
        parts.push("");
        parts.push(`⚠️ ${failCount} block(s) failed:`);
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (!r.success) {
            parts.push(`  ✗ ${formatBlockError(r, i)}`);
          }
        }
        parts.push("");
        parts.push("Use read to check the file and re-apply failed blocks.");
      }

      // Show post-edit context (first 20 lines around first successful change)
      const firstSuccess = results.find((r) => r.success);
      if (firstSuccess?.matchedAtLine) {
        const newLines = newContentLF.split("\n");
        const contextStart = Math.max(0, firstSuccess.matchedAtLine - 4);
        const contextEnd = Math.min(newLines.length, firstSuccess.matchedAtLine + 15);
        const context = newLines
          .slice(contextStart, contextEnd)
          .map((l, i) => `${contextStart + i + 1}\t${l}`)
          .join("\n");
        parts.push("");
        parts.push(`Post-edit context (around line ${firstSuccess.matchedAtLine}):`);
        parts.push(context);
      }

      // Hint about multi-block efficiency
      if (blocks.length === 1) {
        parts.push("");
        parts.push(
          "<notice>Multiple related changes can be included as additional SEARCH/REPLACE blocks in a single code_apply_diff call for efficiency.</notice>",
        );
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Sandbox-aware factory
// ---------------------------------------------------------------------------

export function createSandboxedCodeApplyDiffTool(params: {
  root: string;
  bridge: SandboxFsBridge;
}): AgentTool<typeof codeApplyDiffSchema> {
  const { root, bridge } = params;

  const ops: CodeApplyDiffOperations = {
    readFile: (filePath) => bridge.readFile({ filePath, cwd: root }),
    writeFile: (filePath, content) => bridge.writeFile({ filePath, cwd: root, data: content }),
    access: async (filePath) => {
      const stat = await bridge.stat({ filePath, cwd: root });
      if (!stat) {
        const error = new Error(`Sandbox FS error (ENOENT): ${filePath}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
    },
  };

  const base = createCodeApplyDiffTool(root, { operations: ops });

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
