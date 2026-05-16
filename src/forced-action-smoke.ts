import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAction } from "./domain.js";

export type ForcedSmokeAction = AgentAction["action"];

export type ForcedActionExpectation = {
  auditOutcome: ForcedSmokeAction;
  propagation: "present" | "absent";
  submitterResponse: "submitted" | "held" | "dropped" | "txid-only";
  operatorEvidence?: "tag-label" | "hold-queue" | "drop-audit" | "shadow-realm";
};

const forcedActionExpectations: Record<
  ForcedSmokeAction,
  ForcedActionExpectation
> = {
  pass: {
    auditOutcome: "pass",
    propagation: "present",
    submitterResponse: "submitted",
  },
  tag: {
    auditOutcome: "tag",
    propagation: "present",
    submitterResponse: "submitted",
    operatorEvidence: "tag-label",
  },
  hold: {
    auditOutcome: "hold",
    propagation: "absent",
    submitterResponse: "held",
    operatorEvidence: "hold-queue",
  },
  drop: {
    auditOutcome: "drop",
    propagation: "absent",
    submitterResponse: "dropped",
    operatorEvidence: "drop-audit",
  },
  shadow_drop: {
    auditOutcome: "shadow_drop",
    propagation: "absent",
    submitterResponse: "txid-only",
    operatorEvidence: "shadow-realm",
  },
};

export function expectedForcedActionOutcome(
  action: ForcedSmokeAction,
): ForcedActionExpectation {
  return forcedActionExpectations[action];
}

export function validateForcedActionObservation(input: {
  action: ForcedSmokeAction;
  response: unknown;
  audit: unknown;
}) {
  const observedAction = observedActionFromResponse(input.response);
  const auditText = JSON.stringify(input.audit);

  if (auditText.includes("live_agent_fallback")) {
    throw new Error(
      `Expected forced ${input.action}, observed ${observedAction} with Live Agent fallback`,
    );
  }

  if (observedAction !== input.action) {
    throw new Error(`Expected forced ${input.action}, observed ${observedAction}`);
  }

  const expectation = expectedForcedActionOutcome(input.action);
  const auditOutcome = firstAuditOutcome(input.audit);

  if (auditOutcome !== expectation.auditOutcome) {
    throw new Error(
      `Expected audit outcome ${expectation.auditOutcome}, observed ${auditOutcome}`,
    );
  }
}

export function buildSmokeDirectivePrompt(input: {
  basePrompt: string;
  action: ForcedSmokeAction;
}): string {
  return `${input.basePrompt.trim()}

## Smoke Directive

This is a local forced-action smoke run.

For the next valid candidate transaction, call the \`${input.action}\` tool exactly once.
Do not choose any other terminal tool.
Do not explain the decision in prose.
Use the required tool arguments described below:
${toolArgumentDirective(input.action)}
`;
}

export async function writeSmokeDirectivePrompt(input: {
  directory: string;
  basePrompt: string;
  action: ForcedSmokeAction;
}): Promise<string> {
  await mkdir(input.directory, { recursive: true });
  const promptPath = join(input.directory, `force-${input.action}.md`);
  await writeFile(
    promptPath,
    buildSmokeDirectivePrompt({
      basePrompt: input.basePrompt,
      action: input.action,
    }),
    "utf8",
  );

  return promptPath;
}

function toolArgumentDirective(action: ForcedSmokeAction): string {
  if (action === "tag") {
    return "- For `tag`, use label `forced-smoke-tag`.";
  }

  if (action === "hold" || action === "drop" || action === "shadow_drop") {
    return `- For \`${action}\`, use reason \`forced smoke ${action}\`.`;
  }

  return "- For `pass`, omit the optional reason.";
}

function observedActionFromResponse(response: unknown): string {
  if (!isRecord(response)) {
    return "unknown";
  }

  if (response.status === "held") {
    return "hold";
  }

  if (response.status === "dropped") {
    return "drop";
  }

  if (response.status === "submitted" && typeof response.action === "string") {
    return response.action;
  }

  if (!("status" in response) && typeof response.txid === "string") {
    return "shadow_drop";
  }

  return "unknown";
}

function firstAuditOutcome(audit: unknown): string {
  if (!isRecord(audit) || !Array.isArray(audit.events)) {
    return "unknown";
  }

  const [event] = audit.events;

  if (!isRecord(event) || typeof event.outcome !== "string") {
    return "unknown";
  }

  return event.outcome;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
