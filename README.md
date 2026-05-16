# bitcoin-bouncer

`bitcoin-bouncer` is a tiny, prompt-driven transaction valve for a local Bitcoin node in a Polar sandbox.

The idea is simple: accept candidate raw transactions through a Bouncer-owned submit path, hand each transaction to a local agent, and let the agent decide whether the transaction should reach the local Bitcoin Core node using a very small set of explicit tools.

This is not a heavyweight policy engine. There are no JSON rule packs, no separate moderation DSL, and no attempt to encode a fixed definition of spam. The user's intent lives in the model's system prompt.

## Concept

Bitcoin nodes expose useful local control points. In a Polar regtest setup, for example, a node can expose RPC for preflight checks and controlled submission:

```text
RPC Host:             http://127.0.0.1:18443
Username:             polaruser
Password:             polarpass
```

`bitcoin-bouncer` sits in front of a designated Gate Node as a small local agent harness:

```text
candidate rawtx
        |
        v
bitcoin-bouncer
        |
        v
local model + user system prompt
        |
        v
pass / hold / drop / shadow_drop / tag / peek
        |
        v
Gate Node bitcoind, only when allowed
```

The harness stays intentionally dumb. It listens, summarizes, offers tools, applies the model's decision, and logs what happened.

The model gets the agency.

## User Intent

The user configures behavior with a system prompt, for example:

```text
You are my local Bitcoin transaction valve.

Act fast. Let normal wallet payments, Lightning-like activity, consolidations,
and ordinary Taproot/P2WPKH usage pass.

Hold, drop, or shadow-drop transactions that feel like spam, cheap data stuffing,
pathological script experimentation, dust storms, or economically unserious
traffic.

Do not over-explain. Prefer PASS unless the transaction shape feels meaningfully bad.
```

That prompt is the policy surface. The harness does not need a separate rule language.

## Minimal Tools

The agent should have only a few fast tools:

```text
pass(txid)
```

Let the transaction continue through the local downstream flow.

```text
hold(txid, reason)
```

Withhold the transaction from the Gate Node and place it in the Hold Queue until explicit release or discard.

```text
drop(txid, reason)
```

Do not submit the transaction to the Gate Node.

```text
shadow_drop(txid, reason)
```

Do not submit the transaction to the Gate Node, but return a success-shaped txid response to the submitter and store the transaction in the Shadow Realm for private correlation.

```text
tag(txid, label)
```

Annotate the transaction while still allowing it through.

```text
peek(txid)
```

Fetch more detail only when the model wants it.

The tools are not a policy framework. They are just the verbs the model can use to control the local flow.

## Transaction Context

The first model call should be compact. A typical transaction summary might include:

```text
txid: abc...
vsize: 188
weight: 749
inputs: 1
outputs: 2
output_scripts: p2tr, op_return
output_values: 546 sats, 0 sats
fee_rate: 0.4 sat/vB
mempool_result: accepted
preflight_allowed: true
```

Before the agent decides, the harness runs a preflight check such as `testmempoolaccept` so the agent can see whether Bitcoin Core would accept the transaction without placing it in the mempool. If the model is uncertain, it can call `peek(txid)` to inspect decoded details.

## Default Behavior

Because this is a valve in a live data flow, failure behavior should be explicit and boring:

```text
model timeout: pass
malformed response: pass
model unavailable: pass
```

A stricter user could configure the harness to default to `hold`, but the initial posture should avoid accidentally suppressing ordinary network activity.

## Scope

In the first version, Bouncer is a Submission Gate:

```text
candidate rawtx -> bitcoin-bouncer -> Gate Node sendrawtransaction
```

Transactions that bypass the Bouncer submit path and call Bitcoin Core directly are outside the v1 control boundary.

The initial project should prove Relay Gate behavior in a local Polar sandbox, not replace Bitcoin Core consensus or mempool policy.

## MVP

The smallest useful prototype:

