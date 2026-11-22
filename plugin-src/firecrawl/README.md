# firecrawl

Agent-callable Firecrawl v1 proxy. Agents call scrape / search / crawl / map /
extract capabilities and receive inline results. They never see
`FIRECRAWL_API_KEY`. Calls spend the operator's Firecrawl credits.

## Setup

1. Get a key at [firecrawl.dev](https://www.firecrawl.dev/) → API keys.
2. Settings → Plugins → Firecrawl → set `FIRECRAWL_API_KEY` (encrypted vault).
   Env fallback: `FIRECRAWL_API_KEY=` in `/etc/tierwyn/prod.env` (captured at
   boot and scrubbed from agent children).
3. Import `plugin-archives/firecrawl.tar.gz` via Settings → Plugins, or copy
   source into `plugins/firecrawl/` and restart the API.

## Agent usage

Agent-facing docs: `HELP.md`, served at `GET /agent/plugins/firecrawl/help`.

## Credits

Every scrape, search (with formats), crawl page, map, and extract spends
Firecrawl credits. Prefer the narrowest call that answers the question.
Crawl defaults to 100 pages (max 1000) and cannot be cancelled from the plugin.
