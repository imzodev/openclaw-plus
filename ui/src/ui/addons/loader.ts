import type { AddonDefinition } from "./types.ts";

const loadedModules = new Map<string, typeof HTMLElement>();
const loadErrors = new Map<string, string>();

export async function loadAddonElement(
  addon: AddonDefinition,
  basePath: string,
): Promise<{ element: typeof HTMLElement } | { error: string }> {
  if (addon.element) {
    return { element: addon.element };
  }

  const cached = loadedModules.get(addon.id);
  if (cached) {
    return { element: cached };
  }

  const cachedError = loadErrors.get(addon.id);
  if (cachedError) {
    return { error: cachedError };
  }

  if (!addon.entryUrl) {
    const err = `addon "${addon.id}" has no entry URL`;
    loadErrors.set(addon.id, err);
    return { error: err };
  }

  const url = `${basePath}${addon.entryUrl}`;
  try {
    const mod = await import(/* @vite-ignore */ url);
    const exported = mod.default ?? mod;

    if (typeof exported === "function" && exported.prototype instanceof HTMLElement) {
      loadedModules.set(addon.id, exported);
      return { element: exported };
    }

    if (typeof exported === "object" && exported !== null) {
      const elementClass = exported.element ?? exported.default;
      if (typeof elementClass === "function" && elementClass.prototype instanceof HTMLElement) {
        loadedModules.set(addon.id, elementClass);
        return { element: elementClass };
      }
    }

    const err = `addon "${addon.id}" does not export an HTMLElement class`;
    loadErrors.set(addon.id, err);
    return { error: err };
  } catch (e) {
    const err = `failed to load addon "${addon.id}": ${String(e)}`;
    loadErrors.set(addon.id, err);
    return { error: err };
  }
}

export function clearAddonCache(addonId?: string): void {
  if (addonId) {
    loadedModules.delete(addonId);
    loadErrors.delete(addonId);
  } else {
    loadedModules.clear();
    loadErrors.clear();
  }
}
