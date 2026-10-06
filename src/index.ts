#!/usr/bin/env node
/**
 * HookSense MCP Server
 *
 * The webhook & callback layer for AI agents, as MCP tools: create a callback
 * URL, wait_for_callback to block until the webhook lands (decrypted) instead of polling, verify signatures, and list/replay
 * callbacks — all from inside the agent session (Claude Desktop, Cursor,
 * Claude Code, Continue, etc.).
 *
 * Usage:
 *   HOOKSENSE_TOKEN=hsk_xxx npx @hooksense/mcp
 *
 * Environment:
 *   HOOKSENSE_TOKEN — API token from /account/tokens. Required to CALL tools;
 *                     the server still starts and lists its tools without it
 *                     (so registries/catalogs can introspect it).
 *   HOOKSENSE_API   — optional, defaults to https://hooksense.com
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const TOKEN = process.env.HOOKSENSE_TOKEN;
const API_BASE = (process.env.HOOKSENSE_API || "https://hooksense.com").replace(/\/$/, "");

// The token is required to CALL a tool, but not to start the server or list
// its tools — that lets MCP registries/catalogs (Glama, etc.) introspect the
// server without credentials. Missing-token is surfaced per tool call below.

interface ApiOptions {
  method?: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  if (!TOKEN) {
    throw new Error(
      "HOOKSENSE_TOKEN is not set. Create a token at https://hooksense.com/account/tokens " +
        "and add it to your MCP client config.",
    );
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    ...(opts.headers ?? {}),
  };
  const body = opts.body ? JSON.stringify(opts.body) : undefined;

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await fetch(`${API_BASE}${path}`, { method: opts.method, headers, body, signal });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const errMsg =
      (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : null) ?? `HTTP ${res.status}`;
    throw new Error(`${errMsg} (${res.status})`);
  }
  return parsed as T;
}

// ── Tool definitions ────────────────────────────────────────────────────────

const tools: Tool[] = [
  {
    name: "list_endpoints",
    description:
      "List all webhook endpoints owned by the authenticated user. Returns slug, createdAt, and request counts.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "create_callback_endpoint",
    description:
      "Create a callback endpoint and return its URL. Hand this URL to a long-running/async job (or another agent) as its webhook/callback target, then await the result with wait_for_callback, passing the returned after timestamp so callbacks that arrive before waiting are not missed. Also works as a plain webhook capture URL for any provider (Stripe, GitHub, …).",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "Optional human-readable slug (3-32 chars, letters/numbers/hyphens). Requires Hook plan or above. Auto-generated if omitted.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_callbacks",
    description:
      "List callbacks received by an endpoint, newest first. Returns captured requests including their bodies and metadata. Tip: read the newest `receivedAt` and pass it as `after` to wait_for_callback to wait only for what comes next.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Endpoint slug (e.g. 'stripe-prod')" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max callbacks to return (1-100, default 20)" },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "get_callback_payload",
    description:
      "Fetch a single received callback with full headers, decrypted body, and metadata. Use this to read the result of an async job after wait_for_callback or list_callbacks gives you a callback id.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Callback UUID, from wait_for_callback or list_callbacks" },
      },
      required: ["requestId"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_signature",
    description:
      "Verify the HMAC signature of a received callback against the endpoint's configured secret (Stripe, GitHub, Shopify, or custom), using a timing-safe comparison. Returns whether the callback is authentic and untampered — call this before your agent acts on a payload. Requires the endpoint to have a webhook secret configured and a paid plan.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Endpoint slug the callback belongs to" },
        requestId: { type: "string", description: "Callback UUID to verify" },
      },
      required: ["slug", "requestId"],
      additionalProperties: false,
    },
  },
  {
    name: "replay_callback",
    description:
      "Replay a received callback to a target URL. The original method and body are re-sent, with unsafe transport headers filtered — useful to re-drive your handler against a known payload without re-triggering the upstream event.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Callback UUID to replay" },
        targetUrl: {
          type: "string",
          description: "Public HTTP(S) target reachable by the HookSense server. Localhost/private addresses are blocked; use the HookSense CLI for local replay.",
        },
      },
      required: ["requestId", "targetUrl"],
      additionalProperties: false,
    },
  },
  {
    name: "get_endpoint",
    description:
      "Get details about a specific endpoint — its full URL, signature provider config, and custom response settings.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Endpoint slug" },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_for_callback",
    description:
      "Block until the next webhook (callback) arrives at an endpoint, then return it — instead of polling. Receipt alone does not prove a valid signature. Use this for async/long-running work: kick off the job with the endpoint URL as its callback, then call wait_for_callback to receive the result the moment it lands (decrypted; inspect signatureVerification when present or call verify_signature). Returns { status: 'received', request } on delivery, or { status: 'pending' } if `timeoutMs` elapses first (just call again to keep waiting). Pass `after` (the receivedAt of the last callback you saw) so a callback that arrived between calls is returned immediately rather than missed.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Endpoint slug to wait on (from create_callback_endpoint)" },
        timeoutMs: {
          type: "integer", minimum: 1000, maximum: 60000,
          description: "How long to block before returning 'pending' (1000–60000, default 30000).",
        },
        after: {
          type: "string",
          description:
            "Optional ISO timestamp cursor. Any callback received after this is returned immediately without blocking — pass the previous callback's receivedAt to avoid missing one between calls.",
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
];

// ── Tool implementations ────────────────────────────────────────────────────

async function handleTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const tool = tools.find((tool) => tool.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  for (const key of tool.inputSchema.required ?? []) {
    if (typeof args[key] !== "string" || !(args[key] as string).trim()) throw new Error(`${key} is required`);
  }
  for (const [key, value] of Object.entries(args)) {
    const definition = tool.inputSchema.properties?.[key] as { type?: string; minimum?: number; maximum?: number } | undefined;
    if (!definition) throw new Error(`Unknown argument: ${key}`);
    if (definition.type === "string" && typeof value !== "string") throw new Error(`${key} must be a string`);
    if (definition.type === "integer" && (typeof value !== "number" || !Number.isInteger(value) || value < definition.minimum! || value > definition.maximum!)) throw new Error(`${key} must be an integer from ${definition.minimum} to ${definition.maximum}`);
  }
  if (args.after && !Number.isFinite(Date.parse(String(args.after)))) throw new Error("after must be an ISO timestamp");
  if (args.slug && !/^[a-zA-Z0-9-]{3,32}$/.test(String(args.slug))) throw new Error("slug must be 3–32 letters, numbers, or hyphens");
  const request = <T = unknown>(path: string, options: ApiOptions = {}) => api<T>(path, { ...options, signal });
  switch (name) {
    case "list_endpoints": {
      const data = await request<{ endpoints: unknown[] }>("/api/endpoints");
      return JSON.stringify(data, null, 2);
    }

    case "create_callback_endpoint": {
      let data = await request<{ slug: string; createdAt: string }>("/api/endpoints", {
        method: "POST",
        body: {},
      });
      if (args.slug) {
        try {
          data = await request<typeof data>(`/api/endpoints/${encodeURIComponent(data.slug)}`, {
            method: "PATCH", body: { slug: String(args.slug).toLowerCase() },
          });
        } catch (error) {
          throw new Error(`Endpoint ${data.slug} was created, but renaming failed: ${error instanceof Error ? error.message : error}. Reuse this endpoint instead of creating another.`);
        }
      }
      const url = `${API_BASE}/w/${data.slug}`;
      return JSON.stringify({ ...data, after: data.createdAt, callbackUrl: url, viewInDashboard: `${API_BASE}/endpoint/${data.slug}` }, null, 2);
    }

    case "list_callbacks": {
      const slug = String(args.slug);
      const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 100) : 20;
      const data = await request(`/api/endpoints/${encodeURIComponent(slug)}/requests?limit=${limit}`);
      return JSON.stringify(data, null, 2);
    }

    case "get_callback_payload": {
      const data = await request(`/api/requests/${encodeURIComponent(String(args.requestId))}`);
      return JSON.stringify(data, null, 2);
    }

    case "verify_signature": {
      const slug = encodeURIComponent(String(args.slug));
      const requestId = encodeURIComponent(String(args.requestId));
      const data = await request(`/api/endpoints/${slug}/verify/${requestId}`);
      return JSON.stringify(data, null, 2);
    }

    case "replay_callback": {
      const data = await request(`/api/requests/${encodeURIComponent(String(args.requestId))}/replay`, {
        method: "POST",
        body: { targetUrl: String(args.targetUrl) },
      });
      return JSON.stringify(data, null, 2);
    }

    case "get_endpoint": {
      const data = await request(`/api/endpoints/${encodeURIComponent(String(args.slug))}`);
      return JSON.stringify(data, null, 2);
    }

    case "wait_for_callback": {
      const slug = encodeURIComponent(String(args.slug));
      const qs = new URLSearchParams();
      if (typeof args.timeoutMs === "number") {
        qs.set("timeout", String(Math.min(60_000, Math.max(1_000, args.timeoutMs))));
      }
      if (typeof args.after === "string" && args.after) qs.set("after", args.after);
      const query = qs.toString();
      const data = await request(`/api/endpoints/${slug}/wait${query ? `?${query}` : ""}`, { timeoutMs: (typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000) + 5_000 });
      return JSON.stringify(data, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Server setup ────────────────────────────────────────────────────────────

const server = new Server(
  { name: "hooksense", version: "0.2.2" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args } = req.params;
  try {
    const text = await handleTool(name, (args ?? {}) as Record<string, unknown>, extra.signal);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`hooksense-mcp v0.2.2 listening on stdio (api: ${API_BASE})\n`);
