/**
 * Runtime identity and workspace conventions live here so the rest of the
 * application can use generic terminology without repeating the codename or
 * the document allowlist.
 */
export const PROJECT_CODENAME = "oriel";
export const PROJECT_USER_AGENT = PROJECT_CODENAME;
export const PROJECT_STATE_DIRECTORY = `.${PROJECT_CODENAME}`;
export const PROPOSED_ISSUE_LABEL = `${PROJECT_CODENAME}:proposed`;

const ENV_PREFIX = PROJECT_CODENAME.toUpperCase();

export const ENV = {
  agentIdleTimeoutMs: `${ENV_PREFIX}_AGENT_IDLE_TIMEOUT_MS`,
  chatSessionIdleMs: `${ENV_PREFIX}_CHAT_SESSION_IDLE_MS`,
  gitToken: `${ENV_PREFIX}_GIT_TOKEN`,
  modelApiKey: `${ENV_PREFIX}_MODEL_API_KEY`,
  modelBaseUrl: `${ENV_PREFIX}_MODEL_BASE_URL`,
  modelId: `${ENV_PREFIX}_MODEL_ID`,
  modelProvider: `${ENV_PREFIX}_MODEL_PROVIDER`,
  ticketMaxIssues: `${ENV_PREFIX}_TICKET_MAX_ISSUES`,
  ticketPollIntervalMs: `${ENV_PREFIX}_TICKET_POLL_INTERVAL_MS`,
} as const;

/** The workspace documents and their stable semantic roles. */
export const WORKSPACE_DOCUMENTS = {
  concept: "CONCEPT.md",
  roadmap: "ROADMAP.md",
  feature: "FEATURE.md",
  handoff: "HANDOFF.md",
} as const;

export const WORKSPACE_DOCUMENT_FILES = [
  WORKSPACE_DOCUMENTS.concept,
  WORKSPACE_DOCUMENTS.roadmap,
  WORKSPACE_DOCUMENTS.feature,
  WORKSPACE_DOCUMENTS.handoff,
] as const;

/** Only these documents participate in branch-vs-main drift warnings. */
export const DRIFT_WATCHED_DOCUMENT_FILES = [
  WORKSPACE_DOCUMENTS.concept,
  WORKSPACE_DOCUMENTS.roadmap,
] as const;
