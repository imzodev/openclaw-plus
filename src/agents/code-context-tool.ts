import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import { readFile as fsReadFile } from "node:fs/promises";
import os from "node:os";
import { resolve, isAbsolute, relative, extname } from "node:path";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { assertSandboxPath } from "./sandbox-paths.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const codeContextSchema = Type.Object({
  file_path: Type.String({
    description: "Path to the source file to gather context for.",
  }),
  line: Type.Optional(
    Type.Number({
      description:
        "Line number to focus on. Context will be gathered around this line. If omitted, gathers file-level context (imports, exports).",
    }),
  ),
  symbol: Type.Optional(
    Type.String({
      description:
        "Symbol name to find references/usages for across the workspace. Combined with file_path for disambiguation.",
    }),
  ),
  include_imports: Type.Optional(
    Type.Boolean({
      description: "Include resolved import sources and their exports. Default: true.",
    }),
  ),
  include_references: Type.Optional(
    Type.Boolean({
      description:
        "Search for references to the symbol across the workspace. Default: true when symbol is provided.",
    }),
  ),
});

export type CodeContextInput = Static<typeof codeContextSchema>;

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
// Import extraction
// ---------------------------------------------------------------------------

interface ImportInfo {
  source: string;
  names: string[];
  line: number;
  isDefault: boolean;
  isNamespace: boolean;
}

