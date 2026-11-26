// Types for the helpers agent.mjs exports to unit tests. On a box the file
// runs as plain node; the worker embeds it via the generated
// src/worker/runner/image/agent-b64.ts, not by importing it.
export interface RunAsUser {
  name: string
  uid: number
  gid: number
  home: string
}
export function isSafeRunId(runId: unknown): boolean
export function commandEnv(
  agentEnv: Record<string, string | undefined>,
  identity: RunAsUser | null,
  extra?: Record<string, string>,
): Record<string, string>
