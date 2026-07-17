import type { AdminExecutorsDto } from "@pablo/shared-types";
import { listExecutors } from "../../lib/engine-bridge-client.js";

/** engine-bridge being unreachable (not deployed yet, or down) is a normal
 * state for this console to render through, not an error to surface as a
 * 500 — the page should just say "can't reach the orchestrator" instead of
 * failing to load. */
export async function getExecutorsOverview(): Promise<AdminExecutorsDto> {
  try {
    const executors = await listExecutors();
    return { executors, reachable: true };
  } catch {
    return { executors: [], reachable: false };
  }
}
