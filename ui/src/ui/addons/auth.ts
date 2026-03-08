import { loadDeviceAuthToken } from "../device-auth.ts";
import { loadOrCreateDeviceIdentity } from "../device-identity.ts";
import { loadSettings } from "../storage.ts";

const ADDON_AUTH_COOKIE_NAME = "openclaw_addon_token";

export async function resolveAddonAuthHeader(): Promise<string | null> {
  const settingsToken = loadSettings().token.trim();
  if (settingsToken) {
    return `Bearer ${settingsToken}`;
  }
  try {
    const identity = await loadOrCreateDeviceIdentity();
    const token = loadDeviceAuthToken({
      deviceId: identity.deviceId,
      role: "operator",
    })?.token;
    if (token?.trim()) {
      return `Bearer ${token.trim()}`;
    }
  } catch {
    return null;
  }
  return null;
}

export function setAddonAuthCookie(basePath: string, authHeader: string): void {
  const path = `${basePath || ""}/__openclaw__/addons`;
  document.cookie = `${ADDON_AUTH_COOKIE_NAME}=${encodeURIComponent(authHeader)}; Path=${path}; SameSite=Lax; Secure`;
}

export function clearAddonAuthCookie(basePath: string): void {
  const path = `${basePath || ""}/__openclaw__/addons`;
  document.cookie = `${ADDON_AUTH_COOKIE_NAME}=; Path=${path}; Max-Age=0; SameSite=Lax; Secure`;
}
