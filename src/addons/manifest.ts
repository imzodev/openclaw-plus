import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../utils.js";

export const ADDON_MANIFEST_FILENAME = "addon.json";

export type AddonManifest = {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  icon?: string;
  entry?: string;
};

export type AddonManifestLoadResult =
  | { ok: true; manifest: AddonManifest; manifestPath: string }
  | { ok: false; error: string; manifestPath: string };

export function resolveAddonManifestPath(rootDir: string): string {
  return path.join(rootDir, ADDON_MANIFEST_FILENAME);
}

export function loadAddonManifest(rootDir: string): AddonManifestLoadResult {
  const manifestPath = resolveAddonManifestPath(rootDir);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `addon manifest not found: ${manifestPath}`, manifestPath };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse addon manifest: ${String(err)}`,
      manifestPath,
    };
  }
  if (!isRecord(raw)) {
    return { ok: false, error: "addon manifest must be an object", manifestPath };
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) {
    return { ok: false, error: "addon manifest requires id", manifestPath };
  }
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id)) {
    return {
      ok: false,
      error: `addon id must be lowercase alphanumeric with hyphens/dots/underscores: "${id}"`,
      manifestPath,
    };
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : undefined;
  const description = typeof raw.description === "string" ? raw.description.trim() : undefined;
  const version = typeof raw.version === "string" ? raw.version.trim() : undefined;
  const icon = typeof raw.icon === "string" ? raw.icon.trim() : undefined;
  const entry = typeof raw.entry === "string" ? raw.entry.trim() : undefined;

  return {
    ok: true,
    manifest: { id, name, description, version, icon, entry },
    manifestPath,
  };
}
