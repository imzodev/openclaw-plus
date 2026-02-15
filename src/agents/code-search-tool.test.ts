import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCodeSearchTool } from "./code-search-tool.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-search-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function tool() {
  return createCodeSearchTool(tmpDir);
}

async function writeFile(name: string, content: string) {
  const p = path.join(tmpDir, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf-8");
  return p;
}

describe("code_search", () => {
  it("finds a literal string match", async () => {
    await writeFile("hello.ts", "export function greet() {\n  return 'hello';\n}\n");
    const result = await tool().execute("t1", {
      query: "greet",
      fixed_strings: true,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("hello.ts");
    expect(text).toContain("greet");
  });

  it("finds regex matches", async () => {
    await writeFile("regex.ts", "const foo = 1;\nconst bar = 2;\nconst baz = 3;\n");
    const result = await tool().execute("t2", {
      query: "const \\w+ = \\d",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("regex.ts");
  });

  it("returns no matches message when nothing found", async () => {
    await writeFile("empty.ts", "nothing here\n");
    const result = await tool().execute("t3", {
      query: "nonexistent_symbol_xyz",
      fixed_strings: true,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No matches found");
  });

  it("respects include glob filter", async () => {
    await writeFile("a.ts", "target_word\n");
    await writeFile("b.py", "target_word\n");
    const result = await tool().execute("t4", {
      query: "target_word",
      include: "*.ts",
      fixed_strings: true,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.ts");
    expect(text).not.toContain("b.py");
  });

  it("respects path parameter", async () => {
    await writeFile("src/deep.ts", "deep_value\n");
    await writeFile("other/shallow.ts", "deep_value\n");
    const result = await tool().execute("t5", {
      query: "deep_value",
      path: "src",
      fixed_strings: true,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("deep.ts");
  });

  it("errors on empty query", async () => {
    await expect(tool().execute("t6", { query: "" })).rejects.toThrow(/query/i);
  });
});
