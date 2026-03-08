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

const codeOutlineSchema = Type.Object({
  file_path: Type.String({
    description: "Path to the source file to outline (relative or absolute).",
  }),
  max_depth: Type.Optional(
    Type.Number({
      description:
        "Maximum nesting depth to show. 1 = top-level only, 2 = top-level + one level of nesting. Default: 3.",
    }),
  ),
});

export type CodeOutlineInput = Static<typeof codeOutlineSchema>;

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
// Language-specific symbol patterns
// ---------------------------------------------------------------------------

interface SymbolPattern {
  regex: RegExp;
  kind: string;
  nameGroup: number;
}

function getPatternsForExtension(ext: string): SymbolPattern[] {
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".mts":
    case ".cts":
      return [
        // export function / async function
        {
          regex: /^(\s*)(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
          kind: "function",
          nameGroup: 2,
        },
        // export const/let/var name = ...
        {
          regex: /^(\s*)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/gm,
          kind: "const",
          nameGroup: 2,
        },
        // export class
        {
          regex: /^(\s*)(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm,
          kind: "class",
          nameGroup: 2,
        },
        // export interface
        { regex: /^(\s*)(?:export\s+)?interface\s+(\w+)/gm, kind: "interface", nameGroup: 2 },
        // export type
        { regex: /^(\s*)(?:export\s+)?type\s+(\w+)\s*=/gm, kind: "type", nameGroup: 2 },
        // export enum
        { regex: /^(\s*)(?:export\s+)?(?:const\s+)?enum\s+(\w+)/gm, kind: "enum", nameGroup: 2 },
        // method definitions inside classes: name(...) { or async name(...)
        {
          regex: /^(\s+)(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\S+\s*)?[{]/gm,
          kind: "method",
          nameGroup: 2,
        },
        // arrow function assigned: name = (...) =>
        {
          regex: /^(\s+)(?:readonly\s+)?(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/gm,
          kind: "method",
          nameGroup: 2,
        },
      ];

    case ".py":
      return [
        { regex: /^(\s*)class\s+(\w+)/gm, kind: "class", nameGroup: 2 },
        { regex: /^(\s*)(?:async\s+)?def\s+(\w+)/gm, kind: "function", nameGroup: 2 },
        { regex: /^(\s*)(\w+)\s*:\s*\w+\s*=/gm, kind: "variable", nameGroup: 2 },
      ];

    case ".go":
      return [
        { regex: /^(\s*)func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm, kind: "function", nameGroup: 2 },
        { regex: /^(\s*)type\s+(\w+)\s+struct/gm, kind: "struct", nameGroup: 2 },
        { regex: /^(\s*)type\s+(\w+)\s+interface/gm, kind: "interface", nameGroup: 2 },
      ];

    case ".rs":
      return [
        { regex: /^(\s*)(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm, kind: "function", nameGroup: 2 },
        { regex: /^(\s*)(?:pub\s+)?struct\s+(\w+)/gm, kind: "struct", nameGroup: 2 },
        { regex: /^(\s*)(?:pub\s+)?enum\s+(\w+)/gm, kind: "enum", nameGroup: 2 },
        { regex: /^(\s*)(?:pub\s+)?trait\s+(\w+)/gm, kind: "trait", nameGroup: 2 },
        { regex: /^(\s*)impl(?:<[^>]*>)?\s+(\w+)/gm, kind: "impl", nameGroup: 2 },
      ];

    case ".java":
    case ".kt":
    case ".kts":
      return [
        {
          regex:
            /^(\s*)(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?class\s+(\w+)/gm,
          kind: "class",
          nameGroup: 2,
        },
        {
          regex: /^(\s*)(?:public|private|protected)?\s*(?:static\s+)?interface\s+(\w+)/gm,
          kind: "interface",
          nameGroup: 2,
        },
        {
          regex:
            /^(\s*)(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?(?:suspend\s+)?(?:fun\s+)?(?:\w+\s+)?(\w+)\s*\(/gm,
          kind: "method",
          nameGroup: 2,
        },
      ];

    case ".rb":
      return [
        { regex: /^(\s*)class\s+(\w+)/gm, kind: "class", nameGroup: 2 },
        { regex: /^(\s*)module\s+(\w+)/gm, kind: "module", nameGroup: 2 },
        { regex: /^(\s*)def\s+(\w+)/gm, kind: "method", nameGroup: 2 },
      ];

    case ".swift":
      return [
        {
          regex: /^(\s*)(?:public\s+|private\s+|internal\s+|open\s+)?class\s+(\w+)/gm,
          kind: "class",
          nameGroup: 2,
        },
        {
          regex: /^(\s*)(?:public\s+|private\s+|internal\s+|open\s+)?struct\s+(\w+)/gm,
          kind: "struct",
          nameGroup: 2,
        },
        {
          regex: /^(\s*)(?:public\s+|private\s+|internal\s+|open\s+)?protocol\s+(\w+)/gm,
          kind: "protocol",
          nameGroup: 2,
        },
        {
          regex: /^(\s*)(?:public\s+|private\s+|internal\s+|open\s+)?enum\s+(\w+)/gm,
          kind: "enum",
          nameGroup: 2,
        },
        {
          regex:
            /^(\s*)(?:public\s+|private\s+|internal\s+|open\s+)?(?:static\s+)?(?:override\s+)?func\s+(\w+)/gm,
          kind: "function",
          nameGroup: 2,
        },
      ];

    case ".c":
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".h":
    case ".hpp":
      return [
        { regex: /^(\s*)(?:class|struct)\s+(\w+)/gm, kind: "class", nameGroup: 2 },
        {
          regex:
            /^(\s*)(?:virtual\s+)?(?:static\s+)?(?:inline\s+)?(?:const\s+)?(?:\w+[\s*&]+)+(\w+)\s*\(/gm,
          kind: "function",
          nameGroup: 2,
        },
        { regex: /^(\s*)namespace\s+(\w+)/gm, kind: "namespace", nameGroup: 2 },
      ];

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

interface OutlineSymbol {
  line: number;
  indent: number;
  kind: string;
  name: string;
}

function extractSymbols(content: string, ext: string): OutlineSymbol[] {
  const patterns = getPatternsForExtension(ext);
  if (patterns.length === 0) {
    return [];
  }

  const symbols: OutlineSymbol[] = [];
  const seenPositions = new Set<string>();

  for (const pattern of patterns) {
    // Reset regex state
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.regex.exec(content)) !== null) {
      const name = match[pattern.nameGroup];
      if (!name) {
        continue;
      }

      // Skip common noise
      if (
        [
          "if",
          "else",
          "for",
          "while",
          "switch",
          "case",
          "return",
          "throw",
          "new",
          "try",
          "catch",
          "finally",
          "import",
          "from",
          "require",
          "constructor",
        ].includes(name)
      ) {
        continue;
      }

      // Calculate line number
      const lineNum = content.substring(0, match.index).split("\n").length;
      const indent = (match[1] ?? "").length;
      const key = `${lineNum}:${name}`;

      if (!seenPositions.has(key)) {
        seenPositions.add(key);
        symbols.push({ line: lineNum, indent, kind: pattern.kind, name });
      }
    }
  }

  // Sort by line number
  symbols.sort((a, b) => a.line - b.line);
  return symbols;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatOutline(symbols: OutlineSymbol[], maxDepth: number): string {
  if (symbols.length === 0) {
    return "(no symbols found)";
  }

  // Determine base indent level
  const minIndent = Math.min(...symbols.map((s) => s.indent));

  const lines: string[] = [];
  for (const sym of symbols) {
    const depth = Math.floor((sym.indent - minIndent) / 2) + 1;
    if (depth > maxDepth) {
      continue;
    }
    const prefix = "  ".repeat(Math.max(0, depth - 1));
    lines.push(`${sym.line}\t${prefix}${sym.kind} ${sym.name}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// File operations interface
// ---------------------------------------------------------------------------

export interface CodeOutlineOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
}

const defaultOps: CodeOutlineOperations = {
  readFile: (path) => fsReadFile(path),
};

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface CodeOutlineToolOptions {
  operations?: CodeOutlineOperations;
}

export function createCodeOutlineTool(
  cwd: string,
  options?: CodeOutlineToolOptions,
): AgentTool<typeof codeOutlineSchema> {
  const ops = options?.operations ?? defaultOps;

  return {
    name: "code_outline",
    label: "code_outline",
    description:
      "Extract a structural outline of a source file: functions, classes, methods, interfaces, types, and other symbols with line numbers. " +
      "Use this to understand file structure before editing, or to find the right location for changes. " +
      "Much faster than reading the entire file when you only need to know what's defined where.",
    parameters: codeOutlineSchema,
    execute: async (_toolCallId, args, signal): Promise<AgentToolResult<unknown>> => {
      const { file_path, max_depth } = args;

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

      const symbols = extractSymbols(content, ext);
      const depth = Math.max(1, Math.min(max_depth ?? 3, 10));
      const outline = formatOutline(symbols, depth);

      const header = `${file_path} (${totalLines} lines, ${symbols.length} symbols)`;

      return {
        content: [
          {
            type: "text",
            text: `${header}\n\n${outline}`,
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

export function createSandboxedCodeOutlineTool(params: {
  root: string;
  bridge: SandboxFsBridge;
}): AgentTool<typeof codeOutlineSchema> {
  const { root, bridge } = params;

  const ops: CodeOutlineOperations = {
    readFile: (filePath) => bridge.readFile({ filePath, cwd: root }),
  };

  const base = createCodeOutlineTool(root, { operations: ops });

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
