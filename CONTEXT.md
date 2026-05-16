# Bitcoin Bouncer

Bitcoin Bouncer is a local transaction membrane for a Bitcoin node. It lets a prompt-shaped agent judge observed transactions while the harness enforces the runtime boundaries of the local flow.

## Language

**Transaction Valve Harness**:
The local runtime that turns each observed transaction into exactly one bounded agent decision and applies that decision only to the local downstream flow.
_Avoid_: Pi runtime, policy engine, spam filter

**Decision Budget**:
The bounded amount of time, tool use, and transaction context the agent may spend before the harness applies a fallback decision.
_Avoid_: unlimited reasoning loop, best-effort analysis

**Decision Queue**:
A bounded queue of candidate transactions waiting for preflight and Live Agent decision.
_Avoid_: broadcast queue, unbounded backlog

**Live Agent**:
The agent role that makes one bounded decision for one observed transaction while the transaction is still in the local flow.
_Avoid_: analyst, trainer, batch reviewer

**Pi Agent Harness**:
The lightweight TypeScript agent loop that powers the MVP Live Agent with the Bouncer Prompt and Bouncer-native action tools.
_Avoid_: Bouncer Runtime, external policy service, generic chatbot

**Pi Agent Adapter**:
The narrow integration boundary between the Bouncer Runtime and the Pi Agent Harness.
_Avoid_: scripted agent, inline Pi coupling

**Agent Action**:
The structured action object returned by the Live Agent with a constrained action name and optional reason or label.
_Avoid_: free text decision, parsed prose

**Bouncer Prompt**:
The global system prompt loaded at startup that defines the Live Agent's transaction judgment.
_Avoid_: per-request prompt, caller policy

**Background Analyst**:
The agent role that studies accumulated transaction decisions and burst patterns outside the live transaction path.
_Avoid_: live classifier, inline policy engine

**Relay Gate**:
The Bitcoin Bouncer behavior that controls whether the local node submits, accepts, or relays a transaction to peers.
_Avoid_: local output filter, display filter

**Submission Gate**:
A Relay Gate boundary that judges transactions before they are submitted to the local node.
_Avoid_: p2p interception, mempool policy

**Bouncer Submit Path**:
The Bouncer-owned entry point for raw transactions that should be judged before reaching the local node.
_Avoid_: direct node RPC, transparent wallet interception

**Bouncer API**:
The HTTP surface that exposes transaction submission, operator review, and state reset for the Polar sandbox.
_Avoid_: CLI-only runtime, direct database access

**Bouncer Runtime**:
The TypeScript/Node.js service that hosts the Bouncer API, Decision Queue, Live Agent calls, and Bouncer State Store.
_Avoid_: Python service, shell-script harness

**Idempotency Record**:
A remembered outcome for a candidate transaction id submitted through Bouncer.
_Avoid_: duplicate decision, retry mutation

**Bouncer State Store**:
The durable local store for audit events, idempotency records, held transactions, and shadow-dropped transactions.
_Avoid_: loose logs, in-memory state

**Gate Node**:
The Bitcoin Core node that receives transactions allowed by the Submission Gate.
_Avoid_: random peer, broadcast target

**Propagation Witness**:
A Polar Core node checked to confirm whether a gated transaction propagated beyond the Gate Node.
_Avoid_: gate node, external observer

**Gate Submission Failure**:
A Gate Node failure when submitting a transaction after a pass or tag decision.
_Avoid_: agent failure, preflight reject

**Bouncer Test Sender**:
The test actor that creates candidate raw transactions from Gate Node funds and submits them through the Bouncer Submit Path.
_Avoid_: external wallet, direct broadcaster

**Fuzz Candidate**:
A generated raw transaction submitted through Bouncer to exercise gate behavior.
_Avoid_: direct broadcast, production transaction

**Candidate Diversity**:
Variation in valid or near-valid Fuzz Candidate shapes used to expose the Submission Gate and Live Agent to different transaction summaries and preflight facts.
_Avoid_: full-node protocol fuzzing, consensus fuzzing

