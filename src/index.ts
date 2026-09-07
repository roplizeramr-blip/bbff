import express, { Request, Response } from "express";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

const PORT = Number(process.env.PORT ?? 8080);
const DEVICE_TOKEN = process.env.DEVICE_TOKEN ?? "";

type JsonObject = Record<string, unknown>;
type DeviceCommand = { id?: string; method?: string; params?: JsonObject };

let godotSocket: WebSocket | null = null;
let lastGodotSeen = 0;

const app = express();
app.use(express.json({ limit: "2mb" }));

function authOk(req: Request): boolean {
  const h = req.header("authorization") ?? "";
  return !!DEVICE_TOKEN && h === `Bearer ${DEVICE_TOKEN}`;
}

function sendToGodot(message: DeviceCommand): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    if (!godotSocket || godotSocket.readyState !== WebSocket.OPEN) {
      reject(new Error("Godot device is not connected"));
      return;
    }
    const id = String(message.id ?? crypto.randomUUID());
    const timeout = setTimeout(() => reject(new Error("Godot command timeout")), 30000);
    const listener = (data: WebSocket.RawData) => {
      try {
        const payload = JSON.parse(data.toString()) as JsonObject;
        if (String(payload.id ?? "") !== id) return;
        clearTimeout(timeout);
        godotSocket?.off("message", listener);
        resolve(payload);
      } catch {}
    };
    godotSocket.once("message", listener);
    godotSocket.send(JSON.stringify({ ...message, id }));
  });
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const mcpHandler = createMcpHandler(() => {
  const server = new McpServer(
    { name: "spark-godot-bridge", version: "4.3.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool("godot_status", {
    description: "Get the live Godot Android agent status.",
    inputSchema: z.object({})
  }, async () => textResult(JSON.stringify({
    connected: !!godotSocket && godotSocket.readyState === WebSocket.OPEN,
    lastSeen: lastGodotSeen,
    platform: "godot-android"
  })));

  server.registerTool("project_tree", {
    description: "List the Godot project tree via the connected agent.",
    inputSchema: z.object({
      path: z.string().default("res://").describe("res:// path")
    })
  }, async ({ path = "res://" }) => {
    const result = await sendToGodot({ method: "project_tree", params: { path } });
    return textResult(JSON.stringify(result));
  });

  server.registerTool("read_file", {
    description: "Read a text file inside the Godot project.",
    inputSchema: z.object({
      path: z.string().describe("res:// path")
    })
  }, async ({ path }) => {
    const result = await sendToGodot({ method: "read_file", params: { path } });
    return textResult(JSON.stringify(result));
  });

  server.registerTool("write_file", {
    description: "Write or replace a text file inside the Godot project.",
    inputSchema: z.object({
      path: z.string().describe("res:// path"),
      content: z.string().describe("file contents")
    })
  }, async ({ path, content }) => {
    const result = await sendToGodot({ method: "write_file", params: { path, content } });
    return textResult(JSON.stringify(result));
  });

  server.registerTool("write_files_batch", {
    description: "Create or replace many project text files in one operation.",
    inputSchema: z.object({
      files: z.array(z.object({
        path: z.string(),
        content: z.string()
      })).describe("Array of {path,content}")
    })
  }, async ({ files }) => {
    const result = await sendToGodot({ method: "write_files_batch", params: { files } });
    return textResult(JSON.stringify(result));
  });

  server.registerTool("search_files", {
    description: "Search project text files for a string.",
    inputSchema: z.object({
      query: z.string(),
      root: z.string().default("res://").describe("res:// path")
    })
  }, async ({ query, root = "res://" }) => {
    const result = await sendToGodot({ method: "search_files", params: { query, root } });
    return textResult(JSON.stringify(result));
  });

  server.registerTool("create_scene", {
    description: "Create a .tscn scene file from a scene definition.",
    inputSchema: z.object({
      path: z.string(),
      root_type: z.string().default("Node2D"),
      root_name: z.string().default("Main")
    })
  }, async (params) => {
    const result = await sendToGodot({ method: "create_scene", params: params as JsonObject });
    return textResult(JSON.stringify(result));
  });

  server.registerTool("create_node", {
    description: "Create a node in an existing scene.",
    inputSchema: z.object({
      scene: z.string(),
      parent: z.string().default("."),
      type: z.string(),
      name: z.string()
    })
  }, async (params) => {
    const result = await sendToGodot({ method: "create_node", params: params as JsonObject });
    return textResult(JSON.stringify(result));
  });

  server.registerTool("set_node_property", {
    description: "Set a node property in an editable scene.",
    inputSchema: z.object({
      scene: z.string(),
      node: z.string(),
      property: z.string(),
      value: z.unknown()
    })
  }, async (params) => {
    const result = await sendToGodot({ method: "set_node_property", params: params as JsonObject });
    return textResult(JSON.stringify(result));
  });

  server.registerTool("run_project", {
    description: "Ask the Godot Android agent to start the configured project test workflow.",
    inputSchema: z.object({})
  }, async () => {
    const result = await sendToGodot({ method: "run_project", params: {} });
    return textResult(JSON.stringify(result));
  });

  server.registerTool("get_debug_errors", {
    description: "Get recent Godot runtime/editor errors collected by the agent.",
    inputSchema: z.object({})
  }, async () => {
    const result = await sendToGodot({ method: "get_debug_errors", params: {} });
    return textResult(JSON.stringify(result));
  });

  server.registerTool("screenshot", {
    description: "Capture a screenshot from the Godot runtime if supported by the agent.",
    inputSchema: z.object({})
  }, async () => {
    const result = await sendToGodot({ method: "screenshot", params: {} });
    return textResult(JSON.stringify(result));
  });

  return server;
});

const mcpNodeHandler = toNodeHandler(mcpHandler);

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    godotConnected: !!godotSocket && godotSocket.readyState === WebSocket.OPEN,
    version: "4.3.0",
    lastGodotSeen
  });
});

app.get("/", (_req: Request, res: Response) => {
  res.type("text/plain").send("Spark Godot MCP Bridge 4.3.0");
});

app.all("/mcp", (req: Request, res: Response) => {
  mcpNodeHandler(req, res);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/device") {
    socket.destroy();
    return;
  }
  const auth = req.headers.authorization ?? "";
  if (!DEVICE_TOKEN || auth !== `Bearer ${DEVICE_TOKEN}`) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", ws => {
  if (godotSocket && godotSocket.readyState === WebSocket.OPEN) {
    godotSocket.close(4000, "replaced by a new device connection");
  }
  godotSocket = ws;
  lastGodotSeen = Date.now();

  ws.on("message", data => {
    lastGodotSeen = Date.now();
    console.log("[Godot]", data.toString());
  });

  ws.on("close", () => {
    if (godotSocket === ws) godotSocket = null;
  });

  ws.on("error", err => console.error("[Godot WS]", err));

  ws.send(JSON.stringify({
    type: "bridge_ready",
    version: "4.3.0",
    timestamp: Date.now()
  }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Spark Godot MCP Bridge 4.3.0 listening on ${PORT}`);
});
