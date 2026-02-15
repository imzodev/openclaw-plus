import { listAddonsForGateway } from "../../addons/registry.js";
import type { GatewayRequestHandlers } from "./types.js";

export const addonHandlers: GatewayRequestHandlers = {
  "addons.list": async ({ context, respond }) => {
    const addons = listAddonsForGateway(context.addonRegistry);
    respond(true, { addons }, undefined);
  },
};
