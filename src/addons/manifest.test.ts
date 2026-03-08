import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAddonManifest } from "./manifest.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "addon-manifest-"));
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe("loadAddonManifest", () => {
  it("loads a valid manifest", () => {
    fs.writeFileSync(
      path.join(tmpDir, "addon.json"),
      JSON.stringify({
        id: "test-addon",
        name: "Test Addon",
        description: "A test addon",
        version: "1.0.0",
        icon: "puzzle",
        entry: "main.js",
      }),
    );
    const result = loadAddonManifest(tmpDir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.id).toBe("test-addon");
    expect(result.manifest.name).toBe("Test Addon");
    expect(result.manifest.description).toBe("A test addon");
    expect(result.manifest.version).toBe("1.0.0");
    expect(result.manifest.icon).toBe("puzzle");
    expect(result.manifest.entry).toBe("main.js");
  });

  it("uses defaults for optional fields", () => {
    fs.writeFileSync(path.join(tmpDir, "addon.json"), JSON.stringify({ id: "minimal" }));
    const result = loadAddonManifest(tmpDir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.id).toBe("minimal");
    expect(result.manifest.name).toBeUndefined();
    expect(result.manifest.entry).toBeUndefined();
  });

  it("fails when manifest file is missing", () => {
    const result = loadAddonManifest(tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("not found");
  });

  it("fails when manifest is not valid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "addon.json"), "not json {{{");
    const result = loadAddonManifest(tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("failed to parse");
  });

  it("fails when manifest is not an object", () => {
    fs.writeFileSync(path.join(tmpDir, "addon.json"), '"just a string"');
    const result = loadAddonManifest(tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("must be an object");
  });

  it("fails when id is missing", () => {
    fs.writeFileSync(path.join(tmpDir, "addon.json"), JSON.stringify({ name: "No ID" }));
    const result = loadAddonManifest(tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("requires id");
  });

  it("fails when id has invalid characters", () => {
    fs.writeFileSync(path.join(tmpDir, "addon.json"), JSON.stringify({ id: "Bad Addon!" }));
    const result = loadAddonManifest(tmpDir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("lowercase alphanumeric");
  });

  it("accepts id with dots, hyphens, and underscores", () => {
    fs.writeFileSync(path.join(tmpDir, "addon.json"), JSON.stringify({ id: "my-addon.v2_test" }));
    const result = loadAddonManifest(tmpDir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.id).toBe("my-addon.v2_test");
  });
});
