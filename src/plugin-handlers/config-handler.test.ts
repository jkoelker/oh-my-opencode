import { describe, expect, mock, test } from "bun:test"

mock.module("../features/claude-code-plugin-loader", () => ({
  loadAllPluginComponents: async () => ({
    commands: {},
    skills: {},
    agents: {},
    mcpServers: {},
    hooksConfigs: [],
    plugins: [],
    errors: [],
  }),
}))

mock.module("../features/claude-code-agent-loader", () => ({
  loadUserAgents: () => ({}),
  loadProjectAgents: () => ({}),
}))

mock.module("../features/claude-code-command-loader", () => ({
  loadUserCommands: async () => ({}),
  loadProjectCommands: async () => ({}),
  loadOpencodeGlobalCommands: async () => ({}),
  loadOpencodeProjectCommands: async () => ({}),
}))

mock.module("../features/opencode-skill-loader", () => ({
  loadUserSkills: async () => ({}),
  loadProjectSkills: async () => ({}),
  loadOpencodeGlobalSkills: async () => ({}),
  loadOpencodeProjectSkills: async () => ({}),
}))

mock.module("../features/claude-code-mcp-loader", () => ({
  loadMcpConfigs: async () => ({ servers: {} }),
}))

mock.module("../features/builtin-commands", () => ({
  loadBuiltinCommands: () => ({}),
}))

mock.module("../mcp", () => ({
  createBuiltinMcps: () => ({}),
}))

import { createConfigHandler } from "./config-handler"
import { createModelCacheState } from "../plugin-state"

describe("config-handler - category overrides for special agents", () => {
  test("Prometheus (Planner) uses pluginConfig.agents category model (not config.model default)", async () => {
    // #given
    const handler = createConfigHandler({
      ctx: { directory: "/tmp/project" },
      modelCacheState: createModelCacheState(),
      pluginConfig: {
        claude_code: { plugins: false, agents: false, commands: false, skills: false, mcp: false },
        categories: {
          general: { model: "openai/gpt-5.2", temperature: 0.3, variant: "high" },
        },
        agents: {
          "Prometheus (Planner)": { category: "general" },
        },
        sisyphus_agent: { planner_enabled: true, replace_plan: true },
      },
    })

    const config: Record<string, unknown> = {
      model: "anthropic/claude-opus-4-5",
      agent: { plan: { description: "Plan agent", color: "#FF6347" } },
    }

    // #when
    await handler(config)

    // #then
    const agents = (config as { agent: Record<string, any> }).agent
    expect(agents["Prometheus (Planner)"].model).toBe("openai/gpt-5.2")
    expect(agents["Prometheus (Planner)"].temperature).toBe(0.3)
  })

  test("Sisyphus-Junior uses pluginConfig.agents category model", async () => {
    // #given
    const handler = createConfigHandler({
      ctx: { directory: "/tmp/project" },
      modelCacheState: createModelCacheState(),
      pluginConfig: {
        claude_code: { plugins: false, agents: false, commands: false, skills: false, mcp: false },
        categories: {
          general: { model: "openai/gpt-5.2", temperature: 0.1 },
        },
        agents: {
          "Sisyphus-Junior": { category: "general" },
        },
      },
    })

    const config: Record<string, unknown> = {
      model: "anthropic/claude-opus-4-5",
      agent: {},
    }

    // #when
    await handler(config)

    // #then
    const agents = (config as { agent: Record<string, any> }).agent
    expect(agents["Sisyphus-Junior"].model).toBe("openai/gpt-5.2")
  })
})

