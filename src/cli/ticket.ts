export interface TicketArgs {
  mode: "extract" | "poll";
  json: boolean;
}

/** The ticket subcommand extracts by default; its `poll` mode runs the issue-reply pass. */
export function parseTicketArgs(args: string[]): TicketArgs {
  const positional: string[] = [];
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag '${arg}'`);
    } else {
      positional.push(arg);
    }
  }

  const sub = positional[0];
  if (sub !== undefined && sub !== "poll") {
    throw new Error(`unknown ticket subcommand '${sub}'`);
  }
  return { mode: sub === "poll" ? "poll" : "extract", json };
}
