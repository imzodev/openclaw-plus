import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";

const ADDON_ACTIONS = ["create", "delete", "list"] as const;

const AddonToolSchema = Type.Object({
  action: stringEnum(ADDON_ACTIONS),
  // create + delete
  id: Type.Optional(Type.String()),
  // create only
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  code: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String()),
  version: Type.Optional(Type.String()),
});

export function createAddonTool(): AnyAgentTool {
  return {
    label: "UI Addon",
    name: "ui_addon",
    description:
      "Create, delete, or list UI addons for the Control UI. Addons are custom web panels that appear as tabs in the browser-based Control UI. " +
      "To create an addon, provide action='create' with an id and JavaScript code that default-exports an HTMLElement subclass. " +
      "The element can use Shadow DOM for style isolation and implement setContext(ctx) to receive the gateway client, theme, and agent info. " +
      "Use ctx.client.request(method, params) inside the addon to call any gateway RPC method (e.g. chat.send, health, sessions.list). " +
      "The addon appears immediately as a new tab in the Control UI after creation.",
    parameters: AddonToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      if (action === "list") {
        const result = await callGatewayTool("addons.list", {}, {});
        return jsonResult({ ok: true, result });
      }

      if (action === "delete") {
        const id = readStringParam(params, "id", { required: true });
        const result = await callGatewayTool("addons.delete", {}, { id });
        return jsonResult({ ok: true, result });
      }

      if (action === "create") {
        const id = readStringParam(params, "id", { required: true });
        const code = readStringParam(params, "code", { required: true, allowEmpty: false });
        const name = readStringParam(params, "name");
        const description = readStringParam(params, "description");
        const icon = readStringParam(params, "icon");
        const version = readStringParam(params, "version");
        const result = await callGatewayTool(
          "addons.create",
          {},
          {
            id,
            code,
            ...(name ? { name } : {}),
            ...(description ? { description } : {}),
            ...(icon ? { icon } : {}),
            ...(version ? { version } : {}),
          },
        );
        return jsonResult({ ok: true, result });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
