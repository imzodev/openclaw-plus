import { getRegisteredAddons, getAddonById } from "./addons/registry.ts";
import type { IconName } from "./icons.js";

export const TAB_GROUPS = [
  { label: "chat", tabs: ["chat"] },
  {
    label: "control",
    tabs: ["overview", "channels", "instances", "sessions", "usage", "cron"],
  },
  { label: "agent", tabs: ["agents", "skills", "nodes"] },
  { label: "settings", tabs: ["config", "debug", "logs"] },
] as const;

export type StaticTab =
  | "agents"
  | "overview"
  | "channels"
  | "instances"
  | "sessions"
  | "usage"
  | "cron"
  | "skills"
  | "nodes"
  | "chat"
  | "config"
  | "debug"
  | "logs";

export type AddonTab = `addon:${string}`;

export type Tab = StaticTab | AddonTab;

export const ADDON_TAB_PREFIX = "addon:";

export function isAddonTab(tab: string): tab is AddonTab {
  return tab.startsWith(ADDON_TAB_PREFIX);
}

export function addonTabId(tab: AddonTab): string {
  return tab.slice(ADDON_TAB_PREFIX.length);
}

export function addonTabFor(addonId: string): AddonTab {
  return `${ADDON_TAB_PREFIX}${addonId}`;
}

const TAB_PATHS: Record<StaticTab, string> = {
  agents: "/agents",
  overview: "/overview",
  channels: "/channels",
  instances: "/instances",
  sessions: "/sessions",
  usage: "/usage",
  cron: "/cron",
  skills: "/skills",
  nodes: "/nodes",
  chat: "/chat",
  config: "/config",
  debug: "/debug",
  logs: "/logs",
};

const PATH_TO_TAB = new Map(Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as Tab]));

export function normalizeBasePath(basePath: string): string {
  if (!basePath) {
    return "";
  }
  let base = basePath.trim();
  if (!base.startsWith("/")) {
    base = `/${base}`;
  }
  if (base === "/") {
    return "";
  }
  if (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  return base;
}

export function normalizePath(path: string): string {
  if (!path) {
    return "/";
  }
  let normalized = path.trim();
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function pathForTab(tab: Tab, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  if (isAddonTab(tab)) {
    const path = `/addons/${addonTabId(tab)}`;
    return base ? `${base}${path}` : path;
  }
  const path = TAB_PATHS[tab];
  return base ? `${base}${path}` : path;
}

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
  const base = normalizeBasePath(basePath);
  let path = pathname || "/";
  if (base) {
    if (path === base) {
      path = "/";
    } else if (path.startsWith(`${base}/`)) {
      path = path.slice(base.length);
    }
  }
  let normalized = normalizePath(path).toLowerCase();
  if (normalized.endsWith("/index.html")) {
    normalized = "/";
  }
  if (normalized === "/") {
    return "chat";
  }
  const staticTab = PATH_TO_TAB.get(normalized);
  if (staticTab) {
    return staticTab;
  }
  if (normalized.startsWith("/addons/")) {
    const addonPath = normalized.slice("/addons/".length);
    const addonId = addonPath.split("/").filter(Boolean)[0] ?? "";
    if (addonId && (getAddonById(addonId) || !addonPath.includes("/"))) {
      return addonTabFor(addonId);
    }
    if (addonId) {
      return addonTabFor(addonId);
    }
  }
  return null;
}

export function inferBasePathFromPathname(pathname: string): string {
  let normalized = normalizePath(pathname);
  if (normalized.endsWith("/index.html")) {
    normalized = normalizePath(normalized.slice(0, -"/index.html".length));
  }
  if (normalized === "/") {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }
  for (let i = 0; i < segments.length; i++) {
    const candidate = `/${segments.slice(i).join("/")}`.toLowerCase();
    const isAddonRoute = candidate === "/addons" || candidate.startsWith("/addons/");
    if (PATH_TO_TAB.has(candidate) || isAddonRoute) {
      const prefix = segments.slice(0, i);
      return prefix.length ? `/${prefix.join("/")}` : "";
    }
  }
  return `/${segments.join("/")}`;
}

export function iconForTab(tab: Tab): IconName {
  if (isAddonTab(tab)) {
    const addon = getAddonById(addonTabId(tab));
    return (addon?.icon as IconName) ?? "puzzle";
  }
  switch (tab) {
    case "agents":
      return "folder";
    case "chat":
      return "messageSquare";
    case "overview":
      return "barChart";
    case "channels":
      return "link";
    case "instances":
      return "radio";
    case "sessions":
      return "fileText";
    case "usage":
      return "barChart";
    case "cron":
      return "loader";
    case "skills":
      return "zap";
    case "nodes":
      return "monitor";
    case "config":
      return "settings";
    case "debug":
      return "bug";
    case "logs":
      return "scrollText";
    default:
      return "folder";
  }
}

export function titleForTab(tab: Tab) {
  if (isAddonTab(tab)) {
    const addon = getAddonById(addonTabId(tab));
    return addon?.name ?? addonTabId(tab);
  }
  switch (tab) {
    case "agents":
      return "Agents";
    case "overview":
      return "Overview";
    case "channels":
      return "Channels";
    case "instances":
      return "Instances";
    case "sessions":
      return "Sessions";
    case "usage":
      return "Usage";
    case "cron":
      return "Cron Jobs";
    case "skills":
      return "Skills";
    case "nodes":
      return "Nodes";
    case "chat":
      return "Chat";
    case "config":
      return "Config";
    case "debug":
      return "Debug";
    case "logs":
      return "Logs";
    default:
      return "Control";
  }
}

export function subtitleForTab(tab: Tab) {
  if (isAddonTab(tab)) {
    const addon = getAddonById(addonTabId(tab));
    return addon?.description ?? "";
  }
  switch (tab) {
    case "agents":
      return "Manage agent workspaces, tools, and identities.";
    case "overview":
      return "Gateway status, entry points, and a fast health read.";
    case "channels":
      return "Manage channels and settings.";
    case "instances":
      return "Presence beacons from connected clients and nodes.";
    case "sessions":
      return "Inspect active sessions and adjust per-session defaults.";
    case "usage":
      return "";
    case "cron":
      return "Schedule wakeups and recurring agent runs.";
    case "skills":
      return "Manage skill availability and API key injection.";
    case "nodes":
      return "Paired devices, capabilities, and command exposure.";
    case "chat":
      return "Direct gateway chat session for quick interventions.";
    case "config":
      return "Edit ~/.openclaw/openclaw.json safely.";
    case "debug":
      return "Gateway snapshots, events, and manual RPC calls.";
    case "logs":
      return "Live tail of the gateway file logs.";
    default:
      return "";
  }
}

export type TabGroup = { label: string; tabs: readonly Tab[] };

export function getTabGroups(): TabGroup[] {
  const addonTabs = getRegisteredAddons().map((a) => addonTabFor(a.id));
  const groups: TabGroup[] = TAB_GROUPS.map((g) => ({
    label: g.label,
    tabs: g.tabs as readonly Tab[],
  }));
  if (addonTabs.length > 0) {
    // Insert Addons group before Settings
    const settingsIndex = groups.findIndex((g) => g.label === "Settings");
    const addonsGroup: TabGroup = { label: "Addons", tabs: addonTabs };
    if (settingsIndex >= 0) {
      groups.splice(settingsIndex, 0, addonsGroup);
    } else {
      groups.push(addonsGroup);
    }
  }
  return groups;
}
