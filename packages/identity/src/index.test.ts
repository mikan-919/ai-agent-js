import { expect, test } from "bun:test";

import { identity, userAgent } from "./index";

test("exposes the approved runtime identifiers", () => {
  expect(identity).toEqual({
    displayName: "Oriel",
    codeName: "oriel",
    cliName: "oriel",
    applicationDataDirectoryName: "oriel",
    npmPackageName: "@mikan-919/oriel",
    environmentPrefix: "ORIEL_",
    proposalLabel: "oriel:proposed",
    executionConfigFileName: ".oriel.yaml",
    checkpointAuthor: { name: "Oriel", email: "oriel@oriel.invalid" },
    workspaceDocuments: [
      "CONCEPT.md",
      "ROADMAP.md",
      "FEATURE.md",
      "HANDOFF.md",
    ],
    driftWatchedDocuments: ["CONCEPT.md", "ROADMAP.md"],
  });
});

test("derives the User-Agent from the supplied distribution version", () => {
  expect(userAgent("0.0.0")).toBe("oriel/0.0.0");
  expect(userAgent("1.2.3")).toBe("oriel/1.2.3");
});
