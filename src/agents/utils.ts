import type { AgentConfig } from "@opencode-ai/sdk"
import type { BuiltinAgentName, AgentOverrideConfig, AgentOverrides, AgentFactory, AgentPromptMetadata } from "./types"
import type { CategoriesConfig, CategoryConfig } from "../config/schema"
import { createSisyphusAgent } from "./sisyphus"
import { createOracleAgent, ORACLE_PROMPT_METADATA } from "./oracle"
import { createLibrarianAgent, LIBRARIAN_PROMPT_METADATA } from "./librarian"
import { createExploreAgent, EXPLORE_PROMPT_METADATA } from "./explore"
import { createFrontendUiUxEngineerAgent, FRONTEND_PROMPT_METADATA } from "./frontend-ui-ux-engineer"
import { createDocumentWriterAgent, DOCUMENT_WRITER_PROMPT_METADATA } from "./document-writer"
import { createMultimodalLookerAgent, MULTIMODAL_LOOKER_PROMPT_METADATA } from "./multimodal-looker"
import { createMetisAgent } from "./metis"
import { createOrchestratorSisyphusAgent, orchestratorSisyphusAgent } from "./orchestrator-sisyphus"
import { createMomusAgent } from "./momus"
import type { AvailableAgent } from "./sisyphus-prompt-builder"
import { deepMerge } from "../shared"
import { DEFAULT_CATEGORIES } from "../tools/sisyphus-task/constants"
import { resolveMultipleSkills } from "../features/opencode-skill-loader/skill-content"

type AgentSource = AgentFactory | AgentConfig

const agentSources: Record<BuiltinAgentName, AgentSource> = {
  Sisyphus: createSisyphusAgent,
  oracle: createOracleAgent,
  librarian: createLibrarianAgent,
  explore: createExploreAgent,
  "frontend-ui-ux-engineer": createFrontendUiUxEngineerAgent,
  "document-writer": createDocumentWriterAgent,
  "multimodal-looker": createMultimodalLookerAgent,
  "Metis (Plan Consultant)": createMetisAgent,
  "Momus (Plan Reviewer)": createMomusAgent,
  "orchestrator-sisyphus": orchestratorSisyphusAgent,
}

/**
 * Metadata for each agent, used to build Sisyphus's dynamic prompt sections
 * (Delegation Table, Tool Selection, Key Triggers, etc.)
 */
const agentMetadata: Partial<Record<BuiltinAgentName, AgentPromptMetadata>> = {
  oracle: ORACLE_PROMPT_METADATA,
  librarian: LIBRARIAN_PROMPT_METADATA,
  explore: EXPLORE_PROMPT_METADATA,
  "frontend-ui-ux-engineer": FRONTEND_PROMPT_METADATA,
  "document-writer": DOCUMENT_WRITER_PROMPT_METADATA,
  "multimodal-looker": MULTIMODAL_LOOKER_PROMPT_METADATA,
}

function isFactory(source: AgentSource): source is AgentFactory {
  return typeof source === "function"
}

export function buildAgent(
  source: AgentSource,
  model?: string,
  categories?: CategoriesConfig,
  categoryNameOverride?: string
): AgentConfig {
  const base = { ...(isFactory(source) ? source(model) : source) } as AgentConfig
  const categoryConfigs: Record<string, CategoryConfig> = categories
    ? { ...DEFAULT_CATEGORIES, ...categories }
    : DEFAULT_CATEGORIES

  const agentWithCategory = base as AgentConfig & { category?: string; skills?: string[]; variant?: string }
  const categoryName = categoryNameOverride ?? agentWithCategory.category
  if (categoryName) {
    const categoryConfig = categoryConfigs[categoryName]
    if (categoryConfig) {
      // If an explicit model was provided to the factory (from override/category),
      // treat category settings as user-intent defaults and apply them even if the agent has built-in values.
      const isOverrideCategory = categoryNameOverride !== undefined

      if (model) {
        base.model = model
      } else if (!base.model) {
        base.model = categoryConfig.model
      }

      if (categoryConfig.temperature !== undefined && (isOverrideCategory || base.temperature === undefined)) {
        base.temperature = categoryConfig.temperature
      }
      if (categoryConfig.top_p !== undefined && (isOverrideCategory || (base as any).top_p === undefined)) {
        ;(base as any).top_p = categoryConfig.top_p
      }
      if (categoryConfig.maxTokens !== undefined && (isOverrideCategory || (base as any).maxTokens === undefined)) {
        ;(base as any).maxTokens = categoryConfig.maxTokens
      }
      if (categoryConfig.variant !== undefined && (isOverrideCategory || (base as any).variant === undefined)) {
        ;(base as any).variant = categoryConfig.variant
      }
      if (categoryConfig.thinking !== undefined && (isOverrideCategory || (base as any).thinking === undefined)) {
        ;(base as any).thinking = categoryConfig.thinking as any
      }
      if (categoryConfig.reasoningEffort !== undefined && (isOverrideCategory || (base as any).reasoningEffort === undefined)) {
        ;(base as any).reasoningEffort = categoryConfig.reasoningEffort
      }
      if (categoryConfig.textVerbosity !== undefined && (isOverrideCategory || (base as any).textVerbosity === undefined)) {
        ;(base as any).textVerbosity = categoryConfig.textVerbosity
      }
      if (categoryConfig.tools !== undefined && (isOverrideCategory || (base as any).tools === undefined)) {
        ;(base as any).tools = categoryConfig.tools as any
      }
      if (categoryConfig.prompt_append && (base as any).prompt) {
        ;(base as any).prompt = `${(base as any).prompt}\n${categoryConfig.prompt_append}`
      }
    }
  }

  if (agentWithCategory.skills?.length) {
    const { resolved } = resolveMultipleSkills(agentWithCategory.skills)
    if (resolved.size > 0) {
      const skillContent = Array.from(resolved.values()).join("\n\n")
      base.prompt = skillContent + (base.prompt ? "\n\n" + base.prompt : "")
    }
  }

  return base
}

