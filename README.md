# mcp-amtrak

Amtrak MCP — live Amtrak train tracking via the community Amtraker API (api-v3.amtraker.com, a mirror of Amtrak's own track-a-train feed).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

| Tool | Description |
|------|-------------|
| `amtrak_train_status` | Live Amtrak train status and GPS tracking — "where is my Amtrak train", "is train 6 late", "track the California Zephyr". Accepts a train number ("6", "2150") or route name ("Coast Starlight", "Empire Builder"). Returns each active instance of that train: current GPS position, speed, heading, timeliness, next station with ETA and delay minutes, and origin/destination scheduled vs actual times. Data is a community mirror of Amtrak's own tracking feed (api-v3.amtraker.com); positions update about every few minutes. Example: amtrak_train_status({ train: "6" }) |
| `amtrak_station_board` | Amtrak station departures/arrivals board — upcoming trains at a station. "What trains are arriving at Chicago Union?", "next train at CHI", "station board for Denver". Accepts a 3-letter Amtrak station code ("CHI", "NYP", "LAX") or a station name ("Chicago", "Portland"). Returns trains currently en route to that station with route, scheduled vs estimated arrival, delay minutes, and status. Live community mirror of Amtrak tracking (api-v3.amtraker.com). Example: amtrak_station_board({ station: "CHI" }) |
| `amtrak_routes_active` | Summary of ALL currently active Amtrak trains grouped by route — "how many Amtrak trains are running right now", "which Amtrak routes have delays", national system overview. Returns per route: active train count, train numbers, and the worst delay in minutes. Compact; live from a community mirror of Amtrak's tracking feed. Example: amtrak_routes_active({}) |
| `amtrak_station_info` | Amtrak station lookup by code or name — station name, 3-letter code, city/state, street address, timezone, coordinates, and how many trains are currently inbound. "Where is the Amtrak station in Denver?", "what is station code NYP". Example: amtrak_station_info({ station: "Denver" }) |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "amtrak": {
      "url": "https://gateway.pipeworx.io/amtrak/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/amtrak/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/amtrak_train_status \
  -H 'Content-Type: application/json' \
  -d '{"train":"6"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/amtrak_train_status`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-amtrak` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/amtrak/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "amtrak": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-amtrak"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Amtrak data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
