import { expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";

import { createGitHubApprovalPorts } from "./github-approval-ports";

const repository = { owner: "mikan-919", name: "oriel" };
const baseOid = "1111111111111111111111111111111111111111";

function ports(
  graphql: (
    query: string,
    variables: Record<string, unknown>,
  ) => Promise<unknown>,
  linear = { readIssue: async () => null },
) {
  const octokit = { graphql, paginate: async () => [] } as unknown as Octokit;

  return createGitHubApprovalPorts({ octokit, repository, linear });
}

test("an attachment URL only resolves an Issue of the target repository", async () => {
  const resolved = ports(async () => ({
    repository: {
      id: "R_1",
      issue: {
        id: "I_1",
        number: 28,
        title: "WHAT",
        body: null,
        state: "OPEN",
      },
    },
  }));

  expect(
    await resolved.resolveGitHubIssueByAttachmentUrl(
      "https://github.com/mikan-919/oriel/issues/28",
    ),
  ).toEqual({
    issueNumber: 28,
    issueNodeId: "I_1",
    repositoryNodeId: "R_1",
    title: "WHAT",
    body: null,
    state: "OPEN",
  });

  for (const url of [
    "https://github.com/mikan-919/other/issues/28",
    "https://github.com/mikan-919/oriel/pull/28",
    "https://github.com/mikan-919/oriel/issues/0",
    "https://linear.app/team/issue/ENG-12",
    "not a url",
  ]) {
    expect(await resolved.resolveGitHubIssueByAttachmentUrl(url)).toBeNull();
  }
});

test("a ref that cannot be read is unknown rather than absent", async () => {
  expect(
    await ports(async () => ({
      repository: { ref: { target: { oid: baseOid } } },
    })).readRef("refs/heads/main"),
  ).toEqual({ status: "present", oid: baseOid });

  expect(
    await ports(async () => ({ repository: { ref: null } })).readRef(
      "refs/heads/main",
    ),
  ).toEqual({ status: "absent" });

  expect(
    await ports(async () => {
      throw new Error("network");
    }).readRef("refs/heads/main"),
  ).toEqual({ status: "unknown" });
});

test("the atomic seal reports what happened without any weaker fallback", async () => {
  const sealInput = {
    repositoryNodeId: "R_1",
    baseRef: "refs/heads/main",
    expectedBaseOid: baseOid,
    canonicalRef: "refs/heads/oriel/ENG-12-gh-28",
  };
  const sent: Record<string, unknown>[] = [];

  expect(
    await ports(async (_query, variables) => {
      sent.push(variables);
      return { updateRefs: { clientMutationId: null } };
    }).updateRefsAtomically(sealInput),
  ).toBe("sealed");
  // 二つのRefUpdateを、no-op比較とzero OID比較の組で一度に送る。
  expect(sent[0]).toMatchObject({
    input: {
      repositoryId: "R_1",
      refUpdates: [
        {
          name: "refs/heads/main",
          beforeOid: baseOid,
          afterOid: baseOid,
          force: false,
        },
        {
          name: "refs/heads/oriel/ENG-12-gh-28",
          beforeOid: "0".repeat(40),
          afterOid: baseOid,
          force: false,
        },
      ],
    },
  });

  const failure = (message: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(message), extra);

  expect(
    await ports(async () => {
      throw failure("Field 'updateRefs' doesn't exist on type 'Mutation'", {
        errors: [{ type: "UNDEFINED_FIELD" }],
      });
    }).updateRefsAtomically(sealInput),
  ).toBe("unsupported");

  expect(
    await ports(async () => {
      throw failure("Resource not accessible by integration", {
        status: 403,
      });
    }).updateRefsAtomically(sealInput),
  ).toBe("unsupported");

  expect(
    await ports(async () => {
      throw failure("could not update ref", {
        errors: [{ type: "UNPROCESSABLE" }],
        status: 200,
      });
    }).updateRefsAtomically(sealInput),
  ).toBe("rejected");

  // timeoutや切断は、送ったかどうかを決めない。
  expect(
    await ports(async () => {
      throw failure("fetch failed");
    }).updateRefsAtomically(sealInput),
  ).toBe("unknown");
});
