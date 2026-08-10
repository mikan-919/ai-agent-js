import { Loader2 } from "lucide-react";
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
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="text-sm font-semibold">nook</span>
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void openBranch(branchInput.trim());
          }}
        >
          <Input
            value={branchInput}
            onChange={(e) => setBranchInput(e.target.value)}
            placeholder="branch名（既存または新規）"
            className="max-w-xs"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={loading || branchInput.trim().length === 0}>
            {loading && <Loader2 className="size-3.5 animate-spin" />}
            開く
          </Button>
        </form>
      </header>

      <main className="flex min-h-0 flex-1">
        {!activeBranch && !loading && (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            branch名を入力してsandboxを開いてください
          </div>
        )}

        {response && !response.ok && (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-destructive">
            {response.error}
          </div>
        )}

        {activeBranch && response?.ok && (
          <>
            <aside className="w-96 shrink-0 border-r border-border">
              <WorkContextPanel workContext={response.workContext} />
            </aside>
            <section className="min-w-0 flex-1">
              <ChatPanel key={activeBranch} branch={activeBranch} onRunEnd={refresh} />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
