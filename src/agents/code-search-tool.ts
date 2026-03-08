import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import os from "node:os";
import { resolve, isAbsolute, relative } from "node:path";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const codeSearchSchema = Type.Object({
  query: Type.String({
    description:
      "Search pattern. Treated as a regex by default. Set fixed_strings=true for literal matching.",
  }),
  path: Type.Optional(
    Type.String({
      description:
        "Optional directory or file to search within (relative to workspace). Defaults to the workspace root.",
    }),
  ),
  include: Type.Optional(
    Type.String({
      description:
        'Glob pattern to filter files, e.g. "*.ts", "*.py", "src/**/*.js". Multiple globs separated by commas.',
    }),
  ),
  exclude: Type.Optional(
    Type.String({
      description:
        'Glob pattern to exclude files, e.g. "node_modules/**,dist/**". Multiple globs separated by commas.',
    }),
  ),
  fixed_strings: Type.Optional(
    Type.Boolean({
      description: "If true, treat query as a literal string instead of regex. Default: false.",
    }),
  ),
  case_sensitive: Type.Optional(
    Type.Boolean({
      description: "If true, search is case-sensitive. Default: false (smart case).",
    }),
  ),
  context_lines: Type.Optional(
    Type.Number({
      description: "Number of context lines around each match. Default: 2.",
    }),
  ),
  max_results: Type.Optional(
    Type.Number({
      description: "Maximum number of matching files to return. Default: 20.",
    }),
  ),
});

export type CodeSearchInput = Static<typeof codeSearchSchema>;

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
// Tool factory
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BYTES = 64_000;

export function createCodeSearchTool(cwd: string): AgentTool<typeof codeSearchSchema> {
  return {
    name: "code_search",
    label: "code_search",
    description:
      "Search code across the workspace using ripgrep. Returns matching lines with file paths, line numbers, and context. " +
      "Supports regex, literal strings, glob filters, and smart case. " +
      "Use this to find function definitions, usages, imports, or any code pattern before editing.",
    parameters: codeSearchSchema,
    execute: async (_toolCallId, args, signal): Promise<AgentToolResult<unknown>> => {
      const {
        query,
        path: searchPath,
        include,
        exclude,
        fixed_strings: fixedStrings,
        case_sensitive: caseSensitive,
        context_lines: contextLines,
        max_results: maxResults,
      } = args;

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      if (!query || !query.trim()) {
        throw new Error("Missing required parameter: query");
      }

      const targetDir = searchPath ? resolveToCwd(searchPath, cwd) : cwd;

      // Build ripgrep command
      const rgArgs: string[] = [
        "--color=never",
        "--line-number",
        "--no-heading",
        "--with-filename",
      ];

      // Context lines
      const ctx = Math.max(0, Math.min(contextLines ?? 2, 10));
      if (ctx > 0) {
        rgArgs.push(`-C${ctx}`);
      }

      // Max results (limit by file count using max-count per file, then cap total output)
      const limit = Math.max(1, Math.min(maxResults ?? 20, 100));
      rgArgs.push(`--max-count=50`); // max matches per file

      // Fixed strings
      if (fixedStrings) {
        rgArgs.push("--fixed-strings");
      }

      // Case sensitivity
      if (caseSensitive) {
        rgArgs.push("--case-sensitive");
      } else {
        rgArgs.push("--smart-case");
      }

      // Include globs
      if (include?.trim()) {
        for (const glob of include
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean)) {
          rgArgs.push(`--glob=${glob}`);
        }
      }

      // Exclude globs
      if (exclude?.trim()) {
        for (const glob of exclude
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean)) {
          rgArgs.push(`--glob=!${glob}`);
        }
      }

      // Always exclude common noise directories
      rgArgs.push("--glob=!node_modules/**");
      rgArgs.push("--glob=!.git/**");
      rgArgs.push("--glob=!dist/**");
      rgArgs.push("--glob=!build/**");
      rgArgs.push("--glob=!coverage/**");
      rgArgs.push("--glob=!*.min.js");
      rgArgs.push("--glob=!*.min.css");
      rgArgs.push("--glob=!package-lock.json");
      rgArgs.push("--glob=!pnpm-lock.yaml");
      rgArgs.push("--glob=!yarn.lock");

      // Query and target
      const escapedQuery = JSON.stringify(query);
      const escapedTarget = JSON.stringify(targetDir);
      const cmd = `rg ${rgArgs.join(" ")} ${escapedQuery} ${escapedTarget} 2>&1 || true`;

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      let output: string;
      try {
        output = execSync(cmd, {
          encoding: "utf-8",
          maxBuffer: MAX_OUTPUT_BYTES * 2,
          timeout: 30_000,
          cwd,
        });
      } catch (err) {
        // ripgrep exits with 1 when no matches found
        if (err && typeof err === "object" && "stdout" in err) {
          output = (err as { stdout: string }).stdout ?? "";
        } else {
          output = "";
        }
      }

      if (!output.trim()) {
        return {
          content: [
            {
              type: "text",
              text: `No matches found for ${fixedStrings ? "literal" : "pattern"}: ${query}${searchPath ? ` in ${searchPath}` : ""}`,
            },
          ],
          details: undefined,
        };
      }

      // Make paths relative to workspace
      const lines = output.split("\n");
      const relativized = lines.map((line) => {
        // ripgrep output: /absolute/path/file.ts:42:matched line
        // or with context: /absolute/path/file.ts-40-context line
        const match = line.match(/^(.+?)([:|-])(\d+)([:|-])(.*)$/);
        if (match) {
          const absPath = match[1];
          const sep1 = match[2];
          const lineNum = match[3];
          const sep2 = match[4];
          const content = match[5];
          try {
            const relPath = relative(cwd, absPath);
            return `${relPath}${sep1}${lineNum}${sep2}${content}`;
          } catch {
            return line;
          }
        }
        // Group separator
        if (line === "--") {
          return line;
        }
        return line;
      });

      // Count unique files
      const fileSet = new Set<string>();
      for (const line of relativized) {
        const match = line.match(/^(.+?)[:|-]\d+[:|-]/);
        if (match) {
          fileSet.add(match[1]);
        }
      }

      // Truncate if too many files
      let resultLines = relativized;
      let truncated = false;
      if (fileSet.size > limit) {
        // Keep only lines from the first N files
        const allowedFiles = new Set(Array.from(fileSet).slice(0, limit));
        resultLines = relativized.filter((line) => {
          const match = line.match(/^(.+?)[:|-]\d+[:|-]/);
          if (match) {
            return allowedFiles.has(match[1]);
          }
          return line === "--";
        });
        truncated = true;
      }

      // Truncate output if too large
      let resultText = resultLines.join("\n");
      if (resultText.length > MAX_OUTPUT_BYTES) {
        resultText = resultText.substring(0, MAX_OUTPUT_BYTES);
        const lastNewline = resultText.lastIndexOf("\n");
        if (lastNewline > 0) {
          resultText = resultText.substring(0, lastNewline);
        }
        truncated = true;
      }

      const header = `Found matches in ${fileSet.size} file(s)${truncated ? ` (showing first ${limit})` : ""}:`;

      return {
        content: [
          {
            type: "text",
            text: `${header}\n\n${resultText}`,
          },
        ],
        details: undefined,
      };
    },
  };
}
