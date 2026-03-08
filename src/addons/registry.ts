import type { AddonCandidate, AddonDiagnostic, AddonOrigin } from "./discovery.js";
import { discoverAddons } from "./discovery.js";

export type AddonRecord = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  icon?: string;
  entry: string;
  rootDir: string;
  manifestPath: string;
  origin: AddonOrigin;
  workspaceDir?: string;
  enabled: boolean;
  status: "loaded" | "disabled" | "error";
  error?: string;
};

export type AddonRegistry = {
  addons: AddonRecord[];
  diagnostics: AddonDiagnostic[];
};

const DEFAULT_ENTRY = "index.js";

function buildRecord(candidate: AddonCandidate): AddonRecord {
  const manifest = candidate.manifest;
  return {
    id: manifest.id,
    name: manifest.name ?? manifest.id,
    description: manifest.description,
    version: manifest.version,
    icon: manifest.icon,
    entry: manifest.entry ?? DEFAULT_ENTRY,
    rootDir: candidate.rootDir,
    manifestPath: candidate.manifestPath,
    origin: candidate.origin,
    workspaceDir: candidate.workspaceDir,
    enabled: true,
    status: "loaded",
  };
}

export function loadAddonRegistry(params?: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AddonRegistry {
  const discovery = discoverAddons({
    workspaceDir: params?.workspaceDir,
    env: params?.env,
  });

  const addons: AddonRecord[] = [];
  const diagnostics: AddonDiagnostic[] = [...discovery.diagnostics];

  for (const candidate of discovery.candidates) {
    addons.push(buildRecord(candidate));
  }

  return { addons, diagnostics };
}

export function listAddonsForGateway(registry: AddonRegistry): Array<{
  id: string;
  name: string;
  description?: string;
  version?: string;
  icon?: string;
  entry: string;
  origin: AddonOrigin;
  enabled: boolean;
  status: string;
  error?: string;
}> {
  return registry.addons.map((addon) => ({
    id: addon.id,
    name: addon.name,
    description: addon.description,
    version: addon.version,
    icon: addon.icon,
    entry: addon.entry,
    origin: addon.origin,
    enabled: addon.enabled,
    status: addon.status,
    error: addon.error,
  }));
}
