import { expect, test } from "bun:test";

import type { TranscriptEntry } from "@mikan-919/oriel-contracts";

import type { DeviceRegistrationFlow } from "./device-registration";
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
  const httpServer = startServeHttpServer({
    relayOrigin: "https://relay.example.test",
    repositoryId: 42,
    repositoryOwner: "mikan",
    modelProviderId: "lmstudio",
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
    });
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
