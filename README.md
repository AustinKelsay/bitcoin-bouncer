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
