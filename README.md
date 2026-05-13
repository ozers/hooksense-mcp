# @hooksense/mcp

Model Context Protocol server for [HookSense](https://hooksense.com). Lets Claude Desktop, Cursor, Claude Code, Continue, and any other MCP client create webhook capture endpoints, inspect captured requests, and replay them — all from your editor or agent session.

## Why

Building webhook integrations is a tight feedback loop: send a test event, see what arrived, adjust the handler, repeat. Doing this from a chat-style AI session has always meant copy-paste-ing payloads from a dashboard into the chat. With this MCP server, the agent fetches captured webhooks directly and feeds them into your code.

## Setup

1. Get an API token at <https://hooksense.com/account/tokens>
2. Configure your MCP client (examples below)

### Claude Desktop / Claude Code

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "hooksense": {
      "command": "npx",
      "args": ["-y", "@hooksense/mcp"],
      "env": {
        "HOOKSENSE_TOKEN": "hsk_your_token_here"
      }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "hooksense": {
      "command": "npx",
      "args": ["-y", "@hooksense/mcp"],
      "env": {
        "HOOKSENSE_TOKEN": "hsk_your_token_here"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|---|---|
| `list_endpoints` | List your webhook endpoints |
| `create_endpoint` | Create a new capture endpoint, returns the public webhook URL |
| `get_endpoint` | Get one endpoint's full settings |
| `list_requests` | List captured requests for an endpoint (summary view) |
| `get_request` | Fetch one request with full headers + body |
| `replay_request` | POST a captured request to any target URL |

## Environment

| Variable | Default | Notes |
|---|---|---|
| `HOOKSENSE_TOKEN` | _(required)_ | API token from /account/tokens |
| `HOOKSENSE_API` | `https://hooksense.com` | Override for self-hosted/staging |

## Example agent prompts

> "Create a webhook endpoint, point Stripe's test mode at it, then show me the most recent payment_intent.succeeded payload."

> "Replay the last 3 captured webhooks against my localhost:3000/webhooks/stripe so I can test my handler refactor."

> "Diff the headers between the most recent two captured GitHub pushes."

## License

MIT
