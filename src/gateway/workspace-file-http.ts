import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { authorizeGatewayConnect, isLocalDirectRequest, type ResolvedGatewayAuth } from "./auth.js";
import { sendGatewayAuthFailure } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

const WORKSPACE_FILE_PATH = "/__openclaw__/workspace/file";

/** Max file size served via this endpoint (10 MB). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function handleWorkspaceFileHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies: string[];
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== WORKSPACE_FILE_PATH) {
    return false;
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  // Auth: local loopback connections are allowed without token;
  // remote connections require the gateway bearer token.
  const isLocal = isLocalDirectRequest(req, opts.trustedProxies);
  if (!isLocal) {
    const token = getBearerToken(req);
    const authResult = await authorizeGatewayConnect({
      auth: opts.auth,
      connectAuth: token ? { token, password: token } : null,
      req,
      trustedProxies: opts.trustedProxies,
      rateLimiter: opts.rateLimiter,
    });
    if (!authResult.ok) {
      sendGatewayAuthFailure(res, authResult);
      return true;
    }
  }

  const filePath = url.searchParams.get("path");
  if (!filePath || !filePath.trim()) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Missing required query parameter: path" }));
    return true;
  }

  const cfg = loadConfig();
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveUserPath(resolveAgentWorkspaceDir(cfg, defaultAgentId));
  const resolvedWorkspace = path.resolve(workspaceDir);

  // Accept both absolute paths (must be inside workspace) and relative paths (resolved against workspace).
  const resolvedFile = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(resolvedWorkspace, filePath);

  // Security: ensure the resolved path stays inside the workspace.
  if (
    !resolvedFile.startsWith(resolvedWorkspace + path.sep) &&
    resolvedFile !== resolvedWorkspace
  ) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Path is outside the agent workspace" }));
    return true;
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolvedFile);
  } catch {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "File not found" }));
    return true;
  }

  if (!stat.isFile()) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Path is not a file" }));
    return true;
  }

  if (stat.size > MAX_FILE_BYTES) {
    res.statusCode = 413;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: `File too large (max ${MAX_FILE_BYTES} bytes)` }));
    return true;
  }

  const ext = path.extname(resolvedFile).slice(1).toLowerCase();
  const isTextLike = isTextExtension(ext);
  const isBinaryImage = isBinaryImageExtension(ext);
  const relativePath = path.relative(resolvedWorkspace, resolvedFile);

  if (isTextLike) {
    let content: string;
    try {
      content = await fs.readFile(resolvedFile, "utf8");
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "Failed to read file" }));
      return true;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, content, encoding: "utf8", size: stat.size, relativePath }));
    return true;
  }

  if (isBinaryImage) {
    let buf: Buffer;
    try {
      buf = await fs.readFile(resolvedFile);
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "Failed to read file" }));
      return true;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: true,
        content: buf.toString("base64"),
        encoding: "base64",
        size: stat.size,
        relativePath,
      }),
    );
    return true;
  }

  // Not previewable — return metadata only.
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({ ok: true, content: null, encoding: null, size: stat.size, relativePath }),
  );
  return true;
}

const TEXT_EXTENSIONS = new Set([
  "txt",
  "log",
  "csv",
  "tsv",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "sh",
  "bash",
  "zsh",
  "fish",
  "json",
  "jsonl",
  "ndjson",
  "js",
  "mjs",
  "cjs",
  "ts",
  "jsx",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "php",
  "swift",
  "kt",
  "sql",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  "astro",
  "diff",
  "patch",
  "conf",
  "config",
  "lock",
  "md",
  "mdx",
  "markdown",
]);

const BINARY_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
]);

function isTextExtension(ext: string): boolean {
  return TEXT_EXTENSIONS.has(ext);
}

function isBinaryImageExtension(ext: string): boolean {
  return BINARY_IMAGE_EXTENSIONS.has(ext);
}
