import type { AddonManifestInfo } from "../addons/types.ts";
import { setDynamicAddons } from "../addons/registry.ts";

type AddonsHost = {
  addonsLoading: boolean;
  addonsError: string | null;
  client: { request: (method: string, params?: unknown) => Promise<unknown> } | null;
};

export async function loadAddons(host: AddonsHost): Promise<void> {
  if (!host.client) {
    return;
  }
  host.addonsLoading = true;
  host.addonsError = null;
  try {
    const result = (await host.client.request("addons.list")) as {
      addons?: AddonManifestInfo[];
    };
    const addons = result?.addons ?? [];
    setDynamicAddons(addons);
  } catch (err) {
    host.addonsError = String(err);
  } finally {
    host.addonsLoading = false;
  }
}
