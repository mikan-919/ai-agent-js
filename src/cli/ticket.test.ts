import { describe, expect, test } from "bun:test";
import { parseTicketArgs } from "./ticket";

describe("parseTicketArgs", () => {
  test("defaults to extract mode with no args", () => {
    expect(parseTicketArgs([])).toEqual({ mode: "extract", json: false });
  });

  test("accepts --json in extract mode", () => {
    expect(parseTicketArgs(["--json"])).toEqual({ mode: "extract", json: true });
  });

  test("recognizes the poll subcommand", () => {
    expect(parseTicketArgs(["poll"])).toEqual({ mode: "poll", json: false });
  });

  test("rejects an unknown subcommand", () => {
    expect(() => parseTicketArgs(["bogus"])).toThrow("unknown ticket subcommand 'bogus'");
  });

  test("rejects an unknown flag", () => {
    expect(() => parseTicketArgs(["--wat"])).toThrow("unknown flag '--wat'");
  });
});
