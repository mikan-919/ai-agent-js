import { expect, test } from "bun:test";

import {
  createLinearApprovalReader,
  createLinearApprovalStateWriter,
} from "./linear-approval";

const linearIssueId = "0f6f6a0c-1c1e-4a0a-9f6e-2f5f1f3f4f5f";

function reader(respond: (request: Request) => Promise<Response>) {
  return createLinearApprovalReader({
    token: "linear-token",
    fetchImpl: respond,
  });
}

test("the current HOW is read with the token in the header only", async () => {
  const requests: { authorization: string | null; body: unknown }[] = [];
  const read = await reader(async (request) => {
    requests.push({
      authorization: request.headers.get("authorization"),
      body: await request.json(),
    });

    return Response.json({
      data: {
        issue: {
          id: linearIssueId,
          identifier: "ENG-12",
          title: "HOW title",
          description: "HOW description",
          state: { name: "Todo" },
          attachments: {
            nodes: [
              { url: "https://github.com/mikan-919/oriel/issues/28" },
              { url: "https://example.test/other" },
            ],
          },
        },
      },
    });
  }).readIssue(linearIssueId);

  expect(read).toEqual({
    issueId: linearIssueId,
    identifier: "ENG-12",
    title: "HOW title",
    description: "HOW description",
    stateName: "Todo",
    attachmentUrls: [
      "https://github.com/mikan-919/oriel/issues/28",
      "https://example.test/other",
    ],
  });
  expect(requests[0]?.authorization).toBe("linear-token");
  // tokenをURLやqueryへ載せない。
  expect(JSON.stringify(requests[0]?.body)).not.toContain("linear-token");
});

test("an unusable answer is refused rather than guessed", async () => {
  for (const respond of [
    async () => Response.json({ data: { issue: null } }),
    async () => Response.json({ errors: [{ message: "forbidden" }] }),
    async () => new Response("no", { status: 401 }),
    async () => {
      throw new Error("network");
    },
    async () =>
      Response.json({
        data: {
          issue: {
            id: linearIssueId,
            identifier: "ENG-12",
            title: "HOW title",
            state: null,
            attachments: { nodes: [] },
          },
        },
      }),
  ]) {
    expect(await reader(respond).readIssue(linearIssueId)).toBeNull();
  }
});

function stateWriter(respond: (request: Request) => Promise<Response>) {
  return createLinearApprovalStateWriter({
    token: "linear-token",
    fetchImpl: respond,
  });
}

test("the current Linear state is read as a plain name and is null when unusable", async () => {
  expect(
    await stateWriter(async () =>
      Response.json({ data: { issue: { state: { name: "Todo" } } } }),
    ).readLinearState(linearIssueId),
  ).toBe("Todo");

  // 読めない答えを既定値へ落とさない。
  for (const payload of [
    { data: { issue: null } },
    { data: { issue: { state: null } } },
    { errors: [{ message: "forbidden" }], data: { issue: null } },
  ]) {
    expect(
      await stateWriter(async () => Response.json(payload)).readLinearState(
        linearIssueId,
      ),
    ).toBeNull();
  }

  expect(
    await stateWriter(async () => {
      throw new Error("fetch failed");
    }).readLinearState(linearIssueId),
  ).toBeNull();
});

test("the return to Triage resolves the team state by name and never guesses one", async () => {
  const sent: Record<string, unknown>[] = [];
  const moved = await stateWriter(async (request) => {
    const body = (await request.json()) as {
      query: string;
      variables?: Record<string, unknown>;
    };

    sent.push(body);

    return body.query.includes("issueUpdate")
      ? Response.json({ data: { issueUpdate: { success: true } } })
      : Response.json({
          data: {
            issue: {
              team: {
                states: {
                  nodes: [
                    { id: "state-todo", name: "Todo" },
                    { id: "state-triage", name: "Triage" },
                  ],
                },
              },
            },
          },
        });
  }).moveToTriage(linearIssueId);

  expect(moved).toBe(true);
  expect(sent[1]?.variables).toEqual({
    id: linearIssueId,
    stateId: "state-triage",
  });

  // Triage stateを一意に決められないteamでは何も書かない。
  const attempted: string[] = [];

  expect(
    await stateWriter(async (request) => {
      const body = (await request.json()) as { query: string };

      attempted.push(body.query);

      return Response.json({
        data: {
          issue: { team: { states: { nodes: [{ id: "s", name: "Todo" }] } } },
        },
      });
    }).moveToTriage(linearIssueId),
  ).toBe(false);
  expect(attempted).toHaveLength(1);
});
