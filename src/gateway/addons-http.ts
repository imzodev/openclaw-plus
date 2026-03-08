import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddonRegistry } from "../addons/registry.js";
import { resolveFileWithinRoot } from "../canvas-host/file-resolver.js";
import { detectMime } from "../media/mime.js";

export const ADDONS_HTTP_PATH = "/__openclaw__/addons";

function applyAddonSecurityHeaders(res: ServerResponse) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export function createAddonsHttpHandler(params: {
  getRegistry: () => AddonRegistry;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { getRegistry } = params;

  return async (req, res) => {
    const urlRaw = req.url;
    if (!urlRaw) {
      return false;
    }

    const url = new URL(urlRaw, "http://localhost");
    const pathname = url.pathname;

    if (!pathname.startsWith(`${ADDONS_HTTP_PATH}/`)) {
      return false;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      applyAddonSecurityHeaders(res);
      res.statusCode = 405;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    // Parse: /__openclaw__/addons/<addon-id>/<file-path>
    const rest = pathname.slice(`${ADDONS_HTTP_PATH}/`.length);
    const slashIndex = rest.indexOf("/");
    const addonId = slashIndex >= 0 ? rest.slice(0, slashIndex) : rest;
    const filePath = slashIndex >= 0 ? rest.slice(slashIndex) : "/";

    if (!addonId) {
      applyAddonSecurityHeaders(res);
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("not found");
      return true;
    }

    const registry = getRegistry();
    const addon = registry.addons.find((a) => a.id === addonId && a.enabled);
    if (!addon) {
      applyAddonSecurityHeaders(res);
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("addon not found");
      return true;
    }

    applyAddonSecurityHeaders(res);

    const opened = await resolveFileWithinRoot(addon.rootDir, filePath);
    if (!opened) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("not found");
      return true;
    }

    const { handle, realPath } = opened;
    let data: Buffer;
    try {
      data = await handle.readFile();
    } finally {
      await handle.close().catch(() => {});
    }

    const lower = realPath.toLowerCase();
    const mime =
      lower.endsWith(".html") || lower.endsWith(".htm")
        ? "text/html"
        : lower.endsWith(".js") || lower.endsWith(".mjs")
          ? "text/javascript"
          : lower.endsWith(".css")
            ? "text/css"
            : lower.endsWith(".json")
              ? "application/json"
              : ((await detectMime({ filePath: realPath })) ?? "application/octet-stream");

    res.setHeader("Cache-Control", "no-store");
    if (mime.startsWith("text/")) {
      res.setHeader("Content-Type", `${mime}; charset=utf-8`);
    } else {
      res.setHeader("Content-Type", mime);
    }
    res.end(data);
    return true;
  };
}