1. Expose a Bouncer-owned submit path for candidate raw transactions.
2. Decode or summarize the transaction.
3. Run `testmempoolaccept` against the Polar Gate Node.
4. If preflight passes, send the summary to a local model with the user's system prompt.
5. Let the model choose one action: `pass`, `hold`, `drop`, `shadow_drop`, `tag`, or `peek`.
6. Submit to the Gate Node only for `pass` or `tag`.
7. Store held transactions in the Hold Queue and shadow-dropped transactions in the Shadow Realm.
8. Print and persist a truthful audit log.

Example terminal output:

```text
PASS  4a1b...
TAG   98fe... low-fee-but-normal-consolidation
DROP  b73c... low-fee data-like transaction shape
SHADOW_DROP 7c2d... returned txid; withheld from gate node
HOLD  c021... unusual script path; peeking
```

## Design Principle

`bitcoin-bouncer` should feel less like a spam filter and more like a programmable membrane:

```text
raw transaction stream in
prompt-shaped judgment in the middle
tiny action verbs out
```

The harness decides only:

- what the model can observe
- what tools the model can call
- how quickly it must decide
- what happens on failure
- what gets logged

The user prompt decides what kinds of transaction shapes feel unwanted.

## Polar Demo

The MVP demo assumes a local Polar network with one **Gate Node** and optional
**Propagation Witnesses**. The first Gate Node is usually `backend1`.

```sh
export BOUNCER_PROMPT_PATH=bouncer.prompt.md
export BOUNCER_STATE_DB_PATH=state/bouncer.sqlite
export BITCOIN_GATE_NODE_NAME=backend1
export BITCOIN_RPC_URL=http://127.0.0.1:18443
export BITCOIN_RPC_USER=polaruser
export BITCOIN_RPC_PASSWORD=polarpass
export BITCOIN_PROPAGATION_WITNESSES=backend2=http://127.0.0.1:18444,backend3=http://127.0.0.1:18445
```

Start the **Bouncer Runtime**:

```sh
npm install
npm run build
npm start
```

During local development, use:

```sh
npm run dev
```

Check runtime status and prompt hash:

```sh
curl http://127.0.0.1:3000/v1/health
```

### Pi Live Agent

Set `PI_AGENT_URL` to enable the Pi-backed **Live Agent** path:

```sh
export PI_AGENT_URL=http://127.0.0.1:8787/decide
export PI_AGENT_TIMEOUT_MS=1000
```

Probe the endpoint contract before starting a full Bouncer run:

```sh
PI_AGENT_URL=http://127.0.0.1:8787/decide npm run probe:pi-agent
```

The probe sends a representative Bouncer decision request and prints the
normalized Agent Action. It exits non-zero if the endpoint returns prose,
unsupported JSON, or a non-2xx HTTP response.

Bouncer sends Pi the startup-loaded **Bouncer Prompt**, active prompt hash,
compact transaction summary, preflight facts, and optional bounded
**Deep Transaction View** after one `peek`.

The request body sent to `PI_AGENT_URL` is:

```json
{
  "prompt": "...",
  "promptHash": "sha256:...",
  "transaction": {
    "rawTx": "020000000001...",
    "summary": {
      "txid": "...",
      "vsize": 188,
      "weight": 749,
      "inputs": 1,
      "outputs": 2,
      "outputScripts": ["p2tr"],
      "outputValuesSats": [546]
    },
    "preflight": {
      "allowed": true,
      "feeRateSatVb": 0.4
    }
  }
}
```

Pi must return structured JSON, not prose:

```json
{"action":"pass"}
{"action":"tag","label":"low-fee-normal"}
{"action":"hold","reason":"operator review"}
{"action":"drop","reason":"data-like transaction shape"}
{"action":"shadow_drop","reason":"withhold but return txid"}
{"action":"peek"}
```

The HTTP client also accepts common envelopes around that same action:

```json
{"decision":{"action":"pass"}}
{"agentAction":{"action":"drop","reason":"data-like"}}
{"result":{"action":"tag","label":"normal"}}
```

For OpenAI-style `output_json` responses, Bouncer extracts the first content
item shaped like:

```json
{"type":"output_json","json":{"action":"pass"}}
```

