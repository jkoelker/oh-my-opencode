import { createBuiltinAgents } from "../agents";
import { createSisyphusJuniorAgent } from "../agents/sisyphus-junior";
import {
  loadUserCommands,
  loadProjectCommands,
  loadOpencodeGlobalCommands,
  loadOpencodeProjectCommands,
} from "../features/claude-code-command-loader";
import { loadBuiltinCommands } from "../features/builtin-commands";
import {
  loadUserSkills,
  loadProjectSkills,
  loadOpencodeGlobalSkills,
  loadOpencodeProjectSkills,
} from "../features/opencode-skill-loader";
import {
  loadUserAgents,
  loadProjectAgents,
} from "../features/claude-code-agent-loader";
import { loadMcpConfigs } from "../features/claude-code-mcp-loader";
import { loadAllPluginComponents } from "../features/claude-code-plugin-loader";
import { createBuiltinMcps } from "../mcp";
import type { OhMyOpenCodeConfig } from "../config";
import { log } from "../shared";
import { migrateAgentConfig } from "../shared/permission-compat";
import { PROMETHEUS_SYSTEM_PROMPT, PROMETHEUS_PERMISSION } from "../agents/prometheus-prompt";
import type { ModelCacheState } from "../plugin-state";
import { DEFAULT_CATEGORIES } from "../tools/sisyphus-task/constants";

export interface ConfigHandlerDeps {
  ctx: { directory: string };
  pluginConfig: OhMyOpenCodeConfig;
  modelCacheState: ModelCacheState;
}

