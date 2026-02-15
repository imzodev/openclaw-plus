import type { GatewayBrowserClient } from "../gateway.ts";

export type AddonContext = {
  client: GatewayBrowserClient;
  theme: "light" | "dark";
  agentId: string | null;
  basePath: string;
  navigate: (tab: string) => void;
};

export type AddonManifestInfo = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  icon?: string;
  entry: string;
  origin: "global" | "workspace";
  enabled: boolean;
  status: string;
  error?: string;
};

export type AddonDefinition = {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  source: "builtin" | "dynamic";
  element?: typeof HTMLElement;
  entryUrl?: string;
};
