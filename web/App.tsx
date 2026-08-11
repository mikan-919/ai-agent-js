import { AlertTriangle, FolderGit2, GitBranch, Loader2 } from "lucide-react";
import { useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { WorkContextPanel } from "./components/WorkContextPanel";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { fetchWorkContext, type WorkContextResponse } from "./lib/api";

export function App() {
  const [branchInput, setBranchInput] = useState("");
  const [activeBranch, setActiveBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<WorkContextResponse | null>(null);

  const openBranch = async (branch: string) => {
    if (!branch || loading) return;
    setLoading(true);
    try {
      const result = await fetchWorkContext(branch);
      // Deliberately not cleared before the fetch: onRunEnd calls this to
      // refresh context after a chat turn, and nulling it out here would
      // unmount ChatPanel (rendered only while response?.ok) and wipe the
      // conversation on every turn. The stale panel just stays up during
      // the loading spinner instead.
      setResponse(result);
      setActiveBranch(branch);
    } finally {
      setLoading(false);
    }
  };

  const refresh = () => {
    if (activeBranch) void openBranch(activeBranch);
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-4 border-b border-border bg-card px-5 py-3.5 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <FolderGit2 className="size-4" />
          </div>
          <span className="text-base font-semibold tracking-tight">Agent workspace</span>
        </div>
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void openBranch(branchInput.trim());
          }}
        >
          <div className="relative w-full max-w-sm">
            <GitBranch className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={branchInput}
              onChange={(e) => setBranchInput(e.target.value)}
              placeholder="branch名（既存または新規）"
              className="pl-8"
            />
          </div>
          <Button type="submit" disabled={loading || branchInput.trim().length === 0}>
            {loading && <Loader2 className="size-3.5 animate-spin" />}
            開く
          </Button>
        </form>
      </header>

      <main className="flex min-h-0 flex-1">
        {!activeBranch && !loading && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <FolderGit2 className="size-8 opacity-40" />
            <p className="text-sm">branch名を入力してsandboxを開いてください</p>
          </div>
        )}

        {!activeBranch && loading && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            sandboxを準備しています…
          </div>
        )}

        {response && !response.ok && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <AlertTriangle className="size-8 text-destructive opacity-80" />
            <p className="max-w-md text-sm text-destructive">{response.error}</p>
          </div>
        )}

        {activeBranch && response?.ok && (
          <>
            <aside className="w-96 shrink-0 overflow-hidden border-r border-border bg-muted/40">
              <WorkContextPanel workContext={response.workContext} />
            </aside>
            <section className="min-w-0 flex-1 bg-background">
              <ChatPanel key={activeBranch} branch={activeBranch} onRunEnd={refresh} />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
