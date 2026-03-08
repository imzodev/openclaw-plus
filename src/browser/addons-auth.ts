import type { IncomingMessage } from "node:http";

const ADDONS_PATH_PREFIX = "/__openclaw__/addons/";
const ADDON_AUTH_COOKIE_NAME = "openclaw_addon_token";

function getCookieValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie?.trim();
  if (!raw) {
    return undefined;
  }
  for (const part of raw.split(";")) {
    const [cookieNameRaw, ...valueParts] = part.split("=");
    const cookieName = cookieNameRaw?.trim();
    if (!cookieName || cookieName !== name) {
      continue;
    }
    const encoded = valueParts.join("=").trim();
    if (!encoded) {
      return undefined;
    }
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return undefined;
}

export function getAddonAuthToken(req: IncomingMessage): string | undefined {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (!pathname.startsWith(ADDONS_PATH_PREFIX)) {
    return undefined;
  }
  const raw = getCookieValue(req, ADDON_AUTH_COOKIE_NAME)?.trim();
  if (!raw) {
    return undefined;
  }
  return raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() || undefined : raw;
}
