import fs from "node:fs";
import path from "node:path";
import { resolveGlobalAddonsDir } from "../../addons/discovery.js";
import { listAddonsForGateway } from "../../addons/registry.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const ADDON_ID_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const MAX_ENTRY_SIZE = 512 * 1024; // 512 KB

export const addonHandlers: GatewayRequestHandlers = {
  "addons.list": async ({ context, respond }) => {
    const addons = listAddonsForGateway(context.addonRegistry);
    respond(true, { addons }, undefined);
  },

  "addons.create": async ({ params, context, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id || !ADDON_ID_RE.test(id)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          'id is required and must be lowercase alphanumeric with hyphens/dots/underscores (e.g. "my-addon")',
        ),
      );
      return;
    }

    const code = typeof params.code === "string" ? params.code : "";
    if (!code.trim()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "code (JavaScript entry source) is required"),
      );
      return;
    }
    if (code.length > MAX_ENTRY_SIZE) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `code exceeds max size (${MAX_ENTRY_SIZE} bytes)`),
      );
      return;
    }

    const name = typeof params.name === "string" ? params.name.trim() : id;
    const description =
      typeof params.description === "string" ? params.description.trim() : undefined;
    const version = typeof params.version === "string" ? params.version.trim() : "0.1.0";
    const icon = typeof params.icon === "string" ? params.icon.trim() : "puzzle";
    const entry = "index.js";

    const addonsDir = resolveGlobalAddonsDir();
    const addonDir = path.join(addonsDir, id);

    try {
      fs.mkdirSync(addonDir, { recursive: true });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `failed to create addon directory: ${String(err)}`),
      );
      return;
    }

    const manifest = {
      id,
      name,
      ...(description ? { description } : {}),
      version,
      icon,
      entry,
    };

    try {
      fs.writeFileSync(path.join(addonDir, "addon.json"), JSON.stringify(manifest, null, 2) + "\n");
      fs.writeFileSync(path.join(addonDir, entry), code);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `failed to write addon files: ${String(err)}`),
      );
      return;
    }

    const registry = context.refreshAddonRegistry();
    const addons = listAddonsForGateway(registry);
    const created = addons.find((a) => a.id === id);

    respond(true, { addon: created ?? { id, name, status: "loaded" } }, undefined);
  },

  "addons.delete": async ({ params, context, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id || !ADDON_ID_RE.test(id)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }

    const existing = context.addonRegistry.addons.find((a) => a.id === id);
    if (!existing) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `addon "${id}" not found`));
      return;
    }

    try {
      fs.rmSync(existing.rootDir, { recursive: true, force: true });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `failed to delete addon directory: ${String(err)}`),
      );
      return;
    }

    context.refreshAddonRegistry();
    respond(true, { deleted: id }, undefined);
  },
};
