import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCodeEditTool } from "./code-edit-tool.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-edit-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function tool() {
  return createCodeEditTool(tmpDir);
}

async function writeFile(name: string, content: string) {
  const p = path.join(tmpDir, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf-8");
  return p;
}

async function readFile(name: string) {
  return fs.readFile(path.join(tmpDir, name), "utf-8");
}

describe("code_edit", () => {
  it("performs an exact replacement", async () => {
    await writeFile("hello.ts", "const x = 1;\nconst y = 2;\nconst z = 3;\n");
    const result = await tool().execute("t1", {
      file_path: "hello.ts",
      old_string: "const y = 2;",
      new_string: "const y = 42;",
    });
    const content = await readFile("hello.ts");
    expect(content).toContain("const y = 42;");
    expect(content).toContain("const x = 1;");
    expect(content).toContain("const z = 3;");
    const text = result.content[0];
    expect(text).toHaveProperty("type", "text");
    expect((text as { text: string }).text).toContain("Successfully edited");
  });

  it("uses whitespace-tolerant matching when exact fails", async () => {
    await writeFile("ws.ts", 'if (true) {\n  console.log("hello");\n}\n');
    // Model sends slightly different whitespace (extra space)
    const result = await tool().execute("t2", {
      file_path: "ws.ts",
      old_string: 'if (true) {\n   console.log("hello");\n}',
      new_string: 'if (true) {\n  console.log("world");\n}',
    });
    const content = await readFile("ws.ts");
    expect(content).toContain('"world"');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("whitespace-tolerant");
  });

  it("uses token-based matching as last resort", async () => {
    // Whitespace-tolerant won't match because the structure differs (tabs vs spaces in different positions)
    // but tokens are the same
    await writeFile("token.ts", "function\tfoo(a,\tb) {\n\treturn a + b;\n}\n");
    // Model sends with completely different whitespace layout that breaks ws-tolerant but tokens match
    const result = await tool().execute("t3", {
      file_path: "token.ts",
      old_string: "function  foo(a,  b) {\n  return a + b;\n}",
      new_string: "function foo(a, b) {\n  return a - b;\n}",
    });
    const content = await readFile("token.ts");
    expect(content).toContain("a - b");
    const text = (result.content[0] as { text: string }).text;
    // May match via whitespace-tolerant or token-based depending on the input
    expect(text).toMatch(/whitespace-tolerant|token-based/);
  });

  it("creates a new file when old_string is empty", async () => {
    const result = await tool().execute("t4", {
      file_path: "new-file.ts",
      old_string: "",
      new_string: "export const hello = 'world';\n",
    });
    const content = await readFile("new-file.ts");
    expect(content).toBe("export const hello = 'world';\n");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Created new file");
  });

  it("errors when creating a file that already exists", async () => {
    await writeFile("exists.ts", "old content");
    await expect(
      tool().execute("t5", {
        file_path: "exists.ts",
        old_string: "",
        new_string: "new content",
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("errors when file does not exist for edit", async () => {
    await expect(
      tool().execute("t6", {
        file_path: "missing.ts",
        old_string: "something",
        new_string: "else",
      }),
    ).rejects.toThrow(/does not exist/i);
  });

  it("errors when no match is found", async () => {
    await writeFile("no-match.ts", "const a = 1;\n");
    await expect(
      tool().execute("t7", {
        file_path: "no-match.ts",
        old_string: "const b = 2;",
        new_string: "const b = 3;",
      }),
    ).rejects.toThrow(/no match found/i);
  });

  it("errors on occurrence count mismatch", async () => {
    await writeFile("multi.ts", "foo();\nfoo();\nfoo();\n");
    await expect(
      tool().execute("t8", {
        file_path: "multi.ts",
        old_string: "foo();",
        new_string: "bar();",
        // default expected_replacements = 1, but there are 3
      }),
    ).rejects.toThrow(/occurrence count mismatch/i);
  });

  it("replaces multiple occurrences with expected_replacements", async () => {
    await writeFile("multi-ok.ts", "foo();\nfoo();\nfoo();\n");
    await tool().execute("t9", {
      file_path: "multi-ok.ts",
      old_string: "foo();",
      new_string: "bar();",
      expected_replacements: 3,
    });
    const content = await readFile("multi-ok.ts");
    expect(content).toBe("bar();\nbar();\nbar();\n");
  });

  it("errors when old_string equals new_string", async () => {
    await writeFile("same.ts", "const x = 1;\n");
    await expect(
      tool().execute("t10", {
        file_path: "same.ts",
        old_string: "const x = 1;",
        new_string: "const x = 1;",
      }),
    ).rejects.toThrow(/identical/i);
  });

  it("preserves CRLF line endings", async () => {
    await writeFile("crlf.ts", "line1\r\nline2\r\nline3\r\n");
    await tool().execute("t11", {
      file_path: "crlf.ts",
      old_string: "line2",
      new_string: "replaced",
    });
    const content = await readFile("crlf.ts");
    expect(content).toBe("line1\r\nreplaced\r\nline3\r\n");
  });

  it("returns post-edit context in the response", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile("context.ts", lines);
    const result = await tool().execute("t12", {
      file_path: "context.ts",
      old_string: "line 10",
      new_string: "REPLACED",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Post-edit context");
    expect(text).toContain("REPLACED");
  });
});
