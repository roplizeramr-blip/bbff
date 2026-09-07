import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const PORT = Number(process.env.PORT ?? 8080);
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";
const DEVICE_TOKEN = process.env.DEVICE_TOKEN ?? "";
const app = express();
let godotSocket: WebSocket | null = null;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

function authorized(req: express.Request): boolean {
  if (!MCP_AUTH_TOKEN) return true;
  const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return token === MCP_AUTH_TOKEN;
}

function callGodot(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!godotSocket || godotSocket.readyState !== WebSocket.OPEN) {
      reject(new Error("Godot Android is not connected")); return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Godot request timed out")); }, 120_000);
    pending.set(id, { resolve, reject, timer });
    godotSocket.send(JSON.stringify({ id, tool, args }));
  });
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function relay(server: McpServer, name: string, description: string, inputSchema: any) {
  server.registerTool(name, { description, inputSchema }, async (args: any) => {
    try { return textResult(await callGodot(name, args ?? {})); }
    catch (e: any) { return textResult({ ok: false, error: e?.message ?? "Godot error" }); }
  });
}

function buildServer() {
  const s = new McpServer({ name: "spark-godot-builder", version: "2.0.0" }, { capabilities: { tools: {} } });

  relay(s, "godot_status", "Get Godot Android connection, project name, engine version and platform.", z.object({}));
  relay(s, "project_tree", "List the Godot project tree.", z.object({}));
  relay(s, "search_files", "Search project text files for a string.", z.object({ query: z.string() }));
  relay(s, "read_file", "Read a UTF-8 file inside res://.", z.object({ path: z.string() }));
  relay(s, "write_file", "Create or replace a UTF-8 project file inside res://.", z.object({ path: z.string(), content: z.string() }));
  relay(s, "create_file", "Create a UTF-8 project file inside res://.", z.object({ path: z.string(), content: z.string() }));
  relay(s, "delete_file", "Delete a project file inside res://.", z.object({ path: z.string() }));
  relay(s, "write_files_batch", "Write many project files atomically in one bridge round trip. Use this for game generation.", z.object({ files: z.array(z.object({ path: z.string(), content: z.string() })).min(1).max(500) }));
  relay(s, "delete_files_batch", "Delete many project files in one bridge round trip.", z.object({ paths: z.array(z.string()).min(1).max(500) }));
  relay(s, "validate_project", "Load project GDScripts to detect parse/load failures after a build step.", z.object({}));
  relay(s, "get_project_settings", "Read key Godot project settings.", z.object({}));
  relay(s, "set_project_setting", "Set a Godot project setting.", z.object({ key: z.string(), value: z.unknown() }));
  relay(s, "get_input_map", "Read configured input actions.", z.object({}));
  relay(s, "set_input_action", "Create or update an input action.", z.object({ action: z.string(), deadzone: z.number().optional() }));
  relay(s, "get_scene_tree", "Inspect the active runtime scene tree.", z.object({}));
  relay(s, "create_node", "Create a runtime node under a parent path.", z.object({ parent_path: z.string(), node_type: z.string(), node_name: z.string() }));
  relay(s, "delete_node", "Delete a runtime node.", z.object({ node_path: z.string() }));
  relay(s, "duplicate_node", "Duplicate a runtime node.", z.object({ node_path: z.string(), new_name: z.string() }));
  relay(s, "rename_node", "Rename a runtime node.", z.object({ node_path: z.string(), new_name: z.string() }));
  relay(s, "reparent_node", "Reparent a runtime node.", z.object({ node_path: z.string(), parent_path: z.string() }));
  relay(s, "set_node_property", "Set a runtime node property.", z.object({ node_path: z.string(), property: z.string(), value: z.unknown() }));
  relay(s, "get_node_property", "Get a runtime node property.", z.object({ node_path: z.string(), property: z.string() }));
  relay(s, "inspect_node", "Inspect a runtime node and its properties.", z.object({ node_path: z.string() }));
  relay(s, "create_scene", "Create a simple .tscn scene file/runtime scene.", z.object({ path: z.string(), root_type: z.string(), root_name: z.string() }));
  relay(s, "save_scene", "Save the active runtime scene to a .tscn path when supported.", z.object({ path: z.string() }));
  relay(s, "create_script", "Create a GDScript file.", z.object({ path: z.string(), content: z.string() }));
  relay(s, "run_project", "Check that the Godot runtime is alive.", z.object({}));
  relay(s, "stop_project", "Return safe runtime stop status; host shutdown is not exposed.", z.object({}));
  relay(s, "get_debug_errors", "Read recent Godot agent/runtime errors.", z.object({}));
  relay(s, "screenshot", "Capture a screenshot from the running Godot app.", z.object({}));

  return s;
}

const mcpHandler = createMcpHandler(buildServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);

app.get("/", (_req, res) => res.type("text").send("Spark ↔ Godot Game Builder MCP Gateway"));
app.get("/health", (_req, res) => res.json({ ok: true, godotConnected: godotSocket?.readyState === WebSocket.OPEN, version: "2.0.0" }));
app.all("/mcp", (req, res) => {
  if (!authorized(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  void nodeMcpHandler(req, res);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/device" });
wss.on("connection", (ws, req) => {
  const auth = req.headers.authorization ?? "";
  if (!DEVICE_TOKEN || auth !== `Bearer ${DEVICE_TOKEN}`) { ws.close(1008, "Unauthorized"); return; }
  if (godotSocket) godotSocket.close(1000, "Replaced by new device");
  godotSocket = ws;
  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      const p = pending.get(msg.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(msg.id);
      msg.ok === false ? p.reject(new Error(msg.error ?? "Godot error")) : p.resolve(msg.result ?? {});
    } catch { /* ignore malformed device frames */ }
  });
  ws.on("close", () => { if (godotSocket === ws) godotSocket = null; });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Spark Godot MCP listening on ${PORT}`));
