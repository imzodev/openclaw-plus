---
summary: "UI addons: custom panels in the Control UI served by the Gateway"
read_when:
  - You want to add a custom panel or dashboard to the Control UI
  - You are building or installing a UI addon
  - You want to extend the Control UI with your own web components
title: "UI Addons"
---

# UI Addons

UI addons are small web modules that add **custom tabs** to the
[Control UI](/web/control-ui). Each addon ships as a directory with a manifest
and a JavaScript entry file. The Gateway discovers addons at startup, serves
their files over HTTP, and the Control UI loads them dynamically as Web
Components.

Use addons when you want a custom dashboard, monitoring panel, or interactive
tool inside the Control UI without modifying core code.

## Quick start

1. Create an addon directory under `~/.openclaw/addons/<id>/`:

```bash
mkdir -p ~/.openclaw/addons/hello-world
```

2. Add a manifest (`addon.json`):

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "description": "A sample addon panel.",
  "version": "0.1.0",
  "icon": "puzzle",
  "entry": "index.js"
}
```

3. Add an entry file (`index.js`):

```js
class HelloWorldAddon extends HTMLElement {
  connectedCallback() {
    const shadow = this.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <div style="padding: 2rem; font-family: system-ui;">
        <h2>Hello World</h2>
        <p>Addon loaded successfully.</p>
      </div>
    `;
  }

  setContext(ctx) {
    // ctx.client  — Gateway WebSocket client
    // ctx.theme   — "light" or "dark"
    // ctx.agentId — current agent id (or null)
    console.log("addon context:", Object.keys(ctx));
  }
}

export default HelloWorldAddon;
```

4. Restart the Gateway. The addon appears as a new tab under the **Addons**
   group in the Control UI sidebar.

## Addon manifest (addon.json)

Every addon directory must contain an `addon.json` file.

Required fields:

- `id` (string): unique addon identifier. Lowercase alphanumeric, hyphens,
  underscores, and dots only (e.g. `my-addon`, `dashboard.v2`).

Optional fields:

- `name` (string): display name shown in the sidebar tab. Defaults to the id.
- `description` (string): short description shown as the tab subtitle.
- `version` (string): informational version string.
- `icon` (string): icon name from the Lucide icon set (e.g. `"puzzle"`,
  `"bar-chart"`, `"settings"`). Defaults to `"puzzle"`.
- `entry` (string): path to the JavaScript entry file, relative to the addon
  directory. Defaults to `index.js`.

Example:

```json
{
  "id": "system-monitor",
  "name": "System Monitor",
  "description": "Live CPU, memory, and disk usage.",
  "version": "1.0.0",
  "icon": "activity",
  "entry": "monitor.js"
}
```

## Discovery

The Gateway scans two locations for addon directories at startup:

1. **Global addons**: `~/.openclaw/addons/<id>/`
2. **Workspace addons**: `<workspace>/.openclaw/addons/<id>/`

Workspace addons take precedence over global addons with the same id.

Each subdirectory must contain a valid `addon.json`. Directories without a
manifest (or with an invalid one) are skipped with a diagnostic warning.
Hidden directories (starting with `.`) are ignored.

Discovery runs once at Gateway startup. To pick up new or changed addons,
restart the Gateway.

## Entry file

The entry file must export an `HTMLElement` subclass as its **default export**.
The Control UI registers it as a custom element and mounts it when the user
navigates to the addon tab.

```js
export default class MyAddon extends HTMLElement {
  connectedCallback() {
    // Called when the element is added to the DOM.
    // Use Shadow DOM for style isolation:
    const shadow = this.attachShadow({ mode: "open" });
    shadow.innerHTML = `<p>Hello from my addon</p>`;
  }

  setContext(ctx) {
    // Called with the addon context object.
    // Use this to access the Gateway client, theme, etc.
  }

  disconnectedCallback() {
    // Called when the element is removed. Clean up timers, listeners, etc.
  }
}
```

### Context object

The `setContext(ctx)` method (if defined) receives an object with:

| Property   | Type           | Description                                                              |
| ---------- | -------------- | ------------------------------------------------------------------------ |
| `client`   | object         | Gateway WebSocket client (call `client.request(method, params)` for RPC) |
| `theme`    | string         | Current UI theme: `"light"` or `"dark"`                                  |
| `agentId`  | string or null | Currently selected agent id                                              |
| `basePath` | string         | Control UI base path (usually `""`)                                      |
| `navigate` | function       | Navigate to another tab (e.g. `navigate("chat")`)                        |

Alternatively, the context is also set as a `.context` property on the element.

### Calling Gateway methods

Use `ctx.client.request(method, params)` to call any Gateway RPC method:

```js
setContext(ctx) {
  this._client = ctx.client;
  this.loadData();
}

async loadData() {
  const result = await this._client.request("health");
  console.log("Gateway health:", result);
}
```

See [Gateway protocol](/gateway/protocol) for available methods.

## HTTP serving

Addon files are served at:

```
http://<gateway>:18789/__openclaw__/addons/<addon-id>/<file>
```

Requests require Gateway authentication (same as the Control UI). Security
headers (`X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff`) are applied to all addon responses.

Path traversal is blocked; only files within the addon directory are served.

## Navigation

When addons are discovered, the Control UI sidebar shows an **Addons** group
(between the Agent and Settings groups) with one tab per addon. Each tab
displays the addon name and icon from the manifest.

Addon tabs route to `/addons/<addon-id>` in the browser URL.

If no addons are discovered, the Addons group is hidden.

## Gateway RPC

### addons.list

Returns all discovered addons:

```json
{
  "addons": [
    {
      "id": "hello-world",
      "name": "Hello World",
      "description": "A sample addon panel.",
      "version": "0.1.0",
      "icon": "puzzle",
      "entry": "index.js",
      "origin": "global",
      "enabled": true,
      "status": "loaded"
    }
  ]
}
```

### addons.create

Create a new addon programmatically. Writes `addon.json` and the entry file to
the global addons directory, then refreshes the registry so the addon is
available immediately.

Parameters:

| Parameter     | Type   | Required | Description                                           |
| ------------- | ------ | -------- | ----------------------------------------------------- |
| `id`          | string | yes      | Unique addon id (lowercase, hyphens/dots/underscores) |
| `code`        | string | yes      | JavaScript source for the entry file                  |
| `name`        | string | no       | Display name (defaults to id)                         |
| `description` | string | no       | Short description for the sidebar                     |
| `icon`        | string | no       | Lucide icon name (defaults to `"puzzle"`)             |
| `version`     | string | no       | Version string (defaults to `"0.1.0"`)                |

Example request:

```json
{
  "method": "addons.create",
  "params": {
    "id": "my-dashboard",
    "name": "My Dashboard",
    "description": "Custom monitoring panel.",
    "icon": "bar-chart",
    "code": "export default class MyDashboard extends HTMLElement {\n  connectedCallback() {\n    const shadow = this.attachShadow({ mode: 'open' });\n    shadow.innerHTML = '<p>Hello from my addon</p>';\n  }\n}"
  }
}
```

### addons.delete

Remove an addon by id. Deletes the addon directory and refreshes the registry.

Parameters:

| Parameter | Type   | Required | Description        |
| --------- | ------ | -------- | ------------------ |
| `id`      | string | yes      | Addon id to delete |

## Agent tool

The agent has a built-in `ui_addon` tool that wraps these RPC methods. When you
ask the agent to build a dashboard, panel, or interactive UI, it uses this tool
to create an addon that appears as a tab in the Control UI.

The agent can also use `ctx.client.request(method, params)` inside the addon
code to call any Gateway RPC method, enabling addons that communicate with the
backend (e.g. fetching session data, sending messages, or querying health).

## Tips

- Use **Shadow DOM** for style isolation so addon styles don't leak into the
  Control UI (and vice versa).
- Addons handle their own data loading. The Control UI does not pre-fetch any
  data for addon tabs.
- Keep entry files self-contained or use relative imports. The entry URL is the
  base for any `import` statements inside the module.
- For complex addons, bundle your code into a single file (e.g. with esbuild or
  Vite library mode) to avoid multiple HTTP round-trips.
- Test your addon by opening the Control UI and navigating to the addon tab.
  Check the browser console for errors.

## Differences from plugins

| Feature      | Plugins                                    | UI Addons                         |
| ------------ | ------------------------------------------ | --------------------------------- |
| Runs where   | In-process with the Gateway                | In the browser (Control UI)       |
| Language     | TypeScript (loaded via jiti)               | JavaScript (ES modules)           |
| Can register | RPC methods, tools, CLI commands, channels | Custom UI tabs only               |
| Config       | `plugins.entries.<id>.config`              | None (addons manage own state)    |
| Discovery    | Extensions dirs + config paths             | `~/.openclaw/addons/` + workspace |
| Manifest     | `openclaw.plugin.json`                     | `addon.json`                      |

Use **plugins** when you need server-side logic (tools, RPC, channels). Use
**addons** when you need a custom UI panel that talks to the Gateway via
existing RPC methods.
