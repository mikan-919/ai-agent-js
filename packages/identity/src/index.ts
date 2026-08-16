export const identity = {
  displayName: "Oriel",
  codeName: "oriel",
  cliName: "oriel",
  applicationDataDirectoryName: "oriel",
  npmPackageName: "@mikan-919/oriel",
  environmentPrefix: "ORIEL_",
  proposalLabel: "oriel:proposed",
  /** repository rootに置く実行設定。実行時はtarget branch版だけを信頼する。 */
  executionConfigFileName: ".oriel.yaml",
  /**
   * checkpoint commitの著者。人間のGit設定を継承せず、実行ハーネスの成果だと
   * 分かる固定の識別情報を使う。`.invalid`はRFC 2606の予約TLDである。
   */
  checkpointAuthor: { name: "Oriel", email: "oriel@oriel.invalid" },
  workspaceDocuments: ["CONCEPT.md", "ROADMAP.md", "FEATURE.md", "HANDOFF.md"],
  driftWatchedDocuments: ["CONCEPT.md", "ROADMAP.md"],
} as const;

export function userAgent(version: string): string {
  return `${identity.codeName}/${version}`;
}
