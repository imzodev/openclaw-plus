import type { AddonDefinition, AddonManifestInfo } from "./types.ts";

const builtinAddons: AddonDefinition[] = [];
let dynamicAddons: AddonDefinition[] = [];

export function registerBuiltinAddon(addon: AddonDefinition): void {
  if (builtinAddons.some((a) => a.id === addon.id)) {
    return;
  }
  builtinAddons.push({ ...addon, source: "builtin" });
}

export function setDynamicAddons(manifests: AddonManifestInfo[]): void {
  dynamicAddons = manifests
    .filter((m) => m.enabled && m.status === "loaded")
    .map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      icon: m.icon,
      source: "dynamic" as const,
      entryUrl: `/__openclaw__/addons/${m.id}/${m.entry}`,
    }));
}

export function getRegisteredAddons(): readonly AddonDefinition[] {
  const seen = new Set<string>();
  const result: AddonDefinition[] = [];
  for (const addon of builtinAddons) {
    seen.add(addon.id);
    result.push(addon);
  }
  for (const addon of dynamicAddons) {
    if (!seen.has(addon.id)) {
      seen.add(addon.id);
      result.push(addon);
    }
  }
  return result;
}

export function getAddonById(id: string): AddonDefinition | undefined {
  return builtinAddons.find((a) => a.id === id) ?? dynamicAddons.find((a) => a.id === id);
}
