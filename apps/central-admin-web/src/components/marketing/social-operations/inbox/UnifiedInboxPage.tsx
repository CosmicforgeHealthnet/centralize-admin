"use client";

import { useEffect, useState } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import { useSocialPermissions } from "../../shared/useSocialPermissions";
import ProviderBadge, { BadgeProvider } from "../../shared/ProviderBadge";
import StatusChip from "../../shared/StatusChip";
import SensitiveContentBanner from "../../shared/SensitiveContentBanner";
import EmptyState from "../../shared/EmptyState";
import PermissionGate from "../../shared/PermissionGate";

export default function UnifiedInboxPage() {
  const permissions = useSocialPermissions();
  const { conversations, isLoadingConversations, fetchConversations, replyConversation, resolveConversation, actionLoading, error } = useSocialOperationsStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");

  useEffect(() => {
    fetchConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId && conversations.length > 0) setSelectedId(conversations[0].id);
  }, [conversations, selectedId]);

  const selected = conversations.find((c) => c.id === selectedId);
  const canViewRestricted = permissions.social_moderation_restricted === "VIEW";

  const handleReply = async () => {
    if (!selected || !replyText.trim()) return;
    await replyConversation(selected.id, replyText);
    setReplyText("");
  };

  if (isLoadingConversations) return null;
  if (conversations.length === 0) {
    return <EmptyState message="No conversations yet" description="Messages from connected identities will appear here." />;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
      {error && <div className="lg:col-span-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-poppins">{error}</div>}

      <div className="bg-card rounded-xl border border-border flex flex-col divide-y divide-border overflow-hidden">
        {conversations.map((c) => (
          <button
            key={c.id}
            onClick={() => setSelectedId(c.id)}
            className={`p-3 text-left flex flex-col gap-1 hover:bg-muted/40 transition-colors ${selectedId === c.id ? "bg-muted/60" : ""}`}
          >
            <div className="flex items-center justify-between">
              <ProviderBadge provider={c.provider as BadgeProvider} subtitle={c.restricted ? "Restricted" : c.contactName} size="sm" />
              {c.unreadCount > 0 && (
                <span className="font-poppins text-[10px] font-semibold bg-primary text-primary-foreground rounded-full w-4 h-4 flex items-center justify-center">
                  {c.unreadCount}
                </span>
              )}
            </div>
            <p className="font-poppins text-[11px] text-muted-foreground truncate">
              {c.restricted ? "Content hidden by policy" : c.lastMessagePreview}
            </p>
            <StatusChip status={c.status} />
          </button>
        ))}
      </div>

      <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3">
        {!selected ? (
          <EmptyState message="Select a conversation" />
        ) : selected.restricted ? (
          <SensitiveContentBanner canReveal={canViewRestricted} classification="restricted contact">
            <p className="font-poppins text-[12px] text-foreground">{selected.lastMessagePreview}</p>
          </SensitiveContentBanner>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <ProviderBadge provider={selected.provider as BadgeProvider} subtitle={selected.contactName} />
              <StatusChip status={selected.status} />
            </div>
            <p className="font-poppins text-[12px] text-foreground">{selected.lastMessagePreview}</p>

            <div className="flex items-center gap-2 mt-auto">
              <input
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Write a reply…"
                className="flex-1 font-poppins text-[12px] bg-background border border-border rounded-lg px-3 py-2 text-foreground"
              />
              <PermissionGate hasPermission={permissions.social_inbox_reply === "EDIT"}>
                <button
                  onClick={handleReply}
                  disabled={actionLoading === selected.id || !replyText.trim()}
                  className="font-poppins text-[12px] font-medium bg-primary text-primary-foreground px-4 py-2 rounded-lg disabled:opacity-40"
                >
                  Send
                </button>
              </PermissionGate>
            </div>
            {selected.status !== "RESOLVED" && (
              <PermissionGate hasPermission={permissions.social_inbox_resolve === "EDIT"}>
                <button
                  onClick={() => resolveConversation(selected.id)}
                  className="font-poppins text-[11px] font-medium text-muted-foreground w-fit"
                >
                  Mark resolved
                </button>
              </PermissionGate>
            )}
          </>
        )}
      </div>
    </div>
  );
}