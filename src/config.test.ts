import { describe, expect, test } from "bun:test";
import {
  DRIFT_WATCHED_DOCUMENT_FILES,
  ENV,
  PROPOSED_ISSUE_LABEL,
  PROJECT_CODENAME,
  PROJECT_STATE_DIRECTORY,
  PROJECT_USER_AGENT,
  WORKSPACE_DOCUMENT_FILES,
  WORKSPACE_DOCUMENTS,
} from "./config";

describe("project configuration", () => {
  test("derives runtime identifiers from the single codename", () => {
    expect(PROJECT_USER_AGENT).toBe(PROJECT_CODENAME);
    expect(PROJECT_STATE_DIRECTORY).toBe(`.${PROJECT_CODENAME}`);
    expect(PROPOSED_ISSUE_LABEL).toBe(`${PROJECT_CODENAME}:proposed`);
    expect(ENV.modelProvider).toBe(`${PROJECT_CODENAME.toUpperCase()}_MODEL_PROVIDER`);
  });

  test("keeps the workspace document manifest and drift subset together", () => {
    expect(WORKSPACE_DOCUMENT_FILES).toEqual([
      WORKSPACE_DOCUMENTS.concept,
      WORKSPACE_DOCUMENTS.roadmap,
      WORKSPACE_DOCUMENTS.feature,
      WORKSPACE_DOCUMENTS.handoff,
    ]);
    expect(DRIFT_WATCHED_DOCUMENT_FILES).toEqual([WORKSPACE_DOCUMENTS.concept, WORKSPACE_DOCUMENTS.roadmap]);
  });
});
