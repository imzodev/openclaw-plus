import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadAddonManifest, type AddonManifest } from "./manifest.js";

export type AddonOrigin = "global" | "workspace";

export type AddonCandidate = {
  id: string;
  manifest: AddonManifest;
  manifestPath: string;
  rootDir: string;
  origin: AddonOrigin;
  workspaceDir?: string;
};

export type AddonDiagnostic = {
  level: "warn" | "error";
  message: string;
  addonId?: string;
  source?: string;
};

export type AddonDiscoveryResult = {
  candidates: AddonCandidate[];
  diagnostics: AddonDiagnostic[];
};

function discoverInDirectory(params: {
  dir: string;
  origin: AddonOrigin;
  workspaceDir?: string;
  candidates: AddonCandidate[];
  diagnostics: AddonDiagnostic[];
  seen: Set<string>;
}) {
  if (!fs.existsSync(params.dir)) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(params.dir, { withFileTypes: true });
  } catch (err) {
    params.diagnostics.push({
      level: "warn",
      message: `failed to read addons dir: ${params.dir} (${String(err)})`,
      source: params.dir,
    });
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = path.join(params.dir, entry.name);
    const result = loadAddonManifest(fullPath);
    if (!result.ok) {
      params.diagnostics.push({
        level: "warn",
        message: result.error,
        source: result.manifestPath,
      });
      continue;
    }

    const manifest = result.manifest;
    if (params.seen.has(manifest.id)) {
      params.diagnostics.push({
        level: "warn",
        addonId: manifest.id,
        source: fullPath,
        message: `duplicate addon id "${manifest.id}" — skipping`,
      });
      continue;
    }

    params.seen.add(manifest.id);
    params.candidates.push({
      id: manifest.id,
      manifest,
      manifestPath: result.manifestPath,
      rootDir: path.resolve(fullPath),
      origin: params.origin,
      workspaceDir: params.workspaceDir,
    });
  }
}

export function resolveGlobalAddonsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "addons");
}

export function resolveWorkspaceAddonsDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".openclaw", "addons");
}

export function discoverAddons(params?: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AddonDiscoveryResult {
  const candidates: AddonCandidate[] = [];
  const diagnostics: AddonDiagnostic[] = [];
  const seen = new Set<string>();
  const env = params?.env ?? process.env;
  const workspaceDir = params?.workspaceDir?.trim();

  // Workspace addons take precedence over global
  if (workspaceDir) {
    const wsAddonsDir = resolveWorkspaceAddonsDir(workspaceDir);
    discoverInDirectory({
      dir: wsAddonsDir,
      origin: "workspace",
      workspaceDir,
      candidates,
      diagnostics,
      seen,
    });
  }

  const globalDir = resolveGlobalAddonsDir(env);
  discoverInDirectory({
    dir: globalDir,
    origin: "global",
    candidates,
    diagnostics,
    seen,
  });

  return { candidates, diagnostics };
}