export function createConfigHandler(deps: ConfigHandlerDeps) {
  const { ctx, pluginConfig, modelCacheState } = deps;

  return async (config: Record<string, unknown>) => {
    type ProviderConfig = {
      options?: { headers?: Record<string, string> };
      models?: Record<string, { limit?: { context?: number } }>;
    };
    const providers = config.provider as
      | Record<string, ProviderConfig>
      | undefined;

    const anthropicBeta =
      providers?.anthropic?.options?.headers?.["anthropic-beta"];
    modelCacheState.anthropicContext1MEnabled =
      anthropicBeta?.includes("context-1m") ?? false;

    if (providers) {
      for (const [providerID, providerConfig] of Object.entries(providers)) {
        const models = providerConfig?.models;
        if (models) {
          for (const [modelID, modelConfig] of Object.entries(models)) {
            const contextLimit = modelConfig?.limit?.context;
            if (contextLimit) {
              modelCacheState.modelContextLimitsCache.set(
                `${providerID}/${modelID}`,
                contextLimit
              );
            }
          }
        }
      }
    }

    const pluginComponents = (pluginConfig.claude_code?.plugins ?? true)
      ? await loadAllPluginComponents({
          enabledPluginsOverride: pluginConfig.claude_code?.plugins_override,
        })
      : {
          commands: {},
          skills: {},
          agents: {},
          mcpServers: {},
          hooksConfigs: [],
          plugins: [],
          errors: [],
        };

    if (pluginComponents.plugins.length > 0) {
      log(`Loaded ${pluginComponents.plugins.length} Claude Code plugins`, {
        plugins: pluginComponents.plugins.map((p) => `${p.name}@${p.version}`),
      });
    }

    if (pluginComponents.errors.length > 0) {
      log(`Plugin load errors`, { errors: pluginComponents.errors });
    }

    const builtinAgents = createBuiltinAgents(
      pluginConfig.disabled_agents,
      pluginConfig.agents,
      ctx.directory,
      config.model as string | undefined,
      pluginConfig.categories
    );

    const mergedCategories = pluginConfig.categories
      ? { ...DEFAULT_CATEGORIES, ...pluginConfig.categories }
      : DEFAULT_CATEGORIES;

    // Claude Code agents: Do NOT apply permission migration
    // Claude Code uses whitelist-based tools format which is semantically different
    // from OpenCode's denylist-based permission system
    const userAgents = (pluginConfig.claude_code?.agents ?? true)
      ? loadUserAgents()
      : {};
    const projectAgents = (pluginConfig.claude_code?.agents ?? true)
      ? loadProjectAgents()
      : {};

    // Plugin agents: Apply permission migration for compatibility
    const rawPluginAgents = pluginComponents.agents;
    const pluginAgents = Object.fromEntries(
      Object.entries(rawPluginAgents).map(([k, v]) => [
        k,
        v ? migrateAgentConfig(v as Record<string, unknown>) : v,
      ])
    );

    const isSisyphusEnabled = pluginConfig.sisyphus_agent?.disabled !== true;
    const builderEnabled =
      pluginConfig.sisyphus_agent?.default_builder_enabled ?? false;
    const plannerEnabled =
      pluginConfig.sisyphus_agent?.planner_enabled ?? true;
    const replacePlan = pluginConfig.sisyphus_agent?.replace_plan ?? true;

    type AgentConfig = Record<
      string,
      Record<string, unknown> | undefined
    > & {
      build?: Record<string, unknown>;
      plan?: Record<string, unknown>;
      explore?: { tools?: Record<string, unknown> };
      librarian?: { tools?: Record<string, unknown> };
      "multimodal-looker"?: { tools?: Record<string, unknown> };
      "orchestrator-sisyphus"?: { tools?: Record<string, unknown> };
    };
    const configAgent = config.agent as AgentConfig | undefined;

    if (isSisyphusEnabled && builtinAgents.Sisyphus) {
      (config as { default_agent?: string }).default_agent = "Sisyphus";

      const agentConfig: Record<string, unknown> = {
        Sisyphus: builtinAgents.Sisyphus,
      };

      const sisyphusJuniorOverride = pluginConfig.agents?.["Sisyphus-Junior"];
      const sisyphusJuniorCategoryName = sisyphusJuniorOverride?.category;
      const sisyphusJuniorCategoryConfig = sisyphusJuniorCategoryName
        ? mergedCategories[sisyphusJuniorCategoryName]
        : undefined;
      const sisyphusJuniorModel =
        sisyphusJuniorOverride?.model ??
        sisyphusJuniorCategoryConfig?.model ??
        "anthropic/claude-sonnet-4-5";

      const sisyphusJuniorPromptAppend = [
        sisyphusJuniorCategoryConfig?.prompt_append,
        sisyphusJuniorOverride?.prompt_append,
      ]
        .filter(Boolean)
        .join("\n\n") || undefined;

      agentConfig["Sisyphus-Junior"] = createSisyphusJuniorAgent(
        {
          ...(sisyphusJuniorCategoryConfig ?? { model: sisyphusJuniorModel }),
          model: sisyphusJuniorModel,
          ...(sisyphusJuniorOverride?.temperature !== undefined
            ? { temperature: sisyphusJuniorOverride.temperature }
            : {}),
          ...(sisyphusJuniorOverride?.top_p !== undefined
            ? { top_p: sisyphusJuniorOverride.top_p }
            : {}),
          ...(sisyphusJuniorOverride?.maxTokens !== undefined
            ? { maxTokens: sisyphusJuniorOverride.maxTokens }
            : {}),
          ...(sisyphusJuniorOverride?.thinking !== undefined
            ? { thinking: sisyphusJuniorOverride.thinking }
            : {}),
          ...(sisyphusJuniorOverride?.reasoningEffort !== undefined
            ? { reasoningEffort: sisyphusJuniorOverride.reasoningEffort }
            : {}),
          ...(sisyphusJuniorOverride?.textVerbosity !== undefined
            ? { textVerbosity: sisyphusJuniorOverride.textVerbosity }
            : {}),
          ...(sisyphusJuniorOverride?.tools !== undefined
            ? { tools: sisyphusJuniorOverride.tools }
            : {}),
        },
        sisyphusJuniorPromptAppend
      );

      if (builderEnabled) {
        const { name: _buildName, ...buildConfigWithoutName } =
          configAgent?.build ?? {};
        const migratedBuildConfig = migrateAgentConfig(
          buildConfigWithoutName as Record<string, unknown>
        );
        const openCodeBuilderOverride =
          pluginConfig.agents?.["OpenCode-Builder"];
        const openCodeBuilderBase = {
          ...migratedBuildConfig,
          description: `${configAgent?.build?.description ?? "Build agent"} (OpenCode default)`,
        };

        const openCodeBuilderCategoryName = openCodeBuilderOverride?.category;
        const openCodeBuilderCategoryConfig = openCodeBuilderCategoryName
          ? mergedCategories[openCodeBuilderCategoryName]
          : undefined;
        const openCodeBuilderModel =
          openCodeBuilderOverride?.model ??
          openCodeBuilderCategoryConfig?.model ??
          (openCodeBuilderBase as { model?: string }).model;

        let openCodeBuilderConfig: Record<string, unknown> = {
          ...openCodeBuilderBase,
          ...(openCodeBuilderModel ? { model: openCodeBuilderModel } : {}),
        };

        if (openCodeBuilderCategoryConfig && openCodeBuilderCategoryName) {
          // Apply category defaults first; explicit overrides applied below.
          openCodeBuilderConfig = {
            ...openCodeBuilderConfig,
            ...(openCodeBuilderCategoryConfig.temperature !== undefined
              ? { temperature: openCodeBuilderCategoryConfig.temperature }
              : {}),
            ...(openCodeBuilderCategoryConfig.top_p !== undefined
              ? { top_p: openCodeBuilderCategoryConfig.top_p }
              : {}),
            ...(openCodeBuilderCategoryConfig.maxTokens !== undefined
              ? { maxTokens: openCodeBuilderCategoryConfig.maxTokens }
              : {}),
            ...(openCodeBuilderCategoryConfig.thinking !== undefined
              ? { thinking: openCodeBuilderCategoryConfig.thinking }
              : {}),
            ...(openCodeBuilderCategoryConfig.reasoningEffort !== undefined
              ? { reasoningEffort: openCodeBuilderCategoryConfig.reasoningEffort }
              : {}),
            ...(openCodeBuilderCategoryConfig.textVerbosity !== undefined
              ? { textVerbosity: openCodeBuilderCategoryConfig.textVerbosity }
              : {}),
            ...(openCodeBuilderCategoryConfig.tools !== undefined
              ? { tools: openCodeBuilderCategoryConfig.tools }
              : {}),
          };

          if (
            openCodeBuilderCategoryConfig.prompt_append &&
            (openCodeBuilderConfig as { prompt?: string }).prompt
          ) {
            openCodeBuilderConfig.prompt = `${(openCodeBuilderConfig as { prompt: string }).prompt}\n${openCodeBuilderCategoryConfig.prompt_append}`;
          }
        }

        const { category: _cat, ...openCodeBuilderOverrideRest } =
          openCodeBuilderOverride ?? {};
        agentConfig["OpenCode-Builder"] = openCodeBuilderOverride
          ? { ...openCodeBuilderConfig, ...openCodeBuilderOverrideRest }
          : openCodeBuilderConfig;
      }

      if (plannerEnabled) {
        const { name: _planName, mode: _planMode, ...planConfigWithoutName } =
          configAgent?.plan ?? {};
        const migratedPlanConfig = migrateAgentConfig(
          planConfigWithoutName as Record<string, unknown>
        );
        const prometheusOverride =
          pluginConfig.agents?.["Prometheus (Planner)"];
        const defaultModel = config.model as string | undefined;
        const prometheusCategoryName = prometheusOverride?.category;
        const prometheusCategoryConfig = prometheusCategoryName
          ? mergedCategories[prometheusCategoryName]
          : undefined;
        const prometheusModel =
          prometheusOverride?.model ??
          prometheusCategoryConfig?.model ??
          defaultModel ??
          "anthropic/claude-opus-4-5";
        const prometheusBase = {
          model: prometheusModel,
          mode: "primary" as const,
          prompt: PROMETHEUS_SYSTEM_PROMPT,
          permission: PROMETHEUS_PERMISSION,
          description: `${configAgent?.plan?.description ?? "Plan agent"} (Prometheus - OhMyOpenCode)`,
          color: (configAgent?.plan?.color as string) ?? "#FF6347",
        };

        let prometheusConfig: Record<string, unknown> = prometheusBase;

        if (prometheusCategoryConfig && prometheusCategoryName) {
          // Apply category defaults first; explicit overrides applied below.
          prometheusConfig = {
            ...prometheusConfig,
            ...(prometheusCategoryConfig.temperature !== undefined
              ? { temperature: prometheusCategoryConfig.temperature }
              : {}),
            ...(prometheusCategoryConfig.top_p !== undefined
              ? { top_p: prometheusCategoryConfig.top_p }
              : {}),
            ...(prometheusCategoryConfig.maxTokens !== undefined
              ? { maxTokens: prometheusCategoryConfig.maxTokens }
              : {}),
            ...(prometheusCategoryConfig.thinking !== undefined
              ? { thinking: prometheusCategoryConfig.thinking }
              : {}),
            ...(prometheusCategoryConfig.reasoningEffort !== undefined
              ? { reasoningEffort: prometheusCategoryConfig.reasoningEffort }
              : {}),
            ...(prometheusCategoryConfig.textVerbosity !== undefined
              ? { textVerbosity: prometheusCategoryConfig.textVerbosity }
              : {}),
            ...(prometheusCategoryConfig.tools !== undefined
              ? { tools: prometheusCategoryConfig.tools }
              : {}),
          };

          if (prometheusCategoryConfig.prompt_append) {
            prometheusConfig.prompt = `${prometheusBase.prompt}\n${prometheusCategoryConfig.prompt_append}`;
          }
        }

        const { category: _cat, ...prometheusOverrideRest } =
          prometheusOverride ?? {};
        agentConfig["Prometheus (Planner)"] = prometheusOverride
          ? { ...prometheusConfig, ...prometheusOverrideRest }
          : prometheusConfig;
      }

    const filteredConfigAgents = configAgent
      ? Object.fromEntries(
          Object.entries(configAgent)
            .filter(([key]) => {
              if (key === "build") return false;
              if (key === "plan" && replacePlan) return false;
              return true;
            })
            .map(([key, value]) => [
              key,
              value ? migrateAgentConfig(value as Record<string, unknown>) : value,
            ])
        )
      : {};

      const migratedBuild = configAgent?.build
        ? migrateAgentConfig(configAgent.build as Record<string, unknown>)
        : {};

      const planDemoteConfig = replacePlan
        ? { mode: "subagent" as const, hidden: true }
        : undefined;

      config.agent = {
        ...agentConfig,
        ...Object.fromEntries(
          Object.entries(builtinAgents).filter(([k]) => k !== "Sisyphus")
        ),
        ...userAgents,
        ...projectAgents,
        ...pluginAgents,
        ...filteredConfigAgents,
        build: { ...migratedBuild, mode: "subagent", hidden: true },
        ...(planDemoteConfig ? { plan: planDemoteConfig } : {}),
      };
    } else {
      config.agent = {
        ...builtinAgents,
        ...userAgents,
        ...projectAgents,
        ...pluginAgents,
        ...configAgent,
      };
    }

    const agentResult = config.agent as Record<string, AgentConfig>;

    config.tools = {
      ...(config.tools as Record<string, unknown>),
      "grep_app_*": false,
    };

    if (agentResult.explore) {
      agentResult.explore.tools = {
        ...agentResult.explore.tools,
        call_omo_agent: false,
      };
    }
    if (agentResult.librarian) {
      agentResult.librarian.tools = {
        ...agentResult.librarian.tools,
        call_omo_agent: false,
        "grep_app_*": true,
      };
    }
    if (agentResult["multimodal-looker"]) {
      agentResult["multimodal-looker"].tools = {
        ...agentResult["multimodal-looker"].tools,
        task: false,
        call_omo_agent: false,
        look_at: false,
      };
    }
    if (agentResult["orchestrator-sisyphus"]) {
      agentResult["orchestrator-sisyphus"].tools = {
        ...agentResult["orchestrator-sisyphus"].tools,
        task: false,
        call_omo_agent: false,
      };
    }

    config.permission = {
      ...(config.permission as Record<string, unknown>),
      webfetch: "allow",
      external_directory: "allow",
    };

    const mcpResult = (pluginConfig.claude_code?.mcp ?? true)
      ? await loadMcpConfigs()
      : { servers: {} };

    config.mcp = {
      ...(config.mcp as Record<string, unknown>),
      ...createBuiltinMcps(pluginConfig.disabled_mcps),
      ...mcpResult.servers,
      ...pluginComponents.mcpServers,
    };

    const builtinCommands = loadBuiltinCommands(pluginConfig.disabled_commands);
    const systemCommands = (config.command as Record<string, unknown>) ?? {};

    // Parallel loading of all commands and skills for faster startup
    const includeClaudeCommands = pluginConfig.claude_code?.commands ?? true;
    const includeClaudeSkills = pluginConfig.claude_code?.skills ?? true;

    const [
      userCommands,
      projectCommands,
      opencodeGlobalCommands,
      opencodeProjectCommands,
      userSkills,
      projectSkills,
      opencodeGlobalSkills,
      opencodeProjectSkills,
    ] = await Promise.all([
      includeClaudeCommands ? loadUserCommands() : Promise.resolve({}),
      includeClaudeCommands ? loadProjectCommands() : Promise.resolve({}),
      loadOpencodeGlobalCommands(),
      loadOpencodeProjectCommands(),
      includeClaudeSkills ? loadUserSkills() : Promise.resolve({}),
      includeClaudeSkills ? loadProjectSkills() : Promise.resolve({}),
      loadOpencodeGlobalSkills(),
      loadOpencodeProjectSkills(),
    ]);

    config.command = {
      ...builtinCommands,
      ...userCommands,
      ...userSkills,
      ...opencodeGlobalCommands,
      ...opencodeGlobalSkills,
      ...systemCommands,
      ...projectCommands,
      ...projectSkills,
      ...opencodeProjectCommands,
      ...opencodeProjectSkills,
      ...pluginComponents.commands,
      ...pluginComponents.skills,
    };
  };
}
