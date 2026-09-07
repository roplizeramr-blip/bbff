import { createServer } from "node:http";
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

const PORT = Number(process.env.PORT ?? 8080);
const DEVICE_TOKEN = process.env.DEVICE_TOKEN ?? "";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";
const VERSION = "3.0.0";

if (!DEVICE_TOKEN) {
  console.warn("[security] DEVICE_TOKEN is empty; /device will reject every connection.");
}

const app = express();
let godotSocket: WebSocket | null = null;
let connectedAt = 0;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingCall>();

function constantTimeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function bearer(req: express.Request): string {
  const value = req.header("authorization") ?? "";
  return value.replace(/^Bearer\s+/i, "").trim();
}

function mcpAuthorized(req: express.Request): boolean {
  if (!MCP_AUTH_TOKEN) return true;
  return constantTimeEqual(bearer(req), MCP_AUTH_TOKEN);
}

function deviceConnected(): boolean {
  return godotSocket?.readyState === WebSocket.OPEN;
}

function callGodot(tool: string, args: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!deviceConnected() || !godotSocket) {
      reject(new Error("Godot Android is not connected. Start the Godot project and check /health."));
      return;
    }

    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Godot tool '${tool}' timed out after 180 seconds.`));
    }, 180_000);

    pending.set(id, { resolve, reject, timer });
    godotSocket.send(JSON.stringify({ id, tool, args }));
  });
}

function toolResult(value: unknown, isError = false) {
  return {
    content: [{
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
    ...(isError ? { isError: true } : {}),
  };
}

function registerRelay(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: z.ZodType,
): void {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      const result = await callGodot(name, (args ?? {}) as Record<string, unknown>);
      return toolResult(result);
    } catch (error) {
      return toolResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
    }
  });
}

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "spark-godot-game-builder", version: VERSION });

  registerRelay(server, "godot_status", "Get the connected Godot engine, project, platform and bridge status.", z.object({}));
  registerRelay(server, "project_tree", "List files and folders under the Godot project res:// directory.", z.object({ max_depth: z.number().int().min(1).max(20).optional() }));
  registerRelay(server, "search_files", "Search UTF-8 project files under res:// for a text string.", z.object({ query: z.string().min(1), max_results: z.number().int().min(1).max(200).optional() }));
  registerRelay(server, "read_file", "Read a UTF-8 file from the Godot project.", z.object({ path: z.string().min(1), max_bytes: z.number().int().min(1).max(2_000_000).optional() }));
  registerRelay(server, "write_file", "Create or replace a UTF-8 project file. Paths are relative to res://.", z.object({ path: z.string().min(1), content: z.string() }));
  registerRelay(server, "create_file", "Create a new UTF-8 project file and fail if it already exists.", z.object({ path: z.string().min(1), content: z.string() }));
  registerRelay(server, "delete_file", "Delete a project file under res://.", z.object({ path: z.string().min(1) }));
  registerRelay(server, "write_files_batch", "Create or replace many UTF-8 project files in one operation.", z.object({ files: z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1).max(500) }));
  registerRelay(server, "delete_files_batch", "Delete many project files in one operation.", z.object({ paths: z.array(z.string().min(1)).min(1).max(500) }));

  registerRelay(server, "validate_project", "Load project scripts/resources and report load failures that Godot exposes at runtime.", z.object({}));
  registerRelay(server, "get_project_settings", "Read selected Godot project settings.", z.object({ keys: z.array(z.string()).max(200).optional() }));
  registerRelay(server, "set_project_setting", "Set a Godot project setting at runtime; persistence depends on whether res:// is writable.", z.object({ key: z.string().min(1), value: z.unknown() }));
  registerRelay(server, "get_input_map", "Read the current Godot input actions.", z.object({}));
  registerRelay(server, "set_input_action", "Create/update an input action. Key events can be supplied as serialized event dictionaries.", z.object({ action: z.string().min(1), deadzone: z.number().min(0).max(1).optional(), events: z.array(z.record(z.string(), z.unknown())).optional() }));

  registerRelay(server, "get_scene_tree", "Inspect the currently running Godot scene tree.", z.object({ include_properties: z.boolean().optional() }));
  registerRelay(server, "create_node", "Create a runtime Node under a scene-tree parent.", z.object({ parent_path: z.string().min(1), node_type: z.string().min(1), node_name: z.string().min(1) }));
  registerRelay(server, "delete_node", "Delete a runtime scene-tree node.", z.object({ node_path: z.string().min(1) }));
  registerRelay(server, "duplicate_node", "Duplicate a runtime scene-tree node.", z.object({ node_path: z.string().min(1), new_name: z.string().optional() }));
  registerRelay(server, "rename_node", "Rename a runtime scene-tree node.", z.object({ node_path: z.string().min(1), new_name: z.string().min(1) }));
  registerRelay(server, "reparent_node", "Move a runtime scene-tree node under another parent.", z.object({ node_path: z.string().min(1), parent_path: z.string().min(1), keep_global_transform: z.boolean().optional() }));
  registerRelay(server, "set_node_property", "Set a runtime scene-tree property. Vector2/Vector3/Color/Transform-like values can be supplied with _type objects.", z.object({ node_path: z.string().min(1), property: z.string().min(1), value: z.unknown() }));
  registerRelay(server, "get_node_property", "Read a runtime scene-tree property.", z.object({ node_path: z.string().min(1), property: z.string().min(1) }));
  registerRelay(server, "inspect_node", "Inspect a runtime node, class, children and common properties.", z.object({ node_path: z.string().min(1) }));

  registerRelay(server, "create_scene", "Write a minimal Godot .tscn scene file with a chosen root type and name.", z.object({ path: z.string().min(1), root_type: z.string().min(1), root_name: z.string().min(1) }));
  registerRelay(server, "save_scene", "Pack and save the currently running scene to a .tscn path when the runtime environment permits writing res://.", z.object({ path: z.string().min(1) }));
  registerRelay(server, "create_script", "Create or replace a GDScript source file.", z.object({ path: z.string().min(1), content: z.string() }));

  registerRelay(server, "run_project", "Confirm that the Godot runtime is alive and report the current scene.", z.object({}));
  registerRelay(server, "stop_project", "Return runtime stop information without exposing OS/process shutdown commands.", z.object({}));
  registerRelay(server, "get_debug_errors", "Read recent bridge/runtime errors captured by the Godot agent.", z.object({}));
  registerRelay(server, "screenshot", "Capture the current Godot viewport and return a base64 PNG up to the requested byte limit.", z.object({ max_bytes: z.number().int().min(10_000).max(1_500_000).optional() }));

  return server;
}

const mcpHandler = createMcpHandler(buildMcpServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);

app.get("/", (_req, res) => {
  res.type("text/plain").send("Spark ↔ Godot Game Builder MCP Gateway v" + VERSION);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    godotConnected: deviceConnected(),
    connectedAt: connectedAt || null,
    pendingRequests: pending.size,
  });
});

app.all("/mcp", (req, res) => {
  if (!mcpAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  void nodeMcpHandler(req, res);
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/device" });

wss.on("connection", (socket, req) => {
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";

  if (!DEVICE_TOKEN || !constantTimeEqual(supplied, DEVICE_TOKEN)) {
    socket.close(1008, "Unauthorized");
    return;
  }

  if (godotSocket && godotSocket !== socket) {
    godotSocket.close(1000, "Replaced by a newer Godot connection");
  }

  godotSocket = socket;
  connectedAt = Date.now();
  console.log("[device] Godot connected");

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as {
        id?: string;
        ok?: boolean;
        result?: unknown;
        error?: string;
      };

      if (!message.id) return;
      const request = pending.get(message.id);
      if (!request) return;

      clearTimeout(request.timer);
      pending.delete(message.id);

      if (message.ok === false) {
        request.reject(new Error(message.error ?? "Godot returned an error"));
      } else {
        request.resolve(message.result ?? {});
      }
    } catch (error) {
      console.warn("[device] invalid message", error);
    }
  });

  socket.on("close", () => {
    if (godotSocket === socket) {
      godotSocket = null;
      connectedAt = 0;
      console.log("[device] Godot disconnected");

      for (const [id, request] of pending) {
        clearTimeout(request.timer);
        request.reject(new Error("Godot disconnected while the request was running."));
        pending.delete(id);
      }
    }
  });

  socket.on("error", (error) => {
    console.warn("[device] websocket error", error.message);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Spark Godot MCP v${VERSION} listening on ${PORT}`);
});
