// AgentBackend: the internal seam where a step's agent is created. The engine orchestrates (budget, live caps, retries,
// cancellation, structured results) and asks a backend for the agent; it does not know where the agent runs.
//
// Today there is one backend, the local one: `Agent.create` with the SDK's `local` options. The cloud spec (#5) adds a
// second behind this same interface (ADR-0005); turning the seam into a public extension point is spec #3's. Tests do
// not fake a backend: the fake Cursor SDK (test/fake-sdk.ts) stays the single substitution point.
import { Agent, type AgentOptions, type LocalAgentOptions, type SDKAgent } from "@cursor/sdk";

/** Where a step runs. The global cap `allowedLocations` decides which ones a run may use. */
export type StepLocation = "local" | "cloud";

/** What a step's agent needs, whatever backend creates it. */
export interface AgentSpec extends Pick<AgentOptions, "apiKey" | "tools" | "disallowedTools" | "agents" | "mcpServers"> {
  name: string;
  model: NonNullable<AgentOptions["model"]>;
  cwd: string;
  settingSources: NonNullable<LocalAgentOptions["settingSources"]>;
  /** Run the agent's commands in the SDK sandbox. */
  sandbox: boolean;
  customTools?: LocalAgentOptions["customTools"];
}

export interface AgentBackend {
  readonly location: StepLocation;
  create(spec: AgentSpec): Promise<SDKAgent>;
}

/** Runs the agent on this machine, in the step's cwd. */
export const localBackend: AgentBackend = {
  location: "local",
  create: (s) =>
    Agent.create({
      apiKey: s.apiKey,
      name: s.name,
      model: s.model,
      tools: s.tools,
      disallowedTools: s.disallowedTools,
      agents: s.agents,
      mcpServers: s.mcpServers,
      local: {
        cwd: s.cwd,
        settingSources: s.settingSources,
        sandboxOptions: s.sandbox ? { enabled: true } : undefined,
        customTools: s.customTools,
      },
    }),
};
