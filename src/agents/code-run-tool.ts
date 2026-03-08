import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import os from "node:os";
import { resolve, isAbsolute } from "node:path";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const codeRunSchema = Type.Object({
  command: Type.String({
    description:
      'The command to run, e.g. "pnpm test", "npm run build", "python -m pytest tests/", "cargo test".',
  }),
  working_directory: Type.Optional(
    Type.String({
      description: "Working directory for the command. Defaults to the workspace root.",
    }),
  ),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: "Maximum time in seconds before killing the command. Default: 120.",
    }),
  ),
  parse_errors: Type.Optional(
    Type.Boolean({
      description:
        "If true, extract and highlight error/failure lines from the output for quick scanning. Default: true.",
    }),
  ),
});

export type CodeRunInput = Static<typeof codeRunSchema>;

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
// Error extraction patterns
// ---------------------------------------------------------------------------

const ERROR_PATTERNS = [
  // TypeScript / JavaScript
  /error TS\d+:/i,
  /SyntaxError:/,
  /TypeError:/,
  /ReferenceError:/,
  /RangeError:/,
  /Error:/,
  // Test frameworks
  /FAIL\s/,
  /✗|✘|×/,
  /AssertionError/i,
  /Expected.*but.*received/i,
  /expect\(.*\)\./,
  // Python
  /Traceback \(most recent call last\)/,
  /^\s*File ".*", line \d+/,
  /^\w+Error:/,
  // Rust
  /^error\[E\d+\]:/,
  /^error:/,
  // Go
  /^--- FAIL:/,
  /FAIL\s+\S+/,
  // General
  /^\s*\^+\s*$/,
  /failed/i,
];

const WARNING_PATTERNS = [/warning:/i, /warn:/i, /⚠/, /deprecated/i];

interface ParsedOutput {
  exitCode: number;
  stdout: string;
  errors: string[];
  warnings: string[];
  summary: string;
}

function parseCommandOutput(stdout: string, exitCode: number, shouldParse: boolean): ParsedOutput {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (shouldParse) {
    const lines = stdout.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (ERROR_PATTERNS.some((p) => p.test(line))) {
        // Include the error line and up to 2 lines of context after
        const contextEnd = Math.min(lines.length, i + 3);
        const errorBlock = lines.slice(i, contextEnd).join("\n");
        errors.push(errorBlock);
        i = contextEnd - 1; // skip context lines
      } else if (WARNING_PATTERNS.some((p) => p.test(line))) {
        warnings.push(line);
      }
    }
  }

  // Deduplicate
  const uniqueErrors = [...new Set(errors)];
  const uniqueWarnings = [...new Set(warnings)];

  let summary: string;
  if (exitCode === 0) {
    summary =
      uniqueWarnings.length > 0
        ? `✓ Command succeeded with ${uniqueWarnings.length} warning(s)`
        : "✓ Command succeeded";
  } else {
    summary =
      uniqueErrors.length > 0
        ? `✗ Command failed (exit ${exitCode}) with ${uniqueErrors.length} error(s)`
        : `✗ Command failed (exit ${exitCode})`;
  }

  return {
    exitCode,
    stdout,
    errors: uniqueErrors.slice(0, 30), // cap at 30 errors
    warnings: uniqueWarnings.slice(0, 10),
    summary,
  };
}

// ---------------------------------------------------------------------------
// Output truncation
// ---------------------------------------------------------------------------

const MAX_OUTPUT_CHARS = 48_000;

function truncateOutput(output: string): { text: string; truncated: boolean } {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return { text: output, truncated: false };
  }

  // Keep the last portion (errors are usually at the end)
  const headSize = Math.floor(MAX_OUTPUT_CHARS * 0.2);
  const tailSize = MAX_OUTPUT_CHARS - headSize - 100;

  const head = output.substring(0, headSize);
  const tail = output.substring(output.length - tailSize);
  const omitted = output.length - headSize - tailSize;

  return {
    text: `${head}\n\n... (${omitted} characters omitted) ...\n\n${tail}`,
    truncated: true,
  };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createCodeRunTool(cwd: string): AgentTool<typeof codeRunSchema> {
  return {
    name: "code_run",
    label: "code_run",
    description:
      "Run a build, test, lint, or type-check command and get structured output with extracted errors and warnings. " +
      "Use this after editing code to verify changes, run tests, or check for type errors. " +
      "Output is parsed to highlight errors for quick scanning. " +
      "For long-running dev servers, use exec/process instead.",
    parameters: codeRunSchema,
    execute: async (_toolCallId, args, signal): Promise<AgentToolResult<unknown>> => {
      const {
        command,
        working_directory: workDir,
        timeout_seconds: timeoutSec,
        parse_errors: parseErrors,
      } = args;

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      if (!command || !command.trim()) {
        throw new Error("Missing required parameter: command");
      }

      const execCwd = workDir ? resolveToCwd(workDir, cwd) : cwd;
      const timeout = Math.max(5, Math.min(timeoutSec ?? 120, 600)) * 1000;
      const shouldParse = parseErrors !== false;

      let stdout = "";
      let exitCode = 0;

      try {
        stdout = execSync(command, {
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
          timeout,
          cwd: execCwd,
          env: {
            ...process.env,
            FORCE_COLOR: "0",
            NO_COLOR: "1",
            CI: "true",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        if (err && typeof err === "object") {
          const execErr = err as {
            stdout?: string;
            stderr?: string;
            status?: number;
            signal?: string;
          };
          stdout = (execErr.stdout ?? "") + (execErr.stderr ?? "");
          exitCode = execErr.status ?? 1;

          if (execErr.signal === "SIGTERM") {
            stdout += `\n\n(Command timed out after ${Math.round(timeout / 1000)}s)`;
            exitCode = 124;
          }
        }
      }

      const parsed = parseCommandOutput(stdout, exitCode, shouldParse);
      const { text: outputText, truncated } = truncateOutput(stdout);

      const parts: string[] = [];
      parts.push(parsed.summary);

      // Extracted errors
      if (shouldParse && parsed.errors.length > 0) {
        parts.push("");
        parts.push(`### Errors (${parsed.errors.length})`);
        for (const err of parsed.errors) {
          parts.push(err);
          parts.push("");
        }
      }

      // Extracted warnings
      if (shouldParse && parsed.warnings.length > 0) {
        parts.push("");
        parts.push(`### Warnings (${parsed.warnings.length})`);
        for (const warn of parsed.warnings) {
          parts.push(`  ${warn}`);
        }
      }

      // Full output
      parts.push("");
      parts.push(`### Full output${truncated ? " (truncated)" : ""}`);
      parts.push("```");
      parts.push(outputText);
      parts.push("```");

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
