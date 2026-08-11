export interface DocsArgs {
  /** Defaults to the branch currently checked out in repoPath when omitted. */
  branch?: string;
}

export function parseDocsArgs(args: string[]): DocsArgs {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  return { branch: positional[0] };
}
