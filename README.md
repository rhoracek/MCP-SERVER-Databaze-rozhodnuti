# MCP Server - Databáze rozhodnutí

MCP (Model Context Protocol) server for the Czech court decisions database at [rozhodnuti.justice.cz](https://rozhodnuti.justice.cz).

Provides access to anonymized court decisions from Czech district, regional, and high courts (okresní, krajské a vrchní soudy) via the official Open Data REST API.

## Tools

| Tool | Description |
|------|-------------|
| `list_years` | List all available years with decision counts |
| `list_months` | List months in a year with decision counts |
| `list_days` | List days in a month with decision counts |
| `list_decisions` | List decisions published on a specific date |
| `get_decision` | Get full detail of a decision by document ID |
| `search_decisions` | Search decisions by text, file reference, court, or date range |
| `get_cited_provisions` | Extract all legal provisions (§) cited in a decision |
| `get_related_decisions` | Find related decisions by provisions, case type, and citations |
| `summarize_decision_for_judge` | Structured summary: facts, legal question, conclusion, provisions, related case law |

## Setup

```bash
npm install
npm run build
```

## Usage with Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "databaze-rozhodnuti": {
      "command": "node",
      "args": ["/path/to/mcp-server-databaze-rozhodnuti/build/index.js"]
    }
  }
}
```

## Usage with Claude Code

```bash
claude mcp add databaze-rozhodnuti node /path/to/mcp-server-databaze-rozhodnuti/build/index.js
```

## Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.com](https://railway.com) and create a new project from the GitHub repo
3. Railway will automatically detect the `Dockerfile` and deploy
4. The env variable `MCP_TRANSPORT=http` is set in the Dockerfile, Railway assigns the `PORT` automatically
5. Once deployed, your MCP endpoint will be at `https://<your-app>.up.railway.app/mcp`

### Connect from Claude Desktop (remote)

```json
{
  "mcpServers": {
    "databaze-rozhodnuti": {
      "type": "streamable-http",
      "url": "https://<your-app>.up.railway.app/mcp"
    }
  }
}
```

### Connect from Claude Code (remote)

```bash
claude mcp add databaze-rozhodnuti --transport http https://<your-app>.up.railway.app/mcp
```

## API Source

This server uses the official Open Data API at `https://rozhodnuti.justice.cz/api/opendata`.

## License

MIT
