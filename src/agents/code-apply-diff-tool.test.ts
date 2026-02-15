import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCodeApplyDiffTool } from "./code-apply-diff-tool.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-diff-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function tool() {
  return createCodeApplyDiffTool(tmpDir);
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

describe("code_apply_diff", () => {
  it("applies a single SEARCH/REPLACE block", async () => {
    await writeFile("single.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    await tool().execute("t1", {
      file_path: "single.ts",
      diff: [
        "<<<<<<< SEARCH",
        ":start_line:2",
        "-------",
        "const b = 2;",
        "=======",
        "const b = 42;",
        ">>>>>>> REPLACE",
      ].join("\n"),
    });
    const content = await readFile("single.ts");
    expect(content).toBe("const a = 1;\nconst b = 42;\nconst c = 3;\n");
  });

  it("applies multiple SEARCH/REPLACE blocks", async () => {
    await writeFile("multi.ts", "line 1\nline 2\nline 3\nline 4\nline 5\n");
    const result = await tool().execute("t2", {
      file_path: "multi.ts",
      diff: [
        "<<<<<<< SEARCH",
        ":start_line:2",
        "-------",
        "line 2",
        "=======",
        "LINE TWO",
        ">>>>>>> REPLACE",
        "",
        "<<<<<<< SEARCH",
        ":start_line:4",
        "-------",
        "line 4",
        "=======",
        "LINE FOUR",
        ">>>>>>> REPLACE",
      ].join("\n"),
    });
    const content = await readFile("multi.ts");
    expect(content).toContain("LINE TWO");
    expect(content).toContain("LINE FOUR");
    expect(content).toContain("line 1");
    expect(content).toContain("line 3");
    expect(content).toContain("line 5");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("2/2");
  });

  it("works without :start_line: hint", async () => {
    await writeFile("no-hint.ts", "foo();\nbar();\nbaz();\n");
    await tool().execute("t3", {
      file_path: "no-hint.ts",
      diff: ["<<<<<<< SEARCH", "bar();", "=======", "BAR();", ">>>>>>> REPLACE"].join("\n"),
    });
    const content = await readFile("no-hint.ts");
    expect(content).toContain("BAR();");
  });

  it("reports partial success when some blocks fail", async () => {
    await writeFile("partial.ts", "aaa\nbbb\nccc\n");
    const result = await tool().execute("t4", {
      file_path: "partial.ts",
      diff: [
        "<<<<<<< SEARCH",
        "bbb",
        "=======",
        "BBB",
        ">>>>>>> REPLACE",
        "",
        "<<<<<<< SEARCH",
        "zzz",
        "=======",
        "ZZZ",
        ">>>>>>> REPLACE",
      ].join("\n"),
    });
    const content = await readFile("partial.ts");
    expect(content).toContain("BBB");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1/2");
    expect(text).toContain("failed");
  });

  it("errors when all blocks fail", async () => {
    await writeFile("all-fail.ts", "aaa\nbbb\nccc\n");
    await expect(
      tool().execute("t5", {
        file_path: "all-fail.ts",
        diff: ["<<<<<<< SEARCH", "xxx", "=======", "yyy", ">>>>>>> REPLACE"].join("\n"),
      }),
    ).rejects.toThrow(/failed to apply/i);
  });

  it("errors when file does not exist", async () => {
    await expect(
      tool().execute("t6", {
        file_path: "missing.ts",
        diff: "<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE",
      }),
    ).rejects.toThrow(/does not exist/i);
  });

  it("errors on malformed diff (missing separator)", async () => {
    await writeFile("bad-diff.ts", "content\n");
    await expect(
      tool().execute("t7", {
        file_path: "bad-diff.ts",
        diff: "<<<<<<< SEARCH\nfoo\n>>>>>>> REPLACE",
      }),
    ).rejects.toThrow(/missing/i);
  });

  it("errors when no blocks found", async () => {
    await writeFile("empty-diff.ts", "content\n");
    await expect(
      tool().execute("t8", {
        file_path: "empty-diff.ts",
        diff: "just some random text",
      }),
    ).rejects.toThrow(/no SEARCH\/REPLACE blocks/i);
  });

  it("preserves CRLF line endings", async () => {
    await writeFile("crlf.ts", "line1\r\nline2\r\nline3\r\n");
    await tool().execute("t9", {
      file_path: "crlf.ts",
      diff: "<<<<<<< SEARCH\nline2\n=======\nreplaced\n>>>>>>> REPLACE",
    });
    const content = await readFile("crlf.ts");
    expect(content).toBe("line1\r\nreplaced\r\nline3\r\n");
  });

  it("uses whitespace-tolerant matching as fallback", async () => {
    await writeFile("ws.ts", "if (true) {\n  console.log('hi');\n}\n");
    await tool().execute("t10", {
      file_path: "ws.ts",
      diff: [
        "<<<<<<< SEARCH",
        ":start_line:1",
        "-------",
        "if (true) {\n   console.log('hi');\n}",
        "=======",
        "if (false) {\n  console.log('bye');\n}",
        ">>>>>>> REPLACE",
      ].join("\n"),
    });
    const content = await readFile("ws.ts");
    expect(content).toContain("'bye'");
  });

  it("shows single-block efficiency notice", async () => {
    await writeFile("notice.ts", "foo\nbar\nbaz\n");
    const result = await tool().execute("t11", {
      file_path: "notice.ts",
      diff: "<<<<<<< SEARCH\nbar\n=======\nBAR\n>>>>>>> REPLACE",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("<notice>");
  });

  it("returns post-edit context with line numbers", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile("ctx.ts", lines);
    const result = await tool().execute("t12", {
      file_path: "ctx.ts",
      diff: [
        "<<<<<<< SEARCH",
        ":start_line:10",
        "-------",
        "line 10",
        "=======",
        "REPLACED",
        ">>>>>>> REPLACE",
      ].join("\n"),
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Post-edit context");
    expect(text).toContain("REPLACED");
  });
});
