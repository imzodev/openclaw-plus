import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCodeWriteTool } from "./code-write-tool.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-write-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function tool(opts?: Parameters<typeof createCodeWriteTool>[1]) {
  return createCodeWriteTool(tmpDir, opts);
}

async function readFile(name: string) {
  return fs.readFile(path.join(tmpDir, name), "utf-8");
}

describe("code_write", () => {
  it("writes a new file", async () => {
    const result = await tool({ disableSyntaxCheck: true }).execute("t1", {
      file_path: "hello.ts",
      content: "export const x = 1;\n",
    });
    const content = await readFile("hello.ts");
    expect(content).toBe("export const x = 1;\n");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Wrote 2 lines");
  });

  it("creates parent directories", async () => {
    await tool({ disableSyntaxCheck: true }).execute("t2", {
      file_path: "deep/nested/dir/file.ts",
      content: "hello\n",
    });
    const content = await readFile("deep/nested/dir/file.ts");
    expect(content).toBe("hello\n");
  });

  it("overwrites an existing file", async () => {
    const p = path.join(tmpDir, "overwrite.ts");
    await fs.writeFile(p, "old content", "utf-8");
    await tool({ disableSyntaxCheck: true }).execute("t3", {
      file_path: "overwrite.ts",
      content: "new content\n",
    });
    const content = await readFile("overwrite.ts");
    expect(content).toBe("new content\n");
  });

  it("returns line-numbered preview", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = await tool({ disableSyntaxCheck: true }).execute("t4", {
      file_path: "preview.ts",
      content: lines,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1\tline 1");
    expect(text).toContain("5\tline 5");
  });

  it("truncates preview for large files", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = await tool({ disableSyntaxCheck: true }).execute("t5", {
      file_path: "large.ts",
      content: lines,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("more lines");
  });

  it("runs syntax check on valid JSON", async () => {
    const result = await tool().execute("t6", {
      file_path: "valid.json",
      content: '{"key": "value"}\n',
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Syntax check passed");
  });

  it("reports syntax errors in invalid JSON", async () => {
    const result = await tool().execute("t7", {
      file_path: "invalid.json",
      content: '{"key": value}\n',
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Syntax check FAILED");
  });

  it("skips syntax check for unknown extensions", async () => {
    const result = await tool().execute("t8", {
      file_path: "readme.md",
      content: "# Hello\n",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("Syntax check");
  });

  it("errors on missing file_path", async () => {
    await expect(
      tool({ disableSyntaxCheck: true }).execute("t9", {
        file_path: "",
        content: "hello",
      }),
    ).rejects.toThrow(/file_path/i);
  });

  it("respects explicit language parameter", async () => {
    const result = await tool().execute("t10", {
      file_path: "data.txt",
      content: '{"valid": true}\n',
      language: "json",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Syntax check passed");
  });
});
