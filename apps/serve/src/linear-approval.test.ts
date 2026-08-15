import { expect, test } from "bun:test";

import { createLinearApprovalReader } from "./linear-approval";

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
