import { createModels, createProvider, type Api, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ENV } from "../config";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-5";
const LM_STUDIO_PROVIDER = "lmstudio";
const LM_STUDIO_API_PROVIDER = "openai";
const DEFAULT_LM_STUDIO_BASE_URL = "http://localhost:1234/v1";
const DEFAULT_LM_STUDIO_API_KEY = "lm-studio";

export interface ResolvedModel {
  models: MutableModels;
  model: Model<Api>;
}

function resolveLmStudioModel(): ResolvedModel {
  const modelId = process.env[ENV.modelId];
  if (!modelId) {
    throw new Error(`${ENV.modelId} is required when ${ENV.modelProvider}=lmstudio (use an id from LM Studio's /v1/models)`);
  }

  const baseUrl = (process.env[ENV.modelBaseUrl] ?? DEFAULT_LM_STUDIO_BASE_URL).replace(/\/+$/, "");
  const model: Model<"openai-responses"> = {
    id: modelId,
    name: `LM Studio: ${modelId}`,
    api: "openai-responses",
    provider: LM_STUDIO_API_PROVIDER,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
  };
  const apiKey = process.env[ENV.modelApiKey] ?? DEFAULT_LM_STUDIO_API_KEY;
  const provider = createProvider({
    id: LM_STUDIO_API_PROVIDER,
    name: "LM Studio (OpenAI-compatible)",
    baseUrl,
    auth: {
      apiKey: {
        name: "LM Studio API key",
        resolve: async () => ({ auth: { apiKey }, source: process.env[ENV.modelApiKey] ? ENV.modelApiKey : "LM Studio default" }),
      },
    },
    models: [model],
    api: { "openai-responses": openAIResponsesApi() },
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}

/**
 * Provider/model are switchable via env vars so the underlying LLM isn't
 * hardwired to Anthropic — auth for whichever provider is selected is
 * resolved by pi-ai itself from that provider's standard env var (e.g.
 * ANTHROPIC_API_KEY), not read directly by the harness (CONCEPT.md principle 2).
 */
export function resolveModel(): ResolvedModel {
  const provider = process.env[ENV.modelProvider] ?? DEFAULT_PROVIDER;
  if (provider === LM_STUDIO_PROVIDER || provider === "lm-studio") {
    return resolveLmStudioModel();
  }

  const modelId = process.env[ENV.modelId] ?? DEFAULT_MODEL_ID;

  const models = builtinModels();
  const model = models.getModel(provider, modelId);
  if (!model) {
    throw new Error(`unknown model '${modelId}' for provider '${provider}' (set ${ENV.modelProvider}/${ENV.modelId})`);
  }
  return { models, model };
}
