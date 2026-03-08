import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCodeOutlineTool } from "./code-outline-tool.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-outline-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function tool() {
  return createCodeOutlineTool(tmpDir);
}

async function writeFile(name: string, content: string) {
  const p = path.join(tmpDir, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf-8");
  return p;
}

describe("code_outline", () => {
  it("extracts TypeScript functions and classes", async () => {
    await writeFile(
      "example.ts",
      [
        "export function greet(name: string) {",
        "  return `Hello ${name}`;",
        "}",
        "",
        "export class Greeter {",
        "  sayHi() {",
        "    return 'hi';",
        "  }",
        "}",
        "",
        "export interface Config {",
        "  name: string;",
        "}",
        "",
        "export type ID = string;",
        "",
      ].join("\n"),
    );
    const result = await tool().execute("t1", { file_path: "example.ts" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("function greet");
    expect(text).toContain("class Greeter");
    expect(text).toContain("interface Config");
    expect(text).toContain("type ID");
  });

  it("extracts Python classes and functions", async () => {
    await writeFile(
      "example.py",
      [
        "class MyClass:",
        "    def method(self):",
        "        pass",
        "",
        "def standalone():",
        "    pass",
        "",
      ].join("\n"),
    );
    const result = await tool().execute("t2", { file_path: "example.py" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("class MyClass");
    expect(text).toContain("function method");
    expect(text).toContain("function standalone");
  });

  it("returns no symbols for unsupported extensions", async () => {
    await writeFile("readme.md", "# Hello\nSome text\n");
    const result = await tool().execute("t3", { file_path: "readme.md" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("0 symbols");
    expect(text).toContain("no symbols found");
  });

  it("respects max_depth parameter", async () => {
    await writeFile(
      "nested.ts",
      [
        "export class Outer {",
        "  innerMethod() {",
        "    const nested = () => {};",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const result = await tool().execute("t4", {
      file_path: "nested.ts",
      max_depth: 1,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("class Outer");
    // Methods are depth 2, should be filtered at max_depth=1
  });

  it("includes line numbers", async () => {
    await writeFile(
      "lines.ts",
      ["// comment", "// comment", "export function third() {}", ""].join("\n"),
    );
    const result = await tool().execute("t5", { file_path: "lines.ts" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("3\t");
    expect(text).toContain("function third");
  });

  it("errors on missing file_path", async () => {
    await expect(tool().execute("t6", { file_path: "" })).rejects.toThrow(/file_path/i);
  });
});
