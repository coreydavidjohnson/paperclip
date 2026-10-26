import { useState } from "react";
import { Button } from "./ui/button";

export interface CommentRecovery {
  canRecover: (attemptId: string) => boolean;
  recover: (attemptId: string) => Promise<void>;
}

/** No mount/reload replay. The caller supplies only the original saved key;
 * the API recovers its immutable actor/task-bound request, never draft text. */
export function CommentRecoveryButton({ attemptId, recovery, disabled, onConfirmed }: {
  attemptId: string; recovery?: CommentRecovery; disabled?: boolean; onConfirmed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!recovery?.canRecover(attemptId)) return null;
  return <>
    <Button type="button" variant="outline" size="sm" disabled={disabled || busy}
      onClick={async () => {
        if (disabled || busy) return;
        setBusy(true); setFailed(false);
        try { await recovery.recover(attemptId); onConfirmed(); }
        catch { setFailed(true); }
        finally { setBusy(false); }
      }}>
      {busy ? "Recovering saved request…" : "Retry saved request"}
    </Button>
    {failed ? <p role="status">Delivery is still unconfirmed. Your saved request is kept.</p> : null}
  </>;
}
