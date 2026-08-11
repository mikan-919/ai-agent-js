import { AlertTriangle, ExternalLink, GitBranch, GitPullRequest, Layers } from "lucide-react";
import type { GithubChecksStatus, GithubReviewDecision, WorkContext } from "../../src/context/types";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { ScrollArea } from "./ui/scroll-area";

function reviewDecisionVariant(decision: GithubReviewDecision): "default" | "destructive" | "outline" {
  if (decision === "APPROVED") return "default";
  if (decision === "CHANGES_REQUESTED") return "destructive";
  return "outline";
}

function checksStatusVariant(status: GithubChecksStatus): "default" | "destructive" | "outline" {
  if (status === "SUCCESS") return "default";
  if (status === "FAILURE" || status === "ERROR") return "destructive";
  return "outline";
}

export function WorkContextPanel({ workContext }: { workContext: WorkContext }) {
  const { git, github, linear, docs } = workContext;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <GitBranch className="size-4 text-primary" />
            <span className="truncate font-mono text-[13px]">{git.branch}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>vs {git.mainBranch}</span>
            <span className="text-border">·</span>
            <span>{git.diff.filesChanged} files</span>
            <span className="font-medium text-success">+{git.diff.insertions}</span>
            <span className="font-medium text-destructive">-{git.diff.deletions}</span>
          </div>
          {git.diff.files.length > 0 && (
            <ScrollArea className="max-h-40 rounded-md border border-border/70 bg-muted/40 p-2">
              <ul className="flex flex-col gap-1.5 text-xs">
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
          <CardTitle className="flex items-center gap-1.5">
            <GitPullRequest className="size-4 text-primary" />
            GitHub
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {github.ok ? (
            <>
              {github.data.pullRequest ? (
                <>
                  <a
                    href={github.data.pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 -mx-1.5 hover:bg-accent"
                  >
                    <Badge variant={github.data.pullRequest.isDraft ? "secondary" : "default"}>
                      #{github.data.pullRequest.number} {github.data.pullRequest.state}
                    </Badge>
                    <span className="truncate">{github.data.pullRequest.title}</span>
                    <ExternalLink className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                  </a>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={reviewDecisionVariant(github.data.pullRequest.reviewDecision)}>
                      {github.data.pullRequest.reviewDecision ?? "no review yet"}
                    </Badge>
                    <Badge variant={checksStatusVariant(github.data.pullRequest.checksStatus)}>
                      {github.data.pullRequest.checksStatus ?? "no checks"}
                    </Badge>
                  </div>
                </>
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
                        className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 -mx-1.5 hover:bg-accent"
                      >
                        <Badge variant="outline">#{issue.number}</Badge>
                        <span className="truncate">{issue.title}</span>
                        <ExternalLink className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
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
          <CardTitle className="flex items-center gap-1.5">
            <Layers className="size-4 text-primary" />
            Linear
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {linear.ok ? (
            <a
              href={linear.data.url}
              target="_blank"
              rel="noreferrer"
              className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 -mx-1.5 hover:bg-accent"
            >
              <Badge variant="outline">{linear.data.state.name}</Badge>
              <span className="truncate">
                {linear.data.identifier} {linear.data.title}
              </span>
              <ExternalLink className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
            </a>
          ) : (
            <span className="text-muted-foreground">{linear.reason}</span>
          )}
        </CardContent>
      </Card>

      {docs.driftedAgainstMain.length > 0 && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-destructive">
              <AlertTriangle className="size-4" />
              Docs drift
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            main と内容が異なる: {docs.driftedAgainstMain.join(", ")}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
