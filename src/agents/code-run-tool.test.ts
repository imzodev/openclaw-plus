import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCodeRunTool } from "./code-run-tool.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-run-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function tool() {
  return createCodeRunTool(tmpDir);
}

describe("code_run", () => {
  it("runs a successful command", async () => {
    const result = await tool().execute("t1", {
      command: "echo hello world",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("✓ Command succeeded");
    expect(text).toContain("hello world");
  });

  it("captures exit code on failure", async () => {
    const result = await tool().execute("t2", {
      command: "exit 1",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("✗ Command failed");
    expect(text).toContain("exit 1");
  });

  it("extracts error lines from output", async () => {
    await fs.writeFile(path.join(tmpDir, "bad.js"), "const x = {\n", "utf-8");
    const result = await tool().execute("t3", {
      command: `node --check ${JSON.stringify(path.join(tmpDir, "bad.js"))}`,
      parse_errors: true,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("✗ Command failed");
    expect(text).toContain("Error");
  });

  it("respects working_directory", async () => {
    const subDir = path.join(tmpDir, "sub");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, "marker.txt"), "found", "utf-8");
    const result = await tool().execute("t4", {
      command: "cat marker.txt",
      working_directory: "sub",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("found");
  });

  it("errors on empty command", async () => {
    await expect(tool().execute("t5", { command: "" })).rejects.toThrow(/command/i);
  });

  it("handles timeout", async () => {
    const result = await tool().execute("t6", {
      command: "sleep 10",
      timeout_seconds: 1,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("✗ Command failed");
  });
});
