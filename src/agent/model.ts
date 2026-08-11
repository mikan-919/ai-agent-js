import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { ENV } from "../config";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-5";

export interface ResolvedModel {
  models: MutableModels;
  model: Model<Api>;
}

/**
 * Provider/model are switchable via env vars so the underlying LLM isn't
 * hardwired to Anthropic — auth for whichever provider is selected is
 * resolved by pi-ai itself from that provider's standard env var (e.g.
 * ANTHROPIC_API_KEY), not read directly by the harness (CONCEPT.md principle 2).
 */
export function resolveModel(): ResolvedModel {
  const provider = process.env[ENV.modelProvider] ?? DEFAULT_PROVIDER;
  const modelId = process.env[ENV.modelId] ?? DEFAULT_MODEL_ID;

  const models = builtinModels();
  const model = models.getModel(provider, modelId);
  if (!model) {
    throw new Error(`unknown model '${modelId}' for provider '${provider}' (set ${ENV.modelProvider}/${ENV.modelId})`);
  }
  return { models, model };
}
