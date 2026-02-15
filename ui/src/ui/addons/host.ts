import { html, nothing, type TemplateResult } from "lit";
import { ref, createRef, type Ref } from "lit/directives/ref.js";
import { loadAddonElement } from "./loader.ts";
import { getAddonById } from "./registry.ts";
import type { AddonContext, AddonDefinition } from "./types.ts";

type AddonHostState = {
  addonId: string;
  status: "loading" | "loaded" | "error";
  error?: string;
  element?: HTMLElement;
  containerRef: Ref<HTMLDivElement>;
};

const hostStates = new Map<string, AddonHostState>();

function getOrCreateHostState(addonId: string): AddonHostState {
  let state = hostStates.get(addonId);
  if (!state) {
    state = { addonId, status: "loading", containerRef: createRef() };
    hostStates.set(addonId, state);
  }
  return state;
}

export function renderAddonHost(params: {
  addonId: string;
  context: AddonContext;
  onStateChange: () => void;
}): TemplateResult | typeof nothing {
  const { addonId, context, onStateChange } = params;
  const addon = getAddonById(addonId);
  if (!addon) {
    return html`<div class="addon-host addon-host--error">
      <p>Addon not found: <code>${addonId}</code></p>
    </div>`;
  }

  const state = getOrCreateHostState(addonId);

  if (state.status === "error") {
    return html`<div class="addon-host addon-host--error">
      <p>Failed to load addon: <code>${addon.name}</code></p>
      <p class="addon-host__detail">${state.error}</p>
    </div>`;
  }

  if (state.status === "loading") {
    void loadAndMount(addon, state, context, onStateChange);
    return html`<div class="addon-host addon-host--loading">
      <p>Loading ${addon.name}...</p>
    </div>`;
  }

  // status === "loaded" — render the container; ref callback handles mounting
  return html`<div class="addon-host addon-host--loaded">
    <div ${ref(state.containerRef)} class="addon-host__container"></div>
  </div>`;
}

export function ensureAddonMounted(addonId: string, context: AddonContext): void {
  const state = hostStates.get(addonId);
  if (!state || state.status !== "loaded") {
    return;
  }
  const container = state.containerRef.value;
  if (!container) {
    return;
  }
  const tagName = `openclaw-addon-${addonId}`;
  const existing = container.querySelector(tagName);
  if (existing) {
    passContext(existing as HTMLElement, context);
    return;
  }
  const el = document.createElement(tagName);
  passContext(el, context);
  container.appendChild(el);
  state.element = el;
}

function passContext(el: HTMLElement, context: AddonContext): void {
  const target = el as HTMLElement & {
    context?: AddonContext;
    setContext?: (ctx: AddonContext) => void;
  };
  if (typeof target.setContext === "function") {
    target.setContext(context);
  } else {
    target.context = context;
  }
}

async function loadAndMount(
  addon: AddonDefinition,
  state: AddonHostState,
  context: AddonContext,
  onStateChange: () => void,
): Promise<void> {
  const result = await loadAddonElement(addon, context.basePath);
  if ("error" in result) {
    state.status = "error";
    state.error = result.error;
    onStateChange();
    return;
  }

  const ElementClass = result.element;
  const tagName = `openclaw-addon-${addon.id}`;

  if (!customElements.get(tagName)) {
    try {
      customElements.define(tagName, ElementClass);
    } catch (e) {
      state.status = "error";
      state.error = `failed to register custom element: ${String(e)}`;
      onStateChange();
      return;
    }
  }

  state.status = "loaded";
  state.element = undefined;
  onStateChange();
}

export function updateAddonContext(addonId: string, context: AddonContext): void {
  const state = hostStates.get(addonId);
  if (state?.element) {
    passContext(state.element, context);
  }
}

export function unmountAddon(addonId: string): void {
  const state = hostStates.get(addonId);
  if (state?.element) {
    state.element.remove();
    state.element = undefined;
  }
  hostStates.delete(addonId);
}
