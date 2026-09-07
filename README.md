# Spark × Godot Railway Gateway

- Deploy this folder as a Railway service.
- Set `DEVICE_TOKEN` in Railway Variables.
- The public MCP endpoint is `/mcp`.
- The Windows bridge connects outbound to `/device` over WSS.
- The bridge forwards each MCP JSON request to `http://127.0.0.1:9820/mcp`.

No Godot port is exposed publicly.
