import { ExternalLink, GitBranch } from "lucide-react";
import type { WorkContext } from "../../src/context/types";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";

export function WorkContextPanel({ workContext }: { workContext: WorkContext }) {
  const { git, github, linear, docs } = workContext;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <GitBranch className="size-4" />
            {git.branch}
            <span className="font-normal text-muted-foreground">vs {git.mainBranch}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{git.diff.filesChanged} files changed</span>
            <span className="text-success">+{git.diff.insertions}</span>
            <span className="text-destructive">-{git.diff.deletions}</span>
          </div>
          {git.diff.files.length > 0 && (
            <ScrollArea className="max-h-40">
              <ul className="flex flex-col gap-1 text-xs">
                {git.diff.files.map((f) => (
                  <li key={f.path} className="flex items-center justify-between gap-2 font-mono">
                    <span className="truncate">{f.path}</span>
                    {!f.binary && (
                      <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                        <span className="text-success">+{f.insertions}</span>{" "}
                        <span className="text-destructive">-{f.deletions}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {github.ok ? (
            <>
              {github.data.pullRequest ? (
                <a
                  href={github.data.pullRequest.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 hover:underline"
                >
                  <Badge variant={github.data.pullRequest.isDraft ? "secondary" : "default"}>
                    #{github.data.pullRequest.number} {github.data.pullRequest.state}
                  </Badge>
                  <span className="truncate">{github.data.pullRequest.title}</span>
                  <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                </a>
              ) : (
                <span className="text-muted-foreground">まだPRなし</span>
              )}
              {github.data.linkedIssues.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {github.data.linkedIssues.map((issue) => (
                    <li key={issue.number}>
                      <a
                        href={issue.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1.5 hover:underline"
                      >
                        <Badge variant="outline">#{issue.number}</Badge>
                        <span className="truncate">{issue.title}</span>
                        <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">{github.reason}</span>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Linear</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {linear.ok ? (
            <a
              href={linear.data.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 hover:underline"
            >
              <Badge variant="outline">{linear.data.state.name}</Badge>
              <span className="truncate">
                {linear.data.identifier} {linear.data.title}
              </span>
              <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
            </a>
          ) : (
            <span className="text-muted-foreground">{linear.reason}</span>
          )}
        </CardContent>
      </Card>

      {docs.driftedAgainstMain.length > 0 && (
        <>
          <Separator />
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="text-destructive">Docs drift</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              main と内容が異なる: {docs.driftedAgainstMain.join(", ")}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