`hold`, `drop`, and `shadow_drop` require `reason`. `tag` requires `label`.
Pi may call `peek` at most once, then it must return a final non-`peek` action.
Timeouts, malformed actions, repeated `peek`, or no final action fail open to
`pass` and are recorded internally as Live Agent fallback audit metadata.

Reset the current Polar run state:

```sh
curl -X POST http://127.0.0.1:3000/v1/state/reset
```

### Submit Path

Submit a candidate raw transaction through the **Bouncer Submit Path**:

```sh
curl -sS -X POST http://127.0.0.1:3000/submit \
  -H 'content-type: application/json' \
  -d '{"rawTx":"020000000001..."}'
```

`/v1/transactions` is the versioned alias for the same path.

Expected submitter-facing responses:

```json
{"status":"submitted","txid":"...","action":"pass"}
{"status":"submitted","txid":"...","action":"tag","label":"low-fee-normal"}
{"status":"held","txid":"...","holdId":"...","reason":"operator review"}
{"status":"dropped","txid":"...","reason":"data-like transaction shape"}
{"txid":"..."}
```

The last response is **Shadow Drop**. It is intentionally success-shaped for
the submitter and does not include fake peer counts or fake mempool metadata.

### Hold Queue

List and inspect held transactions:

```sh
curl http://127.0.0.1:3000/v1/holds
curl http://127.0.0.1:3000/v1/holds/HOLD_ID
```

Release a held transaction to the **Gate Node**:

```sh
curl -X POST http://127.0.0.1:3000/v1/holds/HOLD_ID/release
```

Discard a held transaction without submission:

```sh
curl -X POST http://127.0.0.1:3000/v1/holds/HOLD_ID/discard
```

Held transactions do not retry or submit automatically.

### Shadow Realm And Audit

Inspect a **Shadow Realm** record:

```sh
curl http://127.0.0.1:3000/v1/shadow-realm/TXID
```

Query truthful audit events:

```sh
curl 'http://127.0.0.1:3000/v1/audit?txid=TXID'
curl 'http://127.0.0.1:3000/v1/audit?outcome=shadow_drop'
```

Audit outcomes include `pass`, `tag`, `drop`, `hold`, `shadow_drop`,
`preflight_reject`, `queue_full_pass`, `hold_queue_full_pass`, and
`gate_submission_failure`. If Shadow Realm payload storage degrades,
`shadow_drop` still withholds the transaction and the audit event records the
degraded storage state.

### Propagation Verification

For `pass` and `tag`, verify the txid appears on the **Gate Node** and
configured **Propagation Witnesses**:

```sh
TXID=... EXPECTED=present npm run verify:propagation
```

For `hold`, `drop`, and `shadow_drop`, verify the txid is absent from the Gate
Node and witness mempools:

```sh
TXID=... EXPECTED=absent npm run verify:propagation
```

Witness mempool visibility is only a demo/status check. It is not recorded as
**Shadow Escape**.

### Shadow Escape

Shadow Escape detection is block-based. After mining a block in Polar, scan the
Gate Node block range:

```sh
FROM_HEIGHT=101 TO_HEIGHT=101 npm run scan:shadow-escapes
```

If a shadow-dropped txid appears in a mined block through an external route, the
scan records a **Shadow Escape** observation in SQLite without rewriting the
original Shadow Drop decision.

### Fuzz Candidates

Generate valid wallet-funded **Fuzz Candidates** without direct broadcast:

```sh
BOUNCER_URL=http://127.0.0.1:3000 \
BITCOIN_RPC_URL=http://127.0.0.1:18443 \
BITCOIN_RPC_USER=polaruser \
BITCOIN_RPC_PASSWORD=polarpass \
FUZZ_COUNT=3 \
npm run fuzz:candidates
```

The script uses Gate Node wallet RPC to create, fund, sign, and finalize raw
transactions, then submits each raw transaction through `/submit`. It does not
call `sendrawtransaction`; Bouncer remains the Submission Gate.

Invalid candidate coverage is separate: submit malformed `rawTx` values through
`/submit` to exercise parse failures, or valid-but-rejected transactions to
exercise **Preflight Reject**.
