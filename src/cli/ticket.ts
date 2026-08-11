export interface TicketArgs {
  mode: "extract" | "poll";
  json: boolean;
}

/** `nook ticket` extracts (default); `nook ticket poll` runs the issue-reply pass instead. */
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
