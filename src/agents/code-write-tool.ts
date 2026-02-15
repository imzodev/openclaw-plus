import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { assertSandboxPath } from "./sandbox-paths.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const codeWriteSchema = Type.Object({
  file_path: Type.String({
    description:
      "Path to the file to write (relative or absolute). Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
  }),
  content: Type.String({
    description:
      "The COMPLETE file content to write. You MUST include ALL parts of the file — no truncation, no placeholders like '// rest of code unchanged'. Provide the full intended content.",
  }),
  language: Type.Optional(
    Type.String({
      description:
        "Programming language for syntax validation (e.g. 'javascript', 'typescript', 'python', 'json'). Auto-detected from file extension if omitted.",
    }),
  ),
});

export type CodeWriteInput = Static<typeof codeWriteSchema>;

// ---------------------------------------------------------------------------
// Language detection & syntax check commands
// ---------------------------------------------------------------------------

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py": "python",
  ".json": "json",
  ".jsonc": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".rb": "ruby",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
};

/**
 * Returns a shell command that checks syntax for the given language.
 * The command should exit 0 on valid syntax, non-zero on error, and print errors to stderr/stdout.
 * Returns undefined if no syntax check is available for the language.
 */
function getSyntaxCheckCommand(language: string, filePath: string): string | undefined {
  switch (language) {
    case "javascript":
      return `node --check ${JSON.stringify(filePath)} 2>&1`;
    case "typescript":
      // node --check works for basic syntax on .ts with recent Node
      return `node --check ${JSON.stringify(filePath)} 2>&1`;
    case "python":
      return `python3 -m py_compile ${JSON.stringify(filePath)} 2>&1`;
    case "json":
      return `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' ${JSON.stringify(filePath)} 2>&1`;
    case "ruby":
      return `ruby -c ${JSON.stringify(filePath)} 2>&1`;
    case "shell":
      return `bash -n ${JSON.stringify(filePath)} 2>&1`;
    default:
      return undefined;
  }
}

function detectLanguage(filePath: string, explicitLanguage?: string): string | undefined {
  if (explicitLanguage?.trim()) {
    return explicitLanguage.trim().toLowerCase();
  }
  const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (ext) {
    return EXTENSION_TO_LANGUAGE[ext];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// File operations interface
// ---------------------------------------------------------------------------

export interface CodeWriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

export interface CodeWriteSyntaxChecker {
  /** Run a shell command and return { exitCode, output } */
  exec: (command: string, cwd: string) => Promise<{ exitCode: number; output: string }>;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { writeFile as fsWriteFile, mkdir as fsMkdir } from "node:fs/promises";
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

const defaultCodeWriteOperations: CodeWriteOperations = {
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

const defaultSyntaxChecker: CodeWriteSyntaxChecker = {
  exec: async (command, cwd) => {
    try {
      const output = execSync(command, {
        cwd,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { exitCode: 0, output: output ?? "" };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      const output = [e.stdout ?? "", e.stderr ?? ""].filter(Boolean).join("\n").trim();
      return { exitCode: e.status ?? 1, output };
    }
  },
};

export interface CodeWriteToolOptions {
  operations?: CodeWriteOperations;
  syntaxChecker?: CodeWriteSyntaxChecker;
  /** Disable syntax checking entirely (e.g. in sandbox where exec is not available) */
  disableSyntaxCheck?: boolean;
}

export function createCodeWriteTool(
  cwd: string,
  options?: CodeWriteToolOptions,
): AgentTool<typeof codeWriteSchema> {
  const ops = options?.operations ?? defaultCodeWriteOperations;
  const checker = options?.syntaxChecker ?? defaultSyntaxChecker;
  const disableSyntaxCheck = options?.disableSyntaxCheck ?? false;

  return {
    name: "code_write",
    label: "code_write",
    description:
      "Write a complete code file. Creates the file if it doesn't exist, overwrites if it does. " +
      "Automatically creates parent directories. " +
      "Runs a syntax check after writing and reports any errors so you can fix them immediately. " +
      "IMPORTANT: Always provide the COMPLETE file content — no truncation, no placeholders. " +
      "Prefer code_edit for small changes to existing files (code_write rewrites the entire file).",
    parameters: codeWriteSchema,
    execute: async (_toolCallId, args, signal): Promise<AgentToolResult<unknown>> => {
      const { file_path, content, language: explicitLanguage } = args;

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      if (!file_path || !file_path.trim()) {
        throw new Error("Missing required parameter: file_path");
      }

      const absolutePath = resolveToCwd(file_path, cwd);
      const dir = dirname(absolutePath);

      // Write the file
      await ops.mkdir(dir);

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      await ops.writeFile(absolutePath, content);

      const lines = content.split("\n");
      const lineCount = lines.length;

      // Build line-numbered preview (first 30 lines)
      const previewLines = Math.min(30, lineCount);
      const preview = lines
        .slice(0, previewLines)
        .map((l, i) => `${i + 1}\t${l}`)
        .join("\n");
      const truncNote =
        lineCount > previewLines ? `\n... (${lineCount - previewLines} more lines)` : "";

      // Syntax check
      let syntaxResult = "";
      if (!disableSyntaxCheck) {
        const lang = detectLanguage(file_path, explicitLanguage);
        if (lang) {
          const cmd = getSyntaxCheckCommand(lang, absolutePath);
          if (cmd) {
            try {
              const result = await checker.exec(cmd, cwd);
              if (result.exitCode !== 0) {
                const errorOutput = result.output.trim().slice(0, 2000);
                syntaxResult = `\n\n⚠️ Syntax check FAILED (${lang}):\n${errorOutput}\n\nFix the syntax errors and try again.`;
              } else {
                syntaxResult = `\n\n✓ Syntax check passed (${lang})`;
              }
            } catch {
              // Syntax checker not available — skip silently
            }
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Wrote ${lineCount} lines to ${file_path}${syntaxResult}\n\n${preview}${truncNote}`,
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

export function createSandboxedCodeWriteTool(params: {
  root: string;
  bridge: SandboxFsBridge;
}): AgentTool<typeof codeWriteSchema> {
  const { root, bridge } = params;

  const ops: CodeWriteOperations = {
    writeFile: (filePath, content) => bridge.writeFile({ filePath, cwd: root, data: content }),
    mkdir: (dir) => bridge.mkdirp({ filePath: dir, cwd: root }),
  };

  // In sandbox mode, disable syntax check (would need docker exec, which is complex)
  const base = createCodeWriteTool(root, { operations: ops, disableSyntaxCheck: true });

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