function extractImports(content: string, ext: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) {
    // ES imports: import { a, b } from "source"
    const esImportRe =
      /^import\s+(?:(?:(\w+)(?:\s*,\s*)?)?(?:\{([^}]*)\})?(?:\*\s+as\s+(\w+))?)\s+from\s+["']([^"']+)["']/gm;
    let match: RegExpExecArray | null;
    while ((match = esImportRe.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split("\n").length;
      const defaultName = match[1];
      const namedImports = match[2];
      const namespaceName = match[3];
      const source = match[4];

      const names: string[] = [];
      if (defaultName) {
        names.push(defaultName);
      }
      if (namedImports) {
        for (const n of namedImports.split(",")) {
          const cleaned = n
            .trim()
            .split(/\s+as\s+/)
            .pop()
            ?.trim();
          if (cleaned) {
            names.push(cleaned);
          }
        }
      }
      if (namespaceName) {
        names.push(namespaceName);
      }

      imports.push({
        source,
        names,
        line: lineNum,
        isDefault: !!defaultName && !namedImports,
        isNamespace: !!namespaceName,
      });
    }

    // require() calls
    const requireRe =
      /(?:const|let|var)\s+(?:(\w+)|{([^}]*)})?\s*=\s*require\(["']([^"']+)["']\)/gm;
    while ((match = requireRe.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split("\n").length;
      const singleName = match[1];
      const destructured = match[2];
      const source = match[3];

      const names: string[] = [];
      if (singleName) {
        names.push(singleName);
      }
      if (destructured) {
        for (const n of destructured.split(",")) {
          const cleaned = n
            .trim()
            .split(/\s*:\s*/)
            .pop()
            ?.trim();
          if (cleaned) {
            names.push(cleaned);
          }
        }
      }

      imports.push({
        source,
        names,
        line: lineNum,
        isDefault: !!singleName,
        isNamespace: false,
      });
    }
  } else if (ext === ".py") {
    // Python imports
    const pyImportRe = /^(?:from\s+(\S+)\s+)?import\s+(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = pyImportRe.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split("\n").length;
      const source =
        match[1] ??
        match[2]
          .trim()
          .split(",")[0]
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
      const namesPart = match[2];

      const names: string[] = [];
      for (const n of namesPart.split(",")) {
        const cleaned = n
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (cleaned) {
          names.push(cleaned);
        }
      }

      imports.push({
        source,
        names,
        line: lineNum,
        isDefault: false,
        isNamespace: false,
      });
    }
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Focused code block extraction
// ---------------------------------------------------------------------------

function extractFocusedBlock(
  content: string,
  targetLine: number,
  contextBefore: number = 5,
  contextAfter: number = 30,
): string {
  const lines = content.split("\n");
  const start = Math.max(0, targetLine - 1 - contextBefore);
  const end = Math.min(lines.length, targetLine - 1 + contextAfter);

  // Try to extend to the end of the current block (matching braces/indentation)
  const targetIndent = (lines[targetLine - 1] ?? "").match(/^(\s*)/)?.[1]?.length ?? 0;
  let blockEnd = end;
  for (let i = targetLine; i < Math.min(lines.length, targetLine + 100); i++) {
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    const lineIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    // If we find a line at the same or lesser indent (and it's not blank), that's the block boundary
    if (i > targetLine && lineIndent <= targetIndent && line.trim().length > 0) {
      blockEnd = i + 1;
      break;
    }
  }

  const finalEnd = Math.min(lines.length, Math.max(end, blockEnd));
  return lines
    .slice(start, finalEnd)
    .map((l, i) => `${start + i + 1}\t${l}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Reference search (uses ripgrep)
// ---------------------------------------------------------------------------

function findReferences(
  symbol: string,
  cwd: string,
  excludeFile?: string,
  maxResults: number = 10,
): string[] {
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rgArgs = [
    "--color=never",
    "--line-number",
    "--no-heading",
    "--with-filename",
    "-w", // whole word
    "--smart-case",
    "--max-count=5",
    "--glob=!node_modules/**",
    "--glob=!.git/**",
    "--glob=!dist/**",
    "--glob=!build/**",
    "--glob=!coverage/**",
    "--glob=!*.min.js",
    "--glob=!*.min.css",
    "--glob=!package-lock.json",
    "--glob=!pnpm-lock.yaml",
  ];

  const cmd = `rg ${rgArgs.join(" ")} ${JSON.stringify(escapedSymbol)} ${JSON.stringify(cwd)} 2>/dev/null || true`;

  let output: string;
  try {
    output = execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 64_000,
      timeout: 15_000,
      cwd,
    });
  } catch {
    return [];
  }

  if (!output.trim()) {
    return [];
  }

  const lines = output.trim().split("\n");
  const results: string[] = [];

  for (const line of lines) {
    if (results.length >= maxResults) {
      break;
    }
    // Make path relative
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (match) {
      const absPath = match[1];
      const lineNum = match[2];
      const content = match[3];
      try {
        const relPath = relative(cwd, absPath);
        // Skip the source file itself
        if (excludeFile && relPath === excludeFile) {
          continue;
        }
        results.push(`${relPath}:${lineNum}: ${content.trim()}`);
      } catch {
        results.push(line);
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// File operations interface
// ---------------------------------------------------------------------------

export interface CodeContextOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
}

const defaultOps: CodeContextOperations = {
  readFile: (path) => fsReadFile(path),
};

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface CodeContextToolOptions {
  operations?: CodeContextOperations;
}

export function createCodeContextTool(
  cwd: string,
  options?: CodeContextToolOptions,
): AgentTool<typeof codeContextSchema> {
  const ops = options?.operations ?? defaultOps;

  return {
    name: "code_context",
    label: "code_context",
    description:
      "Gather rich context around a code location: imports and their sources, the focused code block with surrounding context, " +
      "and references to a symbol across the workspace. " +
      "Use this before editing to understand dependencies, callers, and the full picture around a change site.",
    parameters: codeContextSchema,
    execute: async (_toolCallId, args, signal): Promise<AgentToolResult<unknown>> => {
      const {
        file_path,
        line: targetLine,
        symbol,
        include_imports: includeImports,
        include_references: includeReferences,
      } = args;

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      if (!file_path || !file_path.trim()) {
        throw new Error("Missing required parameter: file_path");
      }

      const absolutePath = resolveToCwd(file_path, cwd);
      const ext = extname(absolutePath).toLowerCase();

      const buffer = await ops.readFile(absolutePath);
      const content = buffer.toString("utf-8");
      const totalLines = content.split("\n").length;

      const parts: string[] = [];
      parts.push(`## Context for ${file_path} (${totalLines} lines)`);

      // 1. Imports section
      const shouldIncludeImports = includeImports !== false;
      if (shouldIncludeImports) {
        const imports = extractImports(content, ext);
        if (imports.length > 0) {
          parts.push("");
          parts.push("### Imports");
          for (const imp of imports) {
            const names = imp.names.length > 0 ? imp.names.join(", ") : "(side-effect)";
            parts.push(`  L${imp.line}: ${names} from "${imp.source}"`);
          }
        }
      }

      // 2. Focused block around target line
      if (targetLine && targetLine > 0) {
        parts.push("");
        parts.push(`### Code around line ${targetLine}`);
        const block = extractFocusedBlock(content, targetLine);
        parts.push(block);
      }

      // 3. Symbol references
      const symbolTrimmed = symbol?.trim();
      const shouldSearchRefs = includeReferences !== false && !!symbolTrimmed;
      if (shouldSearchRefs && symbolTrimmed) {
        const relPath = relative(cwd, absolutePath);
        const refs = findReferences(symbolTrimmed, cwd, relPath);
        parts.push("");
        parts.push(`### References to "${symbolTrimmed}" across workspace`);
        if (refs.length > 0) {
          for (const ref of refs) {
            parts.push(`  ${ref}`);
          }
        } else {
          parts.push("  (no references found)");
        }
      }

      // 4. If no specific line or symbol, show file-level summary
      if (!targetLine && !symbol?.trim()) {
        // Show first 5 and last 5 lines as a quick overview
        const lines = content.split("\n");
        parts.push("");
        parts.push("### File head (first 15 lines)");
        const head = lines
          .slice(0, Math.min(15, lines.length))
          .map((l, i) => `${i + 1}\t${l}`)
          .join("\n");
        parts.push(head);

        if (lines.length > 30) {
          parts.push("");
          parts.push("### File tail (last 10 lines)");
          const tailStart = lines.length - 10;
          const tail = lines
            .slice(tailStart)
            .map((l, i) => `${tailStart + i + 1}\t${l}`)
            .join("\n");
          parts.push(tail);
        }
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

export function createSandboxedCodeContextTool(params: {
  root: string;
  bridge: SandboxFsBridge;
}): AgentTool<typeof codeContextSchema> {
  const { root, bridge } = params;

  const ops: CodeContextOperations = {
    readFile: (filePath) => bridge.readFile({ filePath, cwd: root }),
  };

  const base = createCodeContextTool(root, { operations: ops });

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
