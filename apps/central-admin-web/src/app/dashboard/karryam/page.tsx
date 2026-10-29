"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, Truck, RefreshCw, LockKeyhole } from "lucide-react";
import api from "@/lib/api";

type Capability = {
  id?: string;
  state?: string;
  permission?: string;
  owner?: string;
  blocker?: string;
};
type Envelope = {
  product: string;
  contract_version?: string;
  as_of?: string;
  freshness?: string;
  result?: unknown;
};
function capabilitiesFrom(result: unknown): Capability[] {
  if (Array.isArray(result)) return result.filter(x => x && typeof x === "object") as Capability[];
  if (result && typeof result === "object" && "capabilities" in result) {
    const values = (result as {capabilities?:unknown}).capabilities;
    if (Array.isArray(values)) return values.filter(x => x && typeof x === "object") as Capability[];
  }
  return [];
}

export default function KarryamAdminPage() {
  const query = useQuery<Envelope>({
    queryKey: ["karryam", "capabilities", "v1"],
    queryFn: async () => (await api.get<Envelope>("/api/karryam/capabilities")).data,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const items = capabilitiesFrom(query.data?.result);
  return (
    <section className="flex flex-col gap-5 p-1 md:p-3" aria-label="Karryam administration">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-[#272EA7] p-3 text-white"><Truck size={22}/></div>
          <div>
            <h1 className="font-poppins text-xl font-semibold text-foreground">Karryam Administration</h1>
            <p className="mt-1 text-sm text-muted-foreground">Secure logistics control plane — capability discovery</p>
          </div>
        </div>
        <button type="button" onClick={() => query.refetch()} disabled={query.isFetching}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium disabled:opacity-50">
          <RefreshCw size={15} className={query.isFetching ? "animate-spin" : ""}/> Refresh
        </button>
      </div>

      <div className="flex gap-3 rounded-xl border border-border bg-card p-4">
        <LockKeyhole className="mt-0.5 shrink-0 text-[#272EA7]" size={20}/>
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Private headquarters integration</h2>
          <p className="text-sm text-muted-foreground">
            This page obtains data only through Central Admin authentication and Karryam's private, signed backoffice bridge.
            Actions are not enabled until their owner contracts, permissions and approval policies are certified.
          </p>
        </div>
      </div>

      {query.isLoading && <p role="status" className="text-sm text-muted-foreground">Checking authorized Karryam capabilities…</p>}
      {query.isError && (
        <div role="alert" className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">Karryam integration is not available</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The private service may be disabled, its credentials may be missing, or your session may need permission or recent MFA.
            No operational data is being substituted.
          </p>
        </div>
      )}
      {query.isSuccess && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <ShieldCheck className="text-[#272EA7]" size={18}/>
            <span className="font-medium">Authenticated discovery response</span>
            <span className="text-muted-foreground">{query.data.contract_version ? "Contract " + query.data.contract_version : ""}</span>
            <span className="text-muted-foreground">{query.data.freshness ?? "Freshness unspecified"}</span>
          </div>
          {items.length === 0 ? (
            <div role="status" className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
              The bridge returned no displayable capability inventory. This is not a report of zero activity.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="bg-muted/50 text-muted-foreground"><tr>
                  <th scope="col" className="p-3 font-medium">Capability</th>
                  <th scope="col" className="p-3 font-medium">Owning service</th>
                  <th scope="col" className="p-3 font-medium">Status</th>
                </tr></thead>
                <tbody>{items.map((c,i) => <tr key={(c.id ?? "cap") + String(i)} className="border-t border-border">
                  <td className="p-3 font-medium">{c.id ?? "Undisclosed"}</td>
                  <td className="p-3 text-muted-foreground">{c.owner ?? "Undisclosed"}</td>
                  <td className="p-3 text-muted-foreground">{c.state ?? "UNAVAILABLE"}</td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
