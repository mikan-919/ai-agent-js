export const identity = {
  displayName: "Oriel",
  codeName: "oriel",
  cliName: "oriel",
  applicationDataDirectoryName: "oriel",
  npmPackageName: "@mikan-919/oriel",
  environmentPrefix: "ORIEL_",
  proposalLabel: "oriel:proposed",
  workspaceDocuments: ["CONCEPT.md", "ROADMAP.md", "FEATURE.md", "HANDOFF.md"],
  driftWatchedDocuments: ["CONCEPT.md", "ROADMAP.md"],
} as const;

export function userAgent(version: string): string {
  return `${identity.codeName}/${version}`;
}
