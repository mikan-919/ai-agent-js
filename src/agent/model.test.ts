import { afterEach, describe, expect, test } from "bun:test";
import { ENV } from "../config";
import { resolveModel } from "./model";

const modelEnvironmentKeys = [ENV.modelApiKey, ENV.modelBaseUrl, ENV.modelId, ENV.modelProvider] as const;
const originalEnvironment = new Map<string, string | undefined>();

for (const key of modelEnvironmentKeys) originalEnvironment.set(key, process.env[key]);

afterEach(() => {
  for (const key of modelEnvironmentKeys) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveModel", () => {
  test("resolves an arbitrary LM Studio model through the OpenAI Responses API", async () => {
    process.env[ENV.modelProvider] = "lmstudio";
    process.env[ENV.modelId] = "qwen/qwen3-8b";
    process.env[ENV.modelBaseUrl] = "http://localhost:1234/v1/";

    const resolved = resolveModel();
    const auth = await resolved.models.getAuth(resolved.model);

    expect(resolved.model.id).toBe("qwen/qwen3-8b");
    expect(resolved.model.provider).toBe("openai");
    expect(resolved.model.baseUrl).toBe("http://localhost:1234/v1");
    expect(auth?.auth.apiKey).toBe("lm-studio");
  });

  test("requires a model id for LM Studio", () => {
    process.env[ENV.modelProvider] = "lmstudio";
    delete process.env[ENV.modelId];

    expect(() => resolveModel()).toThrow(`${ENV.modelId} is required`);
  });
});
