import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCodeReadTool } from "./code-read-tool.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-read-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function tool() {
  return createCodeReadTool(tmpDir);
}

async function writeFile(name: string, content: string) {
  const p = path.join(tmpDir, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf-8");
  return p;
}

describe("code_read", () => {
  it("reads a full file with line numbers", async () => {
    await writeFile("hello.ts", "line 1\nline 2\nline 3\n");
    const result = await tool().execute("t1", { file_path: "hello.ts" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1\tline 1");
    expect(text).toContain("2\tline 2");
    expect(text).toContain("3\tline 3");
    expect(text).toContain("full file");
  });

  it("reads a slice with offset and limit", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile("slice.ts", lines);
    const result = await tool().execute("t2", {
      file_path: "slice.ts",
      offset: 5,
      limit: 3,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("5\tline 5");
    expect(text).toContain("6\tline 6");
    expect(text).toContain("7\tline 7");
    expect(text).not.toContain("4\tline 4");
    expect(text).not.toContain("8\tline 8");
  });

  it("extracts semantic block around anchor_line", async () => {
    await writeFile(
      "block.ts",
      [
        "const a = 1;",
        "",
        "function greet() {",
        "  const name = 'world';",
        "  console.log(name);",
        "  return name;",
        "}",
        "",
        "const b = 2;",
        "",
      ].join("\n"),
    );
    const result = await tool().execute("t3", {
      file_path: "block.ts",
      anchor_line: 5,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("semantic block");
    expect(text).toContain("function greet");
    expect(text).toContain("console.log");
  });

  it("shows continuation hint for large files", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile("large.ts", lines);
    const result = await tool().execute("t4", {
      file_path: "large.ts",
      offset: 1,
      limit: 10,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("more lines");
    expect(text).toContain("offset=11");
  });

  it("errors on missing file_path", async () => {
    await expect(tool().execute("t5", { file_path: "" })).rejects.toThrow(/file_path/i);
  });

  it("errors on nonexistent file", async () => {
    await expect(tool().execute("t6", { file_path: "missing.ts" })).rejects.toThrow();
  });

  it("includes total line count in header", async () => {
    await writeFile("count.ts", "a\nb\nc\nd\ne\n");
    const result = await tool().execute("t7", { file_path: "count.ts" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("6 lines");
  });
});