/**
 * Creates OmO-specific environment context (time, timezone, locale).
 * Note: Working directory, platform, and date are already provided by OpenCode's system.ts,
 * so we only include fields that OpenCode doesn't provide to avoid duplication.
 * See: https://github.com/code-yeongyu/oh-my-opencode/issues/379
 */
export function createEnvContext(): string {
  const now = new Date()
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const locale = Intl.DateTimeFormat().resolvedOptions().locale

  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  })

  return `
<omo-env>
  Current time: ${timeStr}
  Timezone: ${timezone}
  Locale: ${locale}
</omo-env>`
}

function mergeAgentConfig(
  base: AgentConfig,
  override: AgentOverrideConfig
): AgentConfig {
  const { prompt_append, ...rest } = override
  const merged = deepMerge(base, rest as Partial<AgentConfig>)

  if (prompt_append && merged.prompt) {
    merged.prompt = merged.prompt + "\n" + prompt_append
  }

  return merged
}

export function createBuiltinAgents(
  disabledAgents: BuiltinAgentName[] = [],
  agentOverrides: AgentOverrides = {},
  directory?: string,
  systemDefaultModel?: string,
  categories?: CategoriesConfig
): Record<string, AgentConfig> {
  const result: Record<string, AgentConfig> = {}
  const availableAgents: AvailableAgent[] = []

  const mergedCategories = categories
    ? { ...DEFAULT_CATEGORIES, ...categories }
    : DEFAULT_CATEGORIES

  for (const [name, source] of Object.entries(agentSources)) {
    const agentName = name as BuiltinAgentName

    if (agentName === "Sisyphus") continue
    if (agentName === "orchestrator-sisyphus") continue
    if (disabledAgents.includes(agentName)) continue

    const override = agentOverrides[agentName]
    const categoryName = override?.category
    const categoryModel = categoryName ? mergedCategories[categoryName]?.model : undefined
    const model = override?.model ?? categoryModel

    let config = buildAgent(source, model, mergedCategories, categoryName)

    if (agentName === "librarian" && directory && config.prompt) {
      const envContext = createEnvContext()
      config = { ...config, prompt: config.prompt + envContext }
    }

    if (override) {
      config = mergeAgentConfig(config, override)
    }

    result[name] = config

    const metadata = agentMetadata[agentName]
    if (metadata) {
      availableAgents.push({
        name: agentName,
        description: config.description ?? "",
        metadata,
      })
    }
  }

  if (!disabledAgents.includes("Sisyphus")) {
    const sisyphusOverride = agentOverrides["Sisyphus"]
    const sisyphusCategoryName = sisyphusOverride?.category
    const sisyphusCategoryModel = sisyphusCategoryName ? mergedCategories[sisyphusCategoryName]?.model : undefined
    const sisyphusModel = sisyphusOverride?.model ?? sisyphusCategoryModel ?? systemDefaultModel

    let sisyphusConfig = createSisyphusAgent(sisyphusModel, availableAgents)

    if (sisyphusCategoryName) {
      sisyphusConfig = buildAgent(sisyphusConfig, sisyphusModel, mergedCategories, sisyphusCategoryName)
    }

    if (directory && sisyphusConfig.prompt) {
      const envContext = createEnvContext()
      sisyphusConfig = { ...sisyphusConfig, prompt: sisyphusConfig.prompt + envContext }
    }

    if (sisyphusOverride) {
      sisyphusConfig = mergeAgentConfig(sisyphusConfig, sisyphusOverride)
    }

    result["Sisyphus"] = sisyphusConfig
  }

  if (!disabledAgents.includes("orchestrator-sisyphus")) {
    const orchestratorOverride = agentOverrides["orchestrator-sisyphus"]
    const orchestratorCategoryName = orchestratorOverride?.category
    const orchestratorCategoryModel = orchestratorCategoryName ? mergedCategories[orchestratorCategoryName]?.model : undefined
    const orchestratorModel = orchestratorOverride?.model ?? orchestratorCategoryModel
    let orchestratorConfig = createOrchestratorSisyphusAgent({
      model: orchestratorModel,
      availableAgents,
    })

    if (orchestratorCategoryName) {
      orchestratorConfig = buildAgent(orchestratorConfig, orchestratorModel, mergedCategories, orchestratorCategoryName)
    }

    if (orchestratorOverride) {
      orchestratorConfig = mergeAgentConfig(orchestratorConfig, orchestratorOverride)
    }

    result["orchestrator-sisyphus"] = orchestratorConfig
  }

  return result
}
