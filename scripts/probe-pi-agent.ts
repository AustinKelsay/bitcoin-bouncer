#!/usr/bin/env tsx
import { createPiHttpAgentClient } from "../src/pi-http-agent-client.js";
import { probePiAgent } from "../src/pi-agent-probe.js";

const url = process.env.PI_AGENT_URL?.trim();

if (!url) {
  console.error("Missing required environment variable: PI_AGENT_URL");
  process.exit(1);
}

try {
  const action = await probePiAgent({
    client: createPiHttpAgentClient({ url }),
  });

  console.log(JSON.stringify(action, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Pi Agent probe failed: ${message}`);
  process.exit(1);
}
