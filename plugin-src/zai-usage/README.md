# zai-usage

Agent-callable Z.ai quota lookup. Agents call `POST /agent/plugins/zai-usage/capabilities/usage.get`
and receive 5-hour / weekly used-percent plus plan name. They never see the API key.

## Precondition (this is the entire security payoff)

Mint a **dedicated** Z.ai API key and set `ZAI_API_KEY` in the env file
(dev `.env` / prod `/etc/tierwyn/prod.env`), then restart.

If the box authenticates to z.ai solely via `OPENAI_API_KEY` (the agent-visible
inference key), this plugin **refuses** to fall back to it and returns
`credential_missing`. The inference key is already in the child env by design;
hiding it is not a property this plugin can buy. A dedicated key is required.

Phase 1 has no UI write path — changing the key means editing env and restarting.

## Manifest

- Capability: `usage.get` (`agentCallable: true`, 6 req/min per caller)
- Credential: `ZAI_API_KEY` (required)
- Egress: `https://api.z.ai` only
