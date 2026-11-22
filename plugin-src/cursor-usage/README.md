# cursor-usage

Cursor quota and account plan monitor for Tierwyn.

## Credentials
Set `CURSOR_API_KEY` in Settings → Plugins or in your environment file (`.env` / `/etc/tierwyn/prod.env`).
Get your user key at: https://cursor.com/dashboard/api?section=user-keys

## Features
- Fetches fast requests used & limit (e.g. 142 of 500)
- Fetches monthly billing cycle reset date
- Reports plan tier (Pro, Business, etc.) and on-demand spend
- Dynamically maps to conversations using Cursor agents

## Agent vs operator

- `usage.get` is agent-callable (spawn Bearer). Quota windows, plan name, reset times.
- `insights.get` is **operator-only** (cookie / Settings → Agent Usage). Account email, display name, team, daily spend, and activity stay off the agent channel. The UI still loads insights via `/settings/agent-usage/cursor-insights`.
