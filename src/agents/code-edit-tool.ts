import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { assertSandboxPath } from "./sandbox-paths.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const codeEditSchema = Type.Object({
  file_path: Type.String({
    description:
      "Path to the file to edit (relative or absolute). Use empty old_string to create a new file.",
  }),
  old_string: Type.String({
    description:
      "The text to find and replace. Must match the file contents (whitespace-tolerant matching is attempted on failure). Include 3-5 lines of surrounding context for uniqueness. Use empty string to create a new file.",
  }),
  new_string: Type.String({
    description:
      "The replacement text. When creating a new file (old_string is empty), this becomes the entire file content.",
  }),
  expected_replacements: Type.Optional(
    Type.Number({
      description:
        "Number of occurrences to replace. Defaults to 1. Set higher to replace multiple identical occurrences.",
      minimum: 1,
    }),
  ),
});

export type CodeEditInput = Static<typeof codeEditSchema>;

// ---------------------------------------------------------------------------
// Fuzzy matching helpers
// ---------------------------------------------------------------------------

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(str: string, substr: string): number {
  if (substr === "") {
    return 0;
  }
  let count = 0;
  let pos = str.indexOf(substr);
  while (pos !== -1) {
    count++;
    pos = str.indexOf(substr, pos + substr.length);
  }
  return count;
}

function countRegexMatches(content: string, regex: RegExp): number {
  const stable = new RegExp(regex.source, regex.flags);
  return Array.from(content.matchAll(stable)).length;
}

/**
 * Build a regex that tolerates whitespace differences.
 * Newline-containing whitespace runs match any whitespace; horizontal-only runs match tabs/spaces.
 */
function buildWhitespaceTolerantRegex(oldLF: string): RegExp {
  if (oldLF === "") {
    return new RegExp("(?!)", "g");
  }

  const parts = oldLF.match(/(\s+|\S+)/g) ?? [];
  const pattern = parts
    .map((part) => {
      if (/^\s+$/.test(part)) {
        return part.includes("\n") ? "\\s+" : "[\\t ]+";
      }
      return escapeRegExp(part);
    })
    .join("");

  return new RegExp(pattern, "g");
}

/**
 * Build a regex that matches tokens (non-whitespace) separated by any whitespace.
 */
function buildTokenRegex(oldLF: string): RegExp {
  const tokens = oldLF.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return new RegExp("(?!)", "g");
  }
  const pattern = tokens.map(escapeRegExp).join("\\s+");
  return new RegExp(pattern, "g");
}

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

/**
 * Safely replace all occurrences of a literal string, handling $ escape sequences.
 */
function safeLiteralReplace(str: string, oldString: string, newString: string): string {
  if (oldString === "" || !str.includes(oldString)) {
    return str;
  }
  if (!newString.includes("$")) {
    return str.replaceAll(oldString, newString);
  }
  const escapedNewString = newString.replaceAll("$", "$$$$");
  return str.replaceAll(oldString, escapedNewString);
}

// ---------------------------------------------------------------------------
// Post-edit context extraction
// ---------------------------------------------------------------------------

