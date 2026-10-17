"use client";

import { useEffect, useState } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import { useSocialPermissions } from "../../shared/useSocialPermissions";
import ProviderBadge, { BadgeProvider } from "../../shared/ProviderBadge";
import CapabilityPill, { CapabilityState } from "../../shared/CapabilityPill";
import PermissionGate from "../../shared/PermissionGate";
import type { SOPostTargetVariant } from "@/types/social-operations.types";

interface PostComposerPageProps {
  postId?: string;
  onSaved?: () => void;
}

export default function PostComposerPage({ postId, onSaved }: PostComposerPageProps) {
  const permissions = useSocialPermissions();
  const {
    identities, fetchIdentities, media, fetchMedia,
    selectedPost, fetchPostDetail, createPost, updatePost, submitPostForReview,
    actionLoading, error,
  } = useSocialOperationsStore();

  const [title, setTitle] = useState("");
  const [baseText, setBaseText] = useState("");
  const [campaign, setCampaign] = useState("");
  const [selectedIdentityIds, setSelectedIdentityIds] = useState<string[]>([]);
  const [variantText, setVariantText] = useState<Record<string, string>>({});
  const [variantMedia, setVariantMedia] = useState<Record<string, string[]>>({});
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  useEffect(() => {
    fetchIdentities();
    fetchMedia();
    if (postId) fetchPostDetail(postId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  useEffect(() => {
    if (selectedPost && selectedPost.id === postId) {
      setTitle(selectedPost.title);
      setBaseText(selectedPost.baseText);
      setCampaign(selectedPost.campaign ?? "");
      setSelectedIdentityIds(selectedPost.targets.map((t) => t.identityId));
      const texts: Record<string, string> = {};
      const medias: Record<string, string[]> = {};
      selectedPost.targets.forEach((t) => { texts[t.identityId] = t.text; medias[t.identityId] = t.mediaIds; });
      setVariantText(texts);
      setVariantMedia(medias);
    }
  }, [selectedPost, postId]);

  const toggleIdentity = (identityId: string) => {
    setSelectedIdentityIds((prev) => {
      const next = prev.includes(identityId) ? prev.filter((id) => id !== identityId) : [...prev, identityId];
      if (!prev.includes(identityId) && !variantText[identityId]) {
        setVariantText((v) => ({ ...v, [identityId]: baseText }));
      }
      return next;
    });
  };

  const buildTargets = (): SOPostTargetVariant[] =>
    selectedIdentityIds.map((identityId) => {
      const identity = identities.find((i) => i.id === identityId)!;
      return {
        identityId,
        provider: identity.provider,
        text: variantText[identityId] ?? baseText,
        mediaIds: variantMedia[identityId] ?? [],
      };
    });

  const handleSaveDraft = async () => {
    const payload = { title, baseText, campaign: campaign || null, targets: buildTargets() };
    if (postId) {
      await updatePost(postId, payload);
    } else {
      await createPost(payload);
    }
    setLastSavedAt(new Date().toISOString());
    onSaved?.();
  };

  const handleSubmit = async () => {
    await handleSaveDraft();
    if (postId) await submitPostForReview(postId);
  };

  const isSaving = actionLoading === "create" || actionLoading === postId;
  const canSubmit = permissions.social_content_submit === "EDIT" && selectedIdentityIds.length > 0 && baseText.trim().length > 0;

  return (
    <div className="flex flex-col gap-4">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-poppins">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
        {/* Base content + media */}
        <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3">
          <p className="font-poppins text-[13px] font-semibold text-foreground">Base content</p>
          <input
            value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Post title"
            className="font-poppins text-[13px] bg-background border border-border rounded-lg px-3 py-2 text-foreground"
          />
          <textarea
            value={baseText} onChange={(e) => setBaseText(e.target.value)} placeholder="What do you want to say?"
            rows={5}
            className="font-poppins text-[12px] bg-background border border-border rounded-lg px-3 py-2 text-foreground resize-none"
          />
          <input
            value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="Campaign (optional)"
            className="font-poppins text-[12px] bg-background border border-border rounded-lg px-3 py-2 text-foreground"
          />

          <p className="font-poppins text-[12px] font-medium text-foreground mt-2">Media library</p>
          <div className="flex flex-wrap gap-2">
            {media.filter((m) => m.status === "READY").map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  selectedIdentityIds.forEach((idId) => {
                    setVariantMedia((prev) => {
                      const current = prev[idId] ?? [];
                      const has = current.includes(m.id);
                      return { ...prev, [idId]: has ? current.filter((x) => x !== m.id) : [...current, m.id] };
                    });
                  });
                }}
                className="font-poppins text-[10px] border border-border rounded-lg px-2 py-1 text-foreground"
              >
                {m.fileName}
              </button>
            ))}
            {media.some((m) => m.status !== "READY") && (
              <span className="font-poppins text-[10px] text-muted-foreground">
                Some assets are still processing and can't be attached yet.
              </span>
            )}
          </div>

          {lastSavedAt && (
            <span className="font-poppins text-[10px] text-muted-foreground">Last saved {new Date(lastSavedAt).toLocaleTimeString()}</span>
          )}
        </div>

        {/* Target identities */}
        <div className="bg-card rounded-xl border border-border p-4 flex flex-col gap-3">
          <p className="font-poppins text-[13px] font-semibold text-foreground">Target identities</p>
          {identities.length === 0 ? (
            <p className="font-poppins text-[12px] text-muted-foreground">No identities available — connect a provider first.</p>
          ) : (
            identities.map((identity) => {
              const isSelected = selectedIdentityIds.includes(identity.id);
              const canPublishText = identity.capabilities.publishText;
              return (
                <div key={identity.id} className={`border rounded-lg p-2.5 flex flex-col gap-2 ${isSelected ? "border-primary" : "border-border"}`}>
                  <button onClick={() => toggleIdentity(identity.id)} className="flex items-center justify-between w-full text-left">
                    <ProviderBadge provider={identity.provider as BadgeProvider} subtitle={identity.username} size="sm" />
                    {canPublishText && <CapabilityPill state={canPublishText as CapabilityState} />}
                  </button>
                  {isSelected && (
                    <textarea
                      value={variantText[identity.id] ?? ""}
                      onChange={(e) => setVariantText((v) => ({ ...v, [identity.id]: e.target.value }))}
                      rows={3}
                      className="font-poppins text-[11px] bg-background border border-border rounded-lg px-2.5 py-1.5 text-foreground resize-none"
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={handleSaveDraft}
          disabled={isSaving || !title.trim()}
          className="font-poppins text-[12px] font-medium border border-border text-foreground px-4 py-2 rounded-lg disabled:opacity-40"
        >
          {isSaving ? "Saving…" : "Save draft"}
        </button>
        <PermissionGate hasPermission={permissions.social_content_submit === "EDIT"}>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || isSaving}
            className="font-poppins text-[12px] font-medium bg-primary text-primary-foreground px-4 py-2 rounded-lg disabled:opacity-40"
          >
            Submit for review
          </button>
        </PermissionGate>
      </div>
    </div>
  );
}