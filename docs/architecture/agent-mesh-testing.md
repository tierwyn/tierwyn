# Agent Mesh: Test Plan

Hands-on verification runbook for the agent mesh described in
[Agent Mesh](agent-mesh.md). Audience: the operator (or an agent driving the
API on the operator's behalf) validating a deployment after merge/deploy.
Every expected value below was read from the shipped code (`routes/mesh.ts`,
`routes/spawn.ts`, `mesh/rate.ts`, `mesh/policy.ts`, `repositories/settings.ts`). If an actual response ever differs from this plan, that is a finding, not a
stale doc to ignore.

## Preconditions

| What | Value |
|---|---|
| API base | `http://127.0.0.1:8788` (prod) |
| Web UI | `http://127.0.0.1:4173` (prod, logged in, cookie powers all operator endpoints) |
| Settings start state | `meshAwareness` on, `meshMessaging` off (start from the kill switch so the first drill exercises re-arm) |
| Agent tokens | Bearer token per spawned conversation; expires after **30 minutes**; always use the newest from the conversation's delegation preamble / UI |
| Operator API calls | `GET /mesh/edges`, `GET /mesh/messages`, `DELETE /mesh/edges/:id` are cookie-only. Do them in the web UI, or copy the session cookie from browser devtools |

## Fixtures

Build this tree via the UI (T0 spawns), then mint one edge:

```
Root A (A)
├── Child A1        ← sibling of A2, edge target
└── Child A2        ← PASTE THE AGENT PROMPT HERE
Root B (B)
└── Child B1        ← cross-tree (T2) target, must be unreachable
```

1. Spawn A, then A1 and A2 as its children. Spawn a separate root B, then B1.
2. Mesh Settings → enable **messaging** (see Kill-switch drill below for the
   warning you should see). Mint edge **A1 ⇄ A2** (Add Edge; replies allowed →
   the reverse edge is minted automatically).
3. Capture the bearer tokens for A1 and A2 (fresh ones). Note the
   conversation IDs. **Lateral senders need a `mesh`-scoped token**: the
   message route accepts `spawn`- **or** `mesh`-scoped bearers, but the
   lateral path in `canMessage` additionally requires `mesh` scope; spawn
   the children with a profile that mints it. An ordinary spawn-scoped child
   token gets `403 {decision:"denied_scope"}` on lateral sends (that exact
   behaviour is O15; worth observing deliberately).

Substituting IDs below: `A1`, `A2`, `B1` = conversation IDs; `TOK_A2`, `TOK_A1`
= their tokens.

## Ready-to-paste agent prompt (lateral + T2 drive)

Paste into the **A2** conversation (or spawn A2 with this as its task).
Replace the four placeholders first.

```text
You are helping verify the agent-mesh feature. Work from this sandbox only.

Your conversation id: <A2_ID>
Your bearer token: <TOK_A2>
API base: http://127.0.0.1:8788
Sibling peer conversation id (edge exists A1<->A2): <A1_ID>
Out-of-tree target (must be refused): <B1_ID>

Rules: never print the bearer token in your report (mask it as ***). Run each
step with curl, then record status + body. Do not retry a step to "make it
pass"; rates are per-minute and re-running changes the results.

Step 1: Awareness. List your peers:
  curl -sS http://127.0.0.1:8788/agent/mesh/peers \
    -H "Authorization: Bearer <TOK_A2>"
Expect HTTP 200 and a JSON body; note whether <A1_ID> appears and its live flag.

Step 2: Lateral peer message (T3). Send your sibling a ping:
  curl -sS -X POST http://127.0.0.1:8788/spawn/<A1_ID>/message \
    -H "Authorization: Bearer <TOK_A2>" -H "Content-Type: application/json" \
    -d '{"parentConversationId":"<A2_ID>","text":"Mesh ping from A2: reply with your current status in one line."}'
Expect HTTP 200 with {ok:true, delivered:...}.

Step 3: Cross-tree attempt (T2, must fail). Same call but target <B1_ID>
(parentConversationId stays <A2_ID>):
  curl -sS -X POST http://127.0.0.1:8788/spawn/<B1_ID>/message \
    -H "Authorization: Bearer <TOK_A2>" -H "Content-Type: application/json" \
    -d '{"parentConversationId":"<A2_ID>","text":"should be refused"}'
Expect HTTP 403 with decision "denied_wrong_tree".

Step 4: Size cap. Send >32 KiB to <A1_ID>:
  jq -n --arg p "<A2_ID>" --arg t "$(python3 -c 'print("A"*33000)')" \
    '{parentConversationId:$p, text:$t}' | \
  curl -sS -X POST http://127.0.0.1:8788/spawn/<A1_ID>/message \
    -H "Authorization: Bearer <TOK_A2>" -H "Content-Type: application/json" \
    --data @-
Expect HTTP 413 with decision "denied_too_large".

Step 5: Report. Produce a markdown table: step | endpoint | HTTP status |
decision/error field. Flag any result that differs from the expectation above
as DEFECT. Do not take any other action and do not message anyone else.
```

## Expected results: agent-side

| # | Scenario | Expected |
|---|---|---|
| A1 | Awareness (messaging off OR on) | `200 {peers:[…]}`; awareness needs only a live token, no mesh scope; A1 appears; `live` flag only while messaging is on |
| A2 | Lateral with live edge | `200 {ok:true, delivered:"steered"\|"deferred"\|"new_turn", decision:…}`; steer if A1 is running and injectable, `deferred` if running but not steerable (held until that turn ends), new turn if idle |
| A5 | Coordinator hop (default cap 2) | A → B → C: both laterals allowed (`hop` 1 then 2). A → B → C → D: the third forward is `403 {decision:"denied_hop_cap"}`. A new session on the coordinator resets the chain. |
| A6 | Busy peer is not interrupted | Send to a peer mid-turn that is not steerable. Expect `200 {ok:true, delivered:"deferred", decision:"deferred_pending"}`. Confirm `stopSession` did not fire; the text arrives as the peer's next turn after its current turn ends. Do not resend; a resend spends the rate cap and may evict the earlier mailbox slot. |
| A3 | T2 cross-tree | `403 {error:"denied_wrong_tree", decision:"denied_wrong_tree"}` + **one** audit row |
| A4 | 33 000-byte lateral | `413 {error:"text exceeds 32kb cap", decision:"denied_too_large"}` + audit row with `bytes≈33000` |
| A7 | Live token, wrong sender in body | Token minted for A, body claims B as `parentConversationId` → `403 {decision:"denied_sender_mismatch"}` whose `error` names **A**; **zero** new audit rows. A garbage token still draws `401`. |

## Expected results: operator-side checks

Do these in the UI (and `GET /mesh/messages` / the DB snippet below).

| # | Scenario | Steps | Expected |
|---|---|---|---|
| O1 | T0 descent still works with messaging ON | From A, talk back down to A1 (Spawn panel message) | `200 {ok:true,…}`; A's transcript gets spawn marker `⇩ message → <A1 title>`; **no** mesh audit row for the successful descent (by design) |
| O2 | Descent marker is RAW, lateral is SANITIZED | Compare markers after the agent prompt ran | `⇩` shows A1's title verbatim; `⇄` shows A2's title sanitized (control chars/emoji stripped, length-capped) |
| O3 | Redaction before delivery | Repeat Step 2 with a fake bearer token in the text | Message arrives in A1's transcript with the token redacted; the `⇄` frame is sanitized **before** framing |
| O4 | Kill switch = MUTE | Mesh Settings → messaging **off** | Both edges still listed (not revoked); peers `live` flags gone |
| O5 | Off-invariant byte-equality | With messaging OFF: O1 again; and `POST /spawn/<B1>/message` from A | Descent: `200`, marker identical to pre-mesh form. Wrong-tree: `403` with the **legacy prose string** `target conversation is not a strict descendant of the specified parent` (not `denied_wrong_tree`) and **zero** new audit rows; no 429s possible (flood gate is skipped while off) |
| O6 | Re-arm warning | With ≥1 live edge, toggle messaging back **on** | Confirm dialog says **"N existing edge(s) will become active again."** (N = live edge count); confirming leaves all edges intact |
| O7 | `denied_revoked` (row exists, revoked) vs `denied_no_edge` (no row at all) | (a) Revoke the A2→A1 direction only, then A2→A1 lateral. (b) Mint an edge with **replies off** (e.g. B→B1), then send B1→B; the reverse direction was never minted | (a) `403 {decision:"denied_revoked"}`; the revoked row is still the latest row in that direction, so this is **not** `denied_no_edge`. (b) `403 {decision:"denied_no_edge"}`. Both audited |
| O8 | Per-edge rate cap (default 6/min, Settings `meshMessagesPerMinute`) | Send 7 laterals A2→A1 within a minute | 7th returns `429` with `Retry-After` header; decision `denied_rate`; **audited** (row with edgeId) |
| O9 | Per-caller flood cap (60/min, hardcoded) not audited | Burst ≥61 cheap `POST …/message` calls from one parent (wrong-tree target is fine) | First 60 get their normal verdicts (each wrong-tree 403 audited); once 429s start, **no further audit rows appear**; contrast with O8 |
| O10 | Peer-list throttle (12/min, hardcoded) | `GET /agent/mesh/peers` 13× in a minute (any live token) | 13th → `429` + `Retry-After` |
| O11 | Peer cap on mint | Set `meshMaxPeersPerConversation` to 1, mint a second outbound edge from one conversation | `400 {error:"peer cap reached", decision:"denied_rate"}` (restore the setting after) |
| O12 | Edge cascade on archive/delete | Archive (or delete) A1 | All edges touching A1 disappear from Mesh Settings; A2→A1 now `denied_no_edge` |
| O13 | Awareness off | Settings → awareness **off**, then Step 1 with a live token | `403 {error:"mesh awareness is off"}`. Turn it back on |
| O14 | Spawn-less token cannot descent-steer (H-1) | Messaging **on**; with a **mesh-scoped** token T (no `spawn` scope), `POST /spawn/<A1>/message` with `parentConversationId` = T's own id | `403 {decision:"denied_no_edge"}`; the descent branch requires `spawn` scope or operator, so the mesh-only token falls through to the edge lookup and a descendant pair has no edge. A token with **neither** `spawn` nor `mesh` scope is rejected earlier: `401` (token validation). With messaging **off**, the same mesh-token call gets the O5 legacy prose 403 with **no** `decision` field |
| O15 | Ordinary (spawn-scoped) child token cannot lateral-message | Messaging **on**; with A2's plain spawn-scoped bearer, repeat Step 2 | `403 {decision:"denied_scope"}`; lateral needs a `mesh`-scoped token or operator (policy unit tests pin this) |
| O16 | Auto-mint ring on spawn | Messaging **on**, `meshAutoEdges` **on** (default). Spawn A3 as a sibling of A1/A2 | A3↔A, A3↔A1, A3↔A2 live in both directions (peer cap permitting). Turning `meshAutoEdges` **off** requires the confirm dialog; a subsequent spawn A4 gets **no** new ring; existing edges stay. |
| O17 | Hop counter vs session taint | With default `meshMaxHops: 2`, have A1 receive a lateral (hop 1) then immediately send to A2 | Allowed (`hop: 2`); the old session-taint behaviour would have denied this. A further relay from A2 after receiving hop 2 is `denied_hop_cap`. |

## Verifying audit rows

UI: `GET /mesh/messages` equivalent (Mesh Settings → messages) or read-only DB:

```bash
node -e "const db=require('/home/user/Projects/Tierwyn/node_modules/better-sqlite3')('/home/user/Projects/Tierwyn/data/prod.db',{readonly:true});console.table(db.prepare('select * from mesh_messages order by rowid desc limit 15').all())"
```

Row anatomy: `caller_kind`, `from_conversation`, `to_conversation`, `edge_id`
(lateral only), `decision`, `bytes`, duration, `content_sha256`; prose itself
is **not** stored (audit, not inbox). Rate buckets are in-memory:
restarting `tierwyn-prod` clears O8–O10 state; waiting ~60 s also works.

## Cleanup

1. Revoke or keep the test edges (they are perpetual until revoked or until an
   endpoint is archived; nothing expires them).
2. Restore `meshMaxPeersPerConversation` if O11 changed it.
3. Leave settings in the operator's preferred state; the audit rows from this
   run are permanent by design.

See [Agent Mesh](agent-mesh.md) for why each behaviour above is shaped the way
it is (kill switch is mute, redaction only on `⇄`, H-1 scope conjunct, …).
