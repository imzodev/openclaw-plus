import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCodeContextTool } from "./code-context-tool.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-context-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function tool() {
  return createCodeContextTool(tmpDir);
}

async function writeFile(name: string, content: string) {
  const p = path.join(tmpDir, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf-8");
  return p;
}

describe("code_context", () => {
  it("extracts imports from a TypeScript file", async () => {
    await writeFile(
      "imports.ts",
      [
        'import { foo } from "./foo.js";',
        'import bar from "bar";',
        'import * as ns from "ns";',
        "",
        "export function main() {",
        "  foo();",
        "  bar();",
        "}",
        "",
      ].join("\n"),
    );
    const result = await tool().execute("t1", { file_path: "imports.ts" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Imports");
    expect(text).toContain("foo");
    expect(text).toContain("./foo.js");
    expect(text).toContain("bar");
    expect(text).toContain("ns");
  });

  it("shows focused block around a target line", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile("block.ts", lines);
    const result = await tool().execute("t2", {
      file_path: "block.ts",
      line: 15,
      include_imports: false,
      include_references: false,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Code around line 15");
    expect(text).toContain("line 15");
  });

  it("shows file head/tail when no line or symbol given", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `content ${i + 1}`).join("\n") + "\n";
    await writeFile("overview.ts", lines);
    const result = await tool().execute("t3", {
      file_path: "overview.ts",
      include_imports: false,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("File head");
    expect(text).toContain("File tail");
    expect(text).toContain("content 1");
    expect(text).toContain("content 50");
  });

  it("searches for symbol references", async () => {
    await writeFile("def.ts", "export function myHelper() {}\n");
    await writeFile("usage.ts", 'import { myHelper } from "./def.js";\nmyHelper();\n');
    const result = await tool().execute("t4", {
      file_path: "def.ts",
      symbol: "myHelper",
      include_imports: false,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('References to "myHelper"');
    expect(text).toContain("usage.ts");
  });

  it("errors on missing file_path", async () => {
    await expect(tool().execute("t5", { file_path: "" })).rejects.toThrow(/file_path/i);
  });

  it("handles Python imports", async () => {
    await writeFile(
      "example.py",
      ["from os import path", "import sys", "", "def main():", "    pass", ""].join("\n"),
    );
    const result = await tool().execute("t6", { file_path: "example.py" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Imports");
    expect(text).toContain("path");
  });
});