function extractContext(
  content: string,
  oldText: string,
  newText: string,
  contextLines: number = 5,
): string {
  const lines = content.split("\n");
  const newTextLines = newText.split("\n");

  // Find where the new text starts in the content
  const idx = content.indexOf(newText);
  if (idx === -1) {
    // Fallback: return first N lines
    const preview = lines
      .slice(0, contextLines * 2)
      .map((l, i) => `${i + 1}\t${l}`)
      .join("\n");
    return preview;
  }

  const linesBefore = content.substring(0, idx).split("\n").length - 1;
  const startLine = Math.max(0, linesBefore - contextLines);
  const endLine = Math.min(lines.length, linesBefore + newTextLines.length + contextLines);
  return lines
    .slice(startLine, endLine)
    .map((l, i) => `${startLine + i + 1}\t${l}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

function formatError(message: string, suggestions: string[]): string {
  const suggestionsText = suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `${message}\n\n<error_details>\nRecovery suggestions:\n${suggestionsText}\n</error_details>`;
}

// ---------------------------------------------------------------------------
// File operations interface
// ---------------------------------------------------------------------------

export interface CodeEditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

import { constants } from "node:fs";
import {
  access as fsAccess,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir as fsMkdir,
} from "node:fs/promises";
import os from "node:os";
import { dirname, resolve, isAbsolute } from "node:path";

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

const defaultCodeEditOperations: CodeEditOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
  mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface CodeEditToolOptions {
  operations?: CodeEditOperations;
}

export function createCodeEditTool(
  cwd: string,
  options?: CodeEditToolOptions,
): AgentTool<typeof codeEditSchema> {
  const ops = options?.operations ?? defaultCodeEditOperations;

  return {
    name: "code_edit",
    label: "code_edit",
    description:
      "Edit a code file using smart search-and-replace with fuzzy matching. " +
      "Tries exact match first, then whitespace-tolerant, then token-based matching. " +
      "Use empty old_string to create a new file. " +
      "Always read the file first to confirm its contents before editing. " +
      "Include 3-5 lines of context around the target text for uniqueness.",
    parameters: codeEditSchema,
    execute: async (_toolCallId, args, signal): Promise<AgentToolResult<unknown>> => {
      const { file_path, old_string, new_string, expected_replacements } = args;
      const expectedCount = Math.max(1, expected_replacements ?? 1);

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      if (!file_path || !file_path.trim()) {
        throw new Error(
          formatError("Missing required parameter: file_path", [
            "Provide the path to the file you want to edit",
          ]),
        );
      }

      const absolutePath = resolveToCwd(file_path, cwd);

      // --- Create-file mode ---
      if (old_string === "") {
        // Check if file already exists
        let exists = false;
        try {
          await ops.access(absolutePath);
          exists = true;
        } catch {
          // File doesn't exist — good, we'll create it
        }

        if (exists) {
          throw new Error(
            formatError(`File already exists: ${file_path}`, [
              "To modify an existing file, provide a non-empty old_string that matches the current file contents",
              "Use read to confirm the exact text to match",
              "If you intended to overwrite the entire file, use write or code_write instead",
            ]),
          );
        }

        await ops.mkdir(dirname(absolutePath));
        await ops.writeFile(absolutePath, new_string);

        const lineCount = new_string.split("\n").length;
        const preview = new_string
          .split("\n")
          .slice(0, 20)
          .map((l, i) => `${i + 1}\t${l}`)
          .join("\n");
        const truncNote = lineCount > 20 ? `\n... (${lineCount - 20} more lines)` : "";

        return {
          content: [
            {
              type: "text",
              text: `Created new file: ${file_path} (${lineCount} lines)\n\n${preview}${truncNote}`,
            },
          ],
          details: undefined,
        };
      }

      // --- Edit mode ---
      // Check file exists
      try {
        await ops.access(absolutePath);
      } catch {
        throw new Error(
          formatError(`File does not exist: ${file_path}`, [
            "Verify the file path is correct",
            "If you intended to create a new file, set old_string to an empty string",
            "Use read or find to confirm the correct path",
          ]),
        );
      }

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const buffer = await ops.readFile(absolutePath);
      const rawContent = buffer.toString("utf-8");
      const originalEol = detectLineEnding(rawContent);
      const contentLF = normalizeToLF(rawContent);
      const oldLF = normalizeToLF(old_string);
      const newLF = normalizeToLF(new_string);

      // Validate old_string !== new_string
      if (oldLF === newLF) {
        throw new Error(
          formatError(
            `No changes to apply: old_string and new_string are identical (after normalizing line endings)`,
            [
              "Update new_string to the intended replacement text",
              "If you intended to verify file state only, use read instead",
            ],
          ),
        );
      }

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      // --- 3-tier fuzzy matching ---
      let resultContentLF = contentLF;
      let matchStrategy = "";

      const wsRegex = buildWhitespaceTolerantRegex(oldLF);
      const tokenRegex = buildTokenRegex(oldLF);

      // Strategy 1: exact literal match
      const exactCount = countOccurrences(contentLF, oldLF);
      if (exactCount === expectedCount) {
        resultContentLF = safeLiteralReplace(contentLF, oldLF, newLF);
        matchStrategy = "exact";
      } else {
        // Strategy 2: whitespace-tolerant regex
        const wsCount = countRegexMatches(contentLF, wsRegex);
        if (wsCount === expectedCount) {
          resultContentLF = contentLF.replace(wsRegex, () => newLF);
          matchStrategy = "whitespace-tolerant";
        } else {
          // Strategy 3: token-based regex
          const tokenCount = countRegexMatches(contentLF, tokenRegex);
          if (tokenCount === expectedCount) {
            resultContentLF = contentLF.replace(tokenRegex, () => newLF);
            matchStrategy = "token-based";
          } else {
            // --- Error reporting ---
            const anyMatches = exactCount > 0 || wsCount > 0 || tokenCount > 0;

            if (!anyMatches) {
              throw new Error(
                formatError(`No match found in ${file_path}`, [
                  "Use read to confirm the file's current contents",
                  "Ensure old_string matches exactly (including whitespace/indentation)",
                  "Provide more surrounding context in old_string to make the match unique",
                  "If the file has changed since you last read it, re-read and retry",
                ]),
              );
            }

            if (exactCount > 0) {
              throw new Error(
                formatError(
                  `Occurrence count mismatch in ${file_path}: expected ${expectedCount} but found ${exactCount} exact match(es)`,
                  [
                    "Provide a more specific old_string so it matches exactly the expected number of times",
                    `If you intend to replace all occurrences, set expected_replacements to ${exactCount}`,
                    "Use read to confirm the exact text and counts",
                  ],
                ),
              );
            }

            throw new Error(
              formatError(
                `Occurrence count mismatch in ${file_path}: expected ${expectedCount}, found ${wsCount} (whitespace-tolerant) and ${tokenCount} (token-based)`,
                [
                  "Provide more surrounding context in old_string to make the match unique",
                  "If multiple replacements are intended, adjust expected_replacements",
                  "Use read to confirm the current file contents and refine the match",
                ],
              ),
            );
          }
        }
      }

      // Verify something actually changed
      if (resultContentLF === contentLF) {
        return {
          content: [{ type: "text", text: `No changes needed for ${file_path}` }],
          details: undefined,
        };
      }

      // Restore original line endings and write
      const finalContent = restoreLineEnding(resultContentLF, originalEol);
      await ops.writeFile(absolutePath, finalContent);

      // Build response with post-edit context
      const context = extractContext(resultContentLF, oldLF, newLF);
      const matchNote = matchStrategy !== "exact" ? ` (matched via ${matchStrategy} strategy)` : "";
      const replNote = expectedCount > 1 ? ` (${expectedCount} replacements)` : "";

      return {
        content: [
          {
            type: "text",
            text: `Successfully edited ${file_path}${matchNote}${replNote}\n\nPost-edit context:\n${context}`,
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

export function createSandboxedCodeEditTool(params: {
  root: string;
  bridge: SandboxFsBridge;
}): AgentTool<typeof codeEditSchema> {
  const { root, bridge } = params;

  const ops: CodeEditOperations = {
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
    mkdir: (dir) => bridge.mkdirp({ filePath: dir, cwd: root }),
  };

  const base = createCodeEditTool(root, { operations: ops });

  // Wrap with sandbox path guard
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