**Sub-1-Sat/VB Candidate**:
A Fuzz Candidate intentionally funded near or below one satoshi per virtual byte to exercise low-fee preflight facts and Live Agent judgment.
_Avoid_: sub-satoshi fee, impossible fractional total fee

**Preflight Check**:
A node-local acceptance check performed before the Live Agent decides and before the transaction is submitted.
_Avoid_: broadcast attempt, dry-run relay

**Preflight Reject**:
A harness-owned outcome for a candidate transaction the Gate Node would not accept.
_Avoid_: agent drop, spam decision

**Deep Transaction View**:
Bounded transaction details returned by peek during one Live Agent decision.
_Avoid_: mempool search, wallet history, burst analysis

**Hold Queue**:
Bounded storage for transactions withheld from the Gate Node pending explicit release or discard.
_Avoid_: retry queue, delayed broadcast queue

**Shadow Drop**:
A Relay Gate action that withholds a transaction from the Gate Node while returning a success-shaped response to the submitter.
_Avoid_: accepted, relayed, honest drop

**Shadow Realm**:
Private storage for shadow-dropped transaction payloads and decision context.
_Avoid_: hold queue, drop archive, mempool

**Shadow Escape**:
A shadow-dropped transaction that later appears in a block through an external route.
_Avoid_: passed transaction, Bouncer relay, release

## Relationships

