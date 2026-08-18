import { expect, test } from "bun:test";

import type { TranscriptEntry } from "@mikan-919/oriel-contracts";
import { identity } from "@mikan-919/oriel-identity";

import type { DeviceRegistrationFlow } from "./device-registration";
import { openServeLocalState } from "./local-state";
import { createModelDefaultsStore } from "./model-defaults";
import { startServeHttpServer } from "./server";

function fakeDeviceRegistration(): DeviceRegistrationFlow {
  return {
    begin: () => ({ authorizeUrl: new URL("http://example.invalid") }),
    complete: async () => ({ status: "installations", installations: [] }),
    pendingCancellations: () => [],
    resumePendingCancellations: async () => [],
  } as unknown as DeviceRegistrationFlow;
}

async function withSession(origin: string) {
  const response = await fetch(`${origin}/`, {
    headers: { Origin: origin },
  });
  const html = await response.text();
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";

  return {
    cookie,
    csrf: /content="([^"]+)"/.exec(html)?.[1] ?? "",
  };
}

test("/api/transcripts is unavailable without configured search", async () => {
  const httpServer = startServeHttpServer({
    createDeviceRegistration: fakeDeviceRegistration,
  });

  try {
    const origin = httpServer.readinessUrl.origin;
    const { cookie } = await withSession(origin);
    const response = await fetch(
      `${origin}/api/transcripts?scope=local&query=foo`,
      { headers: { Origin: origin, cookie } },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "not_configured",
      message: expect.stringContaining("ORIEL_STATE_PATH"),
    });
  } finally {
    httpServer.close();
  }
});

test("/api/config returns configured public values and omits unset values", async () => {
  const modelDefaults = createModelDefaultsStore(
    openServeLocalState(":memory:"),
  );
  modelDefaults.set("base", { provider: "openai", id: "gpt-5" });
  modelDefaults.set("implementation", {
    provider: "lm-studio",
    id: "local-model",
  });
  const httpServer = startServeHttpServer({
    relayOrigin: "https://relay.example.test",
    repositoryId: 42,
    repositoryOwner: "mikan",
    modelProviderId: "lmstudio",
    modelDefaults,
  });

  try {
    const origin = httpServer.readinessUrl.origin;
    const { cookie } = await withSession(origin);
    const response = await fetch(`${origin}/api/config`, {
      headers: { Origin: origin, cookie },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      relayOrigin: "https://relay.example.test",
      repositoryId: 42,
      repositoryOwner: "mikan",
      modelProviderId: "lmstudio",
      modelDefaults: {
        base: { provider: "openai", modelId: "gpt-5" },
        perKind: {
          what_confirmation: null,
          how_confirmation: null,
          pr_response: null,
          implementation: {
            provider: "lm-studio",
            modelId: "local-model",
          },
        },
      },
    });
  } finally {
    httpServer.close();
  }
});

test("/api/config updates and clears model defaults with CSRF protection", async () => {
  const modelDefaults = createModelDefaultsStore(
    openServeLocalState(":memory:"),
  );
  const httpServer = startServeHttpServer({ modelDefaults });

  try {
    const origin = httpServer.readinessUrl.origin;
    const { cookie, csrf } = await withSession(origin);
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${origin}/api/config`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: origin,
          cookie,
          [`x-${identity.codeName}-csrf`]: csrf,
          ...headers,
        },
        body: JSON.stringify(body),
      });

    expect(
      (
        await fetch(`${origin}/api/config`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Origin: origin,
            cookie,
          },
          body: JSON.stringify({
            scope: "base",
            provider: "openai",
            modelId: "gpt-5",
          }),
        })
      ).status,
    ).toBe(403);

    const saved = await post({
      scope: "base",
      provider: "openai",
      modelId: "gpt-5",
    });

    expect(saved.status).toBe(200);
    expect(modelDefaults.get("base")).toEqual({
      provider: "openai",
      id: "gpt-5",
    });

    const normalized = await post({
      scope: "base",
      provider: " openai ",
      modelId: " gpt-5 ",
    });

    expect(normalized.status).toBe(200);
    expect(modelDefaults.get("base")).toEqual({
      provider: "openai",
      id: "gpt-5",
    });

    const perKind = await post({
      scope: "implementation",
      provider: "lm-studio",
      modelId: "local-model",
    });

    expect(perKind.status).toBe(200);
    expect(modelDefaults.get("implementation")).toEqual({
      provider: "lm-studio",
      id: "local-model",
    });

    const cleared = await post({
      scope: "implementation",
      provider: null,
      modelId: null,
    });

    expect(cleared.status).toBe(200);
    expect(modelDefaults.get("implementation")).toBeNull();

    expect(
      (await post({ scope: "unknown", provider: "openai", modelId: "gpt-5" }))
        .status,
    ).toBe(400);
    expect(
      (await post({ scope: "base", provider: "openai", modelId: "" })).status,
    ).toBe(400);
    expect(
      (await post({ scope: "base", provider: "   ", modelId: "gpt-5" })).status,
    ).toBe(400);
  } finally {
    httpServer.close();
  }
});

test("/api/models returns the injected model catalog", async () => {
  const models = [
    { provider: "openai", id: "gpt-5", name: "GPT-5" },
    { provider: "lm-studio", id: "local-model", name: "Local model" },
  ];
  const httpServer = startServeHttpServer({
    listModels: async () => models,
  });

  try {
    const origin = httpServer.readinessUrl.origin;
    const { cookie } = await withSession(origin);
    const response = await fetch(`${origin}/api/models`, {
      headers: { Origin: origin, cookie },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(models);
  } finally {
    httpServer.close();
  }
});

test("/api/transcripts rejects an unknown scope and returns matches for a valid one", async () => {
  const entries: TranscriptEntry[] = [
    {
      jobId: "job-1",
      sequence: 1,
      kind: "note",
      content: "hello",
      createdAt: 0,
    },
  ];
  const httpServer = startServeHttpServer({
    createDeviceRegistration: fakeDeviceRegistration,
    searchTranscripts: async () => entries,
  });

  try {
    const origin = httpServer.readinessUrl.origin;
    const { cookie } = await withSession(origin);

    const badScope = await fetch(
      `${origin}/api/transcripts?scope=bogus&query=foo`,
      { headers: { Origin: origin, cookie } },
    );

    expect(badScope.status).toBe(400);

    // queryを省略すると、Job展開ビューが使う「全件を時系列で」の一覧になる。
    const missingQuery = await fetch(`${origin}/api/transcripts?scope=local`, {
      headers: { Origin: origin, cookie },
    });

    expect(missingQuery.status).toBe(200);
    expect(await missingQuery.json()).toEqual({ entries });

    const ok = await fetch(`${origin}/api/transcripts?scope=local&query=foo`, {
      headers: { Origin: origin, cookie },
    });

    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ entries });
  } finally {
    httpServer.close();
  }
});
