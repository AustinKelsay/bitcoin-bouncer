# bitcoin-bouncer

`bitcoin-bouncer` is a tiny, prompt-driven transaction valve for a local Bitcoin node.

The idea is simple: connect to a raw transaction stream, hand each transaction to a small local model, and let the model quickly decide what should happen next using a very small set of explicit tools.

This is not a heavyweight policy engine. There are no JSON rule packs, no separate moderation DSL, and no attempt to encode a fixed definition of spam. The user's intent lives in the model's system prompt.

## Concept

Bitcoin nodes already expose useful local signals. In a Polar regtest setup, for example, a node can publish raw transactions over ZMQ:

```text
ZMQ Transaction Host: tcp://127.0.0.1:29335
RPC Host:             http://127.0.0.1:18443
Username:             polaruser
Password:             polarpass
```

`bitcoin-bouncer` sits next to that node as a small local agent harness:

```text
bitcoind ZMQ rawtx
        |
        v
bitcoin-bouncer
        |
        v
local model + user system prompt
        |
        v
pass / hold / drop / tag / peek
```

The harness stays intentionally dumb. It listens, summarizes, offers tools, applies the model's decision, and logs what happened.

The model gets the agency.

## User Intent

The user configures behavior with a system prompt, for example:

```text
You are my local Bitcoin transaction valve.

Act fast. Let normal wallet payments, Lightning-like activity, consolidations,
and ordinary Taproot/P2WPKH usage pass.

Hold or drop transactions that feel like spam, cheap data stuffing, pathological
script experimentation, dust storms, or economically unserious traffic.

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

Pause the transaction or route it to a short-lived side buffer.

```text
drop(txid, reason)
```

Do not forward, display, index, rebroadcast, or alert on this transaction inside the local harness.

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
```

If the model is uncertain, it can call `peek(txid)` to inspect decoded details.

## Default Behavior

Because this is a valve in a live data flow, failure behavior should be explicit and boring:

```text
model timeout: pass
malformed response: pass
model unavailable: pass
```

A stricter user could configure the harness to default to `hold`, but the initial posture should avoid accidentally suppressing ordinary network activity.

## Scope

In the first version, `drop` means:

```text
Do not pass this transaction through bitcoin-bouncer's local downstream flow.
```

It does not mean the Bitcoin network dropped the transaction, and it does not mean bitcoind rejected it. ZMQ is observational. It tells the harness what the node saw.

The initial project should be a local membrane around a transaction stream, not a consensus or mempool replacement.

## MVP

The smallest useful prototype:

1. Subscribe to `rawtx` over Bitcoin ZMQ.
2. Decode or summarize the transaction.
3. Send the summary to a local model with the user's system prompt.
4. Let the model choose one action: `pass`, `hold`, `drop`, `tag`, or `peek`.
5. Apply the action locally.
6. Print and persist an audit log.

Example terminal output:

```text
PASS  4a1b...
TAG   98fe... low-fee-but-normal-consolidation
DROP  b73c... low-fee data-like transaction shape
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

