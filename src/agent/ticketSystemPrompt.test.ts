import { describe, expect, test } from "bun:test";
import {
  buildTicketExtractionSystemPrompt,
  buildTicketReplySystemPrompt,
  extractHandoffNote,
  extractRoadmapGaps,
} from "./ticketSystemPrompt";

const SAMPLE_ROADMAP = `# ROADMAP

## 全体アーキテクチャの方向性

- something not relevant here.

## 次の優先順位

1. do thing A
2. do thing B

## 未解決の論点

1. open question one
2. open question two
`;

const SAMPLE_HANDOFF = `# 対話ハンドオフ

## 次のセッションへの申し送り

- pick up from here.
`;

describe("extractRoadmapGaps", () => {
  test("extracts both the priorities and open-questions sections, in order", () => {
    const result = extractRoadmapGaps(SAMPLE_ROADMAP);
    expect(result).toContain("## 次の優先順位");
    expect(result).toContain("do thing A");
    expect(result).toContain("## 未解決の論点");
    expect(result).toContain("open question two");
    expect(result.indexOf("次の優先順位")).toBeLessThan(result.indexOf("未解決の論点"));
    expect(result).not.toContain("全体アーキテクチャの方向性");
  });

  test("reports missing sections instead of throwing", () => {
    expect(extractRoadmapGaps("# ROADMAP\n\nno matching headings here\n")).toBe(
      "(neither section found in ROADMAP.md)",
    );
  });

  test("reports a missing file", () => {
    expect(extractRoadmapGaps(null)).toBe("(ROADMAP.md not found)");
  });
});

describe("extractHandoffNote", () => {
  test("extracts the handoff section", () => {
    expect(extractHandoffNote(SAMPLE_HANDOFF)).toContain("pick up from here");
  });

  test("reports a missing section", () => {
    expect(extractHandoffNote("# 対話ハンドオフ\n\nno heading here\n")).toBe("(section not found in HANDOFF.md)");
  });

  test("reports a missing file", () => {
    expect(extractHandoffNote(null)).toBe("(HANDOFF.md not found)");
  });
});

describe("buildTicketExtractionSystemPrompt", () => {
  test("embeds the cap, extracted sections, and open issues", () => {
    const prompt = buildTicketExtractionSystemPrompt({
      roadmap: SAMPLE_ROADMAP,
      handoff: SAMPLE_HANDOFF,
      openIssues: [{ number: 3, title: "Existing gap", url: "https://x/3" }],
      maxIssues: 5,
    });
    expect(prompt).toContain("at most 5 issue(s)");
    expect(prompt).toContain("do thing A");
    expect(prompt).toContain("pick up from here");
    expect(prompt).toContain("#3 Existing gap");
    expect(prompt).not.toContain("全体アーキテクチャの方向性");
  });

  test("says explicitly when there are no open issues", () => {
    const prompt = buildTicketExtractionSystemPrompt({
      roadmap: SAMPLE_ROADMAP,
      handoff: SAMPLE_HANDOFF,
      openIssues: [],
      maxIssues: 5,
    });
    expect(prompt).toContain("(no open issues)");
  });
});

describe("buildTicketReplySystemPrompt", () => {
  test("embeds the issue thread", () => {
    const prompt = buildTicketReplySystemPrompt({
      issue: { number: 7, title: "Some gap", body: "the body", url: "https://x/7" },
      comments: [{ login: "alice", body: "any update?" }],
    });
    expect(prompt).toContain("Issue #7: Some gap");
    expect(prompt).toContain("the body");
    expect(prompt).toContain("alice: any update?");
    expect(prompt).toContain("reply_to_issue only");
  });
});