- A **Transaction Valve Harness** observes transactions from a local Bitcoin node.
- A **Transaction Valve Harness** applies agent decisions to the local downstream flow, not to Bitcoin consensus or the node's mempool.
- Each observed transaction gets one **Decision Budget**, even when the harness can use highly concurrent inference.
- The **Decision Queue** absorbs bursts before preflight and Live Agent work.
- Bouncer performs only minimal parse and transaction identity work before admitting a candidate to the **Decision Queue**.
- If the **Decision Queue** is full, Bouncer bypasses the **Live Agent**, submits to the **Gate Node**, and records a queue-full pass override.
- A **Live Agent** decides within a single transaction's **Decision Budget**.
- The MVP **Live Agent** is powered by the **Pi Agent Harness** through the **Pi Agent Adapter**.
- The **Pi Agent Harness** is core to Bouncer's Live Agent path, but it is not the **Bouncer Runtime** itself.
- The MVP **Pi Agent Harness** runs in-process inside the **Bouncer Runtime** rather than as a separate Pi HTTP service.
- The **Pi Agent Harness** uses a tool-calling model for Bouncer-native action tools.
- The **Pi Agent Adapter** returns an **Agent Action** derived from a tool call, not free-form prose.
- Free-form prose and JSON-only action parsing are outside the canonical MVP Live Agent path.
- `pass`, `tag`, `hold`, `drop`, and **Shadow Drop** are declarative terminal tools; the **Bouncer Runtime** applies the returned **Agent Action**.
- `peek` is the only non-terminal Live Agent tool.
- The first Live Agent model turn exposes terminal tools plus `peek`; after `peek`, the second turn exposes only terminal tools.
- An **Agent Action** requires a reason for hold, drop, and **Shadow Drop**; tag requires a label; pass may omit a reason.
- An **Agent Action** missing required fields is malformed and falls back to pass with an audit override.
- The **Bouncer Prompt** is loaded at startup; submitters cannot override policy per request.
- The **Bouncer Prompt** is a local markdown file loaded from the configured prompt path.
- Bouncer does not hot-reload the **Bouncer Prompt** in the MVP; each Live Agent audit event records the prompt hash.
- A **Background Analyst** may review many transactions, but does not block live transaction handling.
- A **Background Analyst** monitors new blocks for **Shadow Escape** events.
- The MVP block monitor reads new blocks from the **Gate Node** only.
- A **Relay Gate** extends Bitcoin Bouncer from observing transactions to controlling peer-sharing behavior in a local node environment.
- A **Submission Gate** is the first Polar prototype boundary for Relay Gate behavior.
- A **Bouncer Submit Path** is the supported v1 way for candidate transactions to enter the **Submission Gate**.
- The **Bouncer API** is the primary MVP runtime surface; CLI commands are convenience wrappers around it.
- The **Bouncer Runtime** is implemented with TypeScript on Node.js for the MVP.
- The **Bouncer API** is hosted with Fastify in the MVP.
- An **Idempotency Record** gives repeated submissions of the same transaction id the same submitter-facing outcome.
- An **Idempotency Record** lives for the current Polar network run and is cleared by explicit state reset.
- The **Bouncer State Store** is SQLite in the MVP.
- The first **Gate Node** is Polar's `backend1` Bitcoin Core node.
- The other Polar Core nodes act as **Propagation Witnesses** for pass, tag, hold, drop, and **Shadow Drop** tests.
- The **Bouncer Runtime** is configured with one **Gate Node** and zero or more **Propagation Witnesses**.
- **Propagation Witnesses** verify peer propagation in tests and status checks; **Shadow Escape** is recorded only from blocks.
- A **Gate Submission Failure** returns the Gate Node's submission error and does not rewrite the agent decision.
- A **Bouncer Test Sender** creates v1 candidate transactions, but does not broadcast them directly.
- A read-only smoke-test demo should present the **Bouncer Test Sender**, **Bouncer Runtime**, and **Propagation Witness** as the three primary actors.
- The first **Fuzz Candidates** are valid wallet-funded transactions created from Gate Node funds and submitted through Bouncer.
- **Candidate Diversity** is the next fuzzing priority for Bouncer; invalid/adversarial harness pressure remains useful but is secondary to expanding valid candidate shapes for now.
- Fuzzamoto-style scenario work can inspire **Candidate Diversity**, but Bouncer does not aim to become a full-node coverage-guided fuzzer.
- Candidate diversity should start with wallet-funded standard transactions: single-output, multi-output, tiny-output, RBF-enabled, RBF-disabled, and **Sub-1-Sat/VB Candidate** shapes.
- Invalid **Fuzz Candidates** exercise parse failures and **Preflight Rejects**, not normal Live Agent judgment.
- Fuzz generation starts as a script outside the **Bouncer API**, not as a runtime endpoint.
- A **Preflight Check** gives the **Live Agent** node-policy facts without placing the transaction in the mempool.
- A **Preflight Reject** bypasses the **Live Agent** by default.
- A **Deep Transaction View** may include decoded transaction details, cheap prevout metadata, and preflight facts.
- The **Live Agent** may call peek at most once within a transaction's **Decision Budget**.
- If the **Live Agent** times out, returns a malformed action, exceeds its tool limit, or gives no final action after peek, the harness falls back to pass with an audit override.
- A held transaction remains in the **Hold Queue** until an explicit operator release or discard.
- If the **Hold Queue** is full, a requested hold falls back to pass with an audit override unless strict mode is explicitly configured.
- A **Shadow Drop** is truthful in internal audit logs but deceptive in the submitter-facing response.
- **Shadow Drop** is a core MVP action in the Polar sandbox, distinct from honest drop behavior.
- **Shadow Drop** is a native Live Agent tool; the harness applies it directly when called.
- Honest drop and **Shadow Drop** both withhold from the **Gate Node**; they differ in submitter-facing response and storage.
- Honest drop returns a Bouncer-specific rejection response rather than pretending Bitcoin Core rejected the transaction.
- Hold returns a Bouncer-specific pending response with a transaction id and hold id.
- A submitter-facing **Shadow Drop** response returns only the transaction id in a success-shaped response, without fake peer counts or fake mempool metadata.
- Tag submits the transaction to the **Gate Node** and records a label in Bouncer's audit log only.
- In the MVP, pass and tag submit to the **Gate Node** before the submit job completes; there is no separate asynchronous broadcast queue.
- A shadow-dropped transaction is stored in the **Shadow Realm**, not the **Hold Queue**.
- A **Shadow Escape** adds a new block observation without rewriting the original **Shadow Drop** decision.
- Repeated submissions of a shadow-dropped transaction return the prior success-shaped response and do not create duplicate **Shadow Realm** records.
- If the **Shadow Realm** cannot store the full payload, **Shadow Drop** still applies and the audit log records the degraded storage state.

