import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAddons, resolveGlobalAddonsDir, resolveWorkspaceAddonsDir } from "./discovery.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "addon-discovery-"));
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

function writeAddon(baseDir: string, id: string, extra?: Record<string, unknown>) {
  const dir = path.join(baseDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "addon.json"), JSON.stringify({ id, ...extra }));
  return dir;
}

describe("resolveGlobalAddonsDir", () => {
  it("returns addons subdir of state dir", () => {
    const result = resolveGlobalAddonsDir({ OPENCLAW_STATE_DIR: tmpDir });
    expect(result).toBe(path.join(tmpDir, "addons"));
  });
});

describe("resolveWorkspaceAddonsDir", () => {
  it("returns .openclaw/addons under workspace", () => {
    const result = resolveWorkspaceAddonsDir("/home/user/project");
    expect(result).toBe("/home/user/project/.openclaw/addons");
  });
});

describe("discoverAddons", () => {
  it("discovers addons from global dir", () => {
    const globalDir = path.join(tmpDir, "addons");
    writeAddon(globalDir, "hello", { name: "Hello" });
    writeAddon(globalDir, "world", { name: "World" });

    const result = discoverAddons({ env: { OPENCLAW_STATE_DIR: tmpDir } });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.id).toSorted()).toEqual(["hello", "world"]);
    expect(result.candidates[0].origin).toBe("global");
    expect(result.diagnostics).toHaveLength(0);
  });

  it("discovers addons from workspace dir", () => {
    const wsDir = path.join(tmpDir, "workspace");
    const wsAddonsDir = path.join(wsDir, ".openclaw", "addons");
    writeAddon(wsAddonsDir, "ws-addon", { name: "WS Addon" });

    const result = discoverAddons({
      workspaceDir: wsDir,
      env: { OPENCLAW_STATE_DIR: path.join(tmpDir, "empty-state") },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toBe("ws-addon");
    expect(result.candidates[0].origin).toBe("workspace");
  });

  it("workspace addons take precedence over global", () => {
    const globalDir = path.join(tmpDir, "addons");
    writeAddon(globalDir, "shared", { name: "Global Shared" });

    const wsDir = path.join(tmpDir, "workspace");
    const wsAddonsDir = path.join(wsDir, ".openclaw", "addons");
    writeAddon(wsAddonsDir, "shared", { name: "Workspace Shared" });

    const result = discoverAddons({
      workspaceDir: wsDir,
      env: { OPENCLAW_STATE_DIR: tmpDir },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toBe("shared");
    expect(result.candidates[0].origin).toBe("workspace");
    expect(result.candidates[0].manifest.name).toBe("Workspace Shared");
    // Global duplicate should be in diagnostics
    expect(result.diagnostics.some((d) => d.message.includes("duplicate"))).toBe(true);
  });

  it("skips directories without valid manifests", () => {
    const globalDir = path.join(tmpDir, "addons");
    writeAddon(globalDir, "valid", { name: "Valid" });
    // Create a dir without addon.json
    fs.mkdirSync(path.join(globalDir, "no-manifest"), { recursive: true });

    const result = discoverAddons({ env: { OPENCLAW_STATE_DIR: tmpDir } });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toBe("valid");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("skips hidden directories", () => {
    const globalDir = path.join(tmpDir, "addons");
    writeAddon(globalDir, "visible", { name: "Visible" });
    writeAddon(globalDir, ".hidden", { name: "Hidden" });

    const result = discoverAddons({ env: { OPENCLAW_STATE_DIR: tmpDir } });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toBe("visible");
  });

  it("returns empty when no addons dir exists", () => {
    const result = discoverAddons({
      env: { OPENCLAW_STATE_DIR: path.join(tmpDir, "nonexistent") },
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });
});
