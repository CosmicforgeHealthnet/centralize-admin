"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { fetchSocialProviderOptions, startSocialAuthorization, type ConnectionProvider } from "@/lib/social-account-connection.service";

export default function AddSocialAccountModal({ onClose }: { onClose: () => void }) {
  const providers = useQuery({ queryKey: ["social", "oauth-providers"], queryFn: fetchSocialProviderOptions, retry: false });
  const [pending, setPending] = useState<ConnectionProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function connect(provider: ConnectionProvider) {
    setPending(provider); setError(null);
    try { await startSocialAuthorization(provider); }
    catch (err) {
      setError(axios.isAxiosError(err) ? err.response?.data?.message || "Unable to start the connection. Check your access and try again." : err instanceof Error ? err.message : "Unable to start the connection.");
      setPending(null);
    }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto">
    <DialogTitle>Connect a social account</DialogTitle>
    <DialogDescription>Choose a platform, then sign in on its website to authorize access. Your password stays with the platform.</DialogDescription>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    {providers.isPending ? <p role="status" className="py-4 text-sm text-muted-foreground">Loading platforms...</p> : providers.isError ? <div role="alert" className="space-y-3 text-sm"><p>We could not load the available platforms.</p><button type="button" onClick={() => providers.refetch()} className="min-h-11 rounded-lg border border-border px-4">Try again</button></div> : <div className="space-y-2">
      {providers.data?.map(item => <button key={item.provider} type="button" disabled={!item.available || pending !== null} onClick={() => connect(item.provider)} className="flex min-h-16 w-full items-center gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60">
        <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{item.label}</span>{!item.available && <span className="mt-1 block text-xs text-muted-foreground">{item.reason}</span>}</span>
        {pending === item.provider ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Opening sign-in" /> : item.available && <ArrowUpRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
      </button>)}
      {providers.data?.length === 0 && <p className="text-sm text-muted-foreground">No supported platforms are available.</p>}
    </div>}
  </DialogContent></Dialog>;
}