## Example dialogue

> **Dev:** "Can the agent drop a transaction from the Bitcoin network?"
> **Domain expert:** "No. The **Transaction Valve Harness** can only decide whether that transaction passes through Bitcoin Bouncer's local downstream flow."
>
> **Dev:** "If the inference cluster is busy, should we wait until the agent catches up?"
> **Domain expert:** "No. The **Decision Budget** expires and the harness falls back, usually by passing the transaction with an audit note."
>
> **Dev:** "Should Bouncer use a queue during transaction bursts?"
> **Domain expert:** "Yes. Use a bounded **Decision Queue** before preflight and agent work, but do not enqueue accepted broadcasts separately in the MVP."
>
> **Dev:** "If the Decision Queue is full, should Bouncer reject new transactions?"
> **Domain expert:** "No. Bypass the **Live Agent**, submit to the **Gate Node**, and audit a queue-full pass override."
>
> **Dev:** "Should preflight run before queue admission?"
> **Domain expert:** "No. Do only minimal parse and identity work first; run the **Preflight Check** inside the queued worker."
>
> **Dev:** "Can we use a fake scripted agent for the MVP?"
> **Domain expert:** "No. The MVP **Live Agent** is Pi-backed through the **Pi Agent Adapter**."
>
> **Dev:** "Can the Live Agent explain itself in prose and let Bouncer parse the answer?"
> **Domain expert:** "No. The **Pi Agent Adapter** returns a structured **Agent Action** with a constrained action name."
>
> **Dev:** "Can the agent withhold a transaction without explaining why?"
> **Domain expert:** "No. Hold, drop, and **Shadow Drop** require a reason in the **Agent Action**."
>
> **Dev:** "If the agent says drop but forgets the reason, should Bouncer still withhold it?"
> **Domain expert:** "No. Missing required action fields make the **Agent Action** malformed, so Bouncer falls back to pass with an audit override."
>
> **Dev:** "Can callers provide their own policy prompt per transaction?"
> **Domain expert:** "No. The **Bouncer Prompt** is loaded at startup and applies to all submitted candidates."
>
> **Dev:** "Where does the Bouncer policy prompt live?"
> **Domain expert:** "In a local markdown file loaded from the configured prompt path at startup."
>
> **Dev:** "If we edit the prompt file while Bouncer is running, should decisions immediately change?"
> **Domain expert:** "No. Restart Bouncer to load a new **Bouncer Prompt**, and record the prompt hash with each Live Agent decision."
>
> **Dev:** "Can the agent study a whole burst before deciding what to do with the first transaction?"
> **Domain expert:** "Not in the live path. The **Live Agent** decides per transaction; the **Background Analyst** studies bursts afterward."
>
> **Dev:** "When the agent drops a transaction, should our local node still share it with peers?"
> **Domain expert:** "No. In **Relay Gate** mode, drop and hold are intended to prevent peer sharing by the local node."
>
> **Dev:** "Do we need to intercept Bitcoin Core p2p relay in the first Polar prototype?"
> **Domain expert:** "No. Start with a **Submission Gate** that controls generated or submitted transactions before `sendrawtransaction`."
>
> **Dev:** "If a wallet calls Bitcoin Core RPC directly, does Bouncer stop it?"
> **Domain expert:** "Not in v1. Candidate transactions must enter through the **Bouncer Submit Path** to be filtered."
>
> **Dev:** "Should the MVP be CLI-only?"
> **Domain expert:** "No. The **Bouncer API** is the primary runtime surface, with CLI commands as thin wrappers."
>
> **Dev:** "What runtime hosts the API and queue workers?"
> **Domain expert:** "The MVP **Bouncer Runtime** is a TypeScript/Node.js service."
>
> **Dev:** "Which HTTP framework hosts the Bouncer API?"
> **Domain expert:** "Fastify hosts the MVP **Bouncer API**."
>
> **Dev:** "If the same transaction is submitted twice, does the agent decide twice?"
> **Domain expert:** "No. Bouncer uses an **Idempotency Record** so duplicate submissions receive the same outcome."
>
> **Dev:** "Should duplicate-submission memory expire automatically?"
> **Domain expert:** "No. In the MVP, **Idempotency Records** last for the current Polar network run and reset explicitly between demos."
>
> **Dev:** "Can audit logs and shadow records just be JSONL files?"
> **Domain expert:** "No. The MVP uses a SQLite **Bouncer State Store** so idempotency, holds, shadow records, and audit events can be queried consistently."
>
> **Dev:** "Which Core node should receive transactions that pass the gate?"
> **Domain expert:** "Use `backend1` as the first **Gate Node**, then verify propagation to the other Polar Core nodes."
>
> **Dev:** "How do we prove a passed transaction propagated?"
> **Domain expert:** "Check the non-Gate Polar Core nodes as **Propagation Witnesses**."
>
> **Dev:** "Should only tests know about witness nodes?"
> **Domain expert:** "No. The **Bouncer Runtime** is configured with **Propagation Witnesses** so status checks and **Shadow Escape** monitoring can use them."
>
> **Dev:** "Does seeing a shadow-dropped transaction in a peer mempool count as Shadow Escape?"
> **Domain expert:** "No. **Propagation Witnesses** can show peer visibility, but **Shadow Escape** is only recorded when the transaction appears in a block."
>
> **Dev:** "If preflight passes but the Gate Node rejects the final submission, is that the agent's fault?"
> **Domain expert:** "No. That is a **Gate Submission Failure**; return the Gate Node error and keep the agent decision intact in audit."
>
> **Dev:** "Who creates the first transactions we test?"
> **Domain expert:** "The **Bouncer Test Sender** creates raw transactions from Gate Node funds, then submits them through Bouncer instead of broadcasting directly."
>
> **Dev:** "Are fuzzing transactions broadcast directly from the wallet?"
> **Domain expert:** "No. A **Fuzz Candidate** is created as signed raw transaction data, then submitted through Bouncer."
>
> **Dev:** "Should Bouncer expose an endpoint to generate fuzz transactions?"
> **Domain expert:** "No. Fuzz generation starts as a separate script that submits candidates through the **Bouncer API**."
>
> **Dev:** "Can the agent know whether Bitcoin Core would accept the transaction before deciding?"
> **Domain expert:** "Yes. Run a **Preflight Check** such as `testmempoolaccept` before any broadcast."
>
> **Dev:** "If Bitcoin Core would reject a transaction anyway, is that an agent drop?"
> **Domain expert:** "No. That is a **Preflight Reject** owned by the harness."
>
> **Dev:** "Can peek inspect the whole mempool or wallet history?"
> **Domain expert:** "No. Peek returns a **Deep Transaction View** bounded to the transaction being decided."
>
> **Dev:** "Can the agent keep peeking until it is satisfied?"
> **Domain expert:** "No. The **Live Agent** gets at most one peek, then must choose a final action."
>
> **Dev:** "If the agent uses its peek but never gives a valid final action, should Bouncer hold the transaction?"
> **Domain expert:** "No. Agent failure falls back to pass with an audit override; only **Preflight Reject** bypasses this fail-open path."
>
> **Dev:** "Does a held transaction get retried automatically later?"
> **Domain expert:** "No. A held transaction stays in the **Hold Queue** until an operator explicitly releases or discards it."
>
> **Dev:** "If the agent wants to hold a transaction but the hold queue is full, should we drop it?"
> **Domain expert:** "No. Default to pass with an audit override so storage pressure does not silently become censorship."
>
> **Dev:** "Can we tell a submitter their transaction was accepted while withholding it from the Gate Node?"
> **Domain expert:** "Yes. That action is a **Shadow Drop**, and the audit log must record that it was not submitted or relayed by Bouncer."
>
> **Dev:** "Should normal drop become deceptive because shadow drop exists?"
> **Domain expert:** "No. **Shadow Drop** is a separate action so the agent's intent remains explicit."
>
> **Dev:** "Do drop and shadow drop have different relay behavior?"
> **Domain expert:** "No. Both withhold from the **Gate Node**; **Shadow Drop** differs by returning a success-shaped response and storing the transaction in the **Shadow Realm**."
>
> **Dev:** "If Bouncer honestly drops a transaction, should the submitter see a Bitcoin Core rejection?"
> **Domain expert:** "No. Honest drop returns a Bouncer-specific rejection so Core policy and Bouncer judgment stay distinct."
>
> **Dev:** "If Bouncer holds a transaction, should the submitter see success or rejection?"
> **Domain expert:** "Neither. Hold returns a Bouncer-specific pending response with the transaction id and hold id."
>
> **Dev:** "Does tagging a transaction annotate Bitcoin Core's mempool?"
> **Domain expert:** "No. Tag passes the transaction to the **Gate Node** and records the label only in Bouncer's audit log."
>
> **Dev:** "What should the submitter see when their transaction is shadow-dropped?"
> **Domain expert:** "Only a success-shaped transaction id response. Internally, the audit log records that Bouncer did not submit it to the Gate Node."
>
> **Dev:** "Can a shadow-dropped transaction be released like a held transaction?"
> **Domain expert:** "No. It lives in the **Shadow Realm** for private evidence and correlation, not as a pending broadcast."
>
> **Dev:** "If a shadow-dropped transaction later appears in a block, did Bouncer pass it?"
> **Domain expert:** "No. That is a **Shadow Escape**: the transaction was mined through some route other than Bouncer's Gate Node submission."
>
> **Dev:** "Should the Live Agent wait to see whether a shadow-dropped transaction gets mined?"
> **Domain expert:** "No. **Shadow Escape** detection is block monitoring outside the Live Agent's Decision Budget."
>
> **Dev:** "Should block monitoring read every Polar node?"
> **Domain expert:** "No. In the MVP, monitor new blocks from the **Gate Node** only."
>
> **Dev:** "If the Shadow Realm is full, should a shadow drop become a pass?"
> **Domain expert:** "No. **Shadow Drop** still withholds the transaction; the audit log records whether full payload storage degraded."

## Flagged ambiguities

- "Pi agent harness" is useful inspiration for the agent loop, but the live transaction path is the **Transaction Valve Harness** rather than a general-purpose coding-agent runtime.
- The agent may use highly concurrent inference, but overload fallback remains intentionally simple: default to pass, with hold only as an explicit bounded advanced mode.
- "agent" can mean either **Live Agent** or **Background Analyst**; when discussing runtime behavior, use the precise role.
- "drop" and "hold" were initially described as local downstream filtering, but the intended product direction includes **Relay Gate** behavior tested first in a Polar sandbox.
- The first **Relay Gate** boundary is a **Submission Gate**, not p2p interception or Bitcoin Core mempool policy integration.
- A local Polar network with three Bitcoin Core nodes can verify **Submission Gate** behavior by checking whether passed transactions propagate and held or dropped transactions do not appear in peer mempools.
- "accepted" and "relayed" must not be used internally for **Shadow Drop** transactions, because Bouncer withheld them from the Gate Node even if the submitter-facing response is success-shaped.
- "random peer" is imprecise for the smoke-test demo; use **Propagation Witness** for the non-Gate Polar Core node that checks visibility.
