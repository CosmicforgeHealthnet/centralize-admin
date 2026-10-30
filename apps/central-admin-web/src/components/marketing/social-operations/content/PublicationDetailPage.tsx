"use client";

import { useEffect } from "react";
import { useSocialOperationsStore } from "@/stores/social-operations.store";
import { useSocialPermissions } from "../../shared/useSocialPermissions";
import StatusChip from "../../shared/StatusChip";
import ProviderResultCard from "../../shared/ProviderResultCard";
import PartialSuccessSummary from "../../shared/PartialSuccessSummary";
import EmptyState from "../../shared/EmptyState";
import type { BadgeProvider } from "../../shared/ProviderBadge";

interface PublicationDetailPageProps {
  publicationId: string;
  onBack: () => void;
}

export default function PublicationDetailPage({ publicationId, onBack }: PublicationDetailPageProps) {
  const permissions = useSocialPermissions();
  const { publications, fetchPublications, retryPublication, cancelPublication, actionLoading } = useSocialOperationsStore();

  useEffect(() => {
    if (publications.length === 0) fetchPublications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const publication = publications.find((p) => p.id === publicationId);
  if (!publication) {
    return <EmptyState message="Publication not found" actionLabel="Back to calendar" onAction={onBack} />;
  }

  const isPartial =
  publication.targets.some((t) => t.status === "PUBLISHED") &&
  publication.targets.some((t) => t.status !== "PUBLISHED");
  const isActing = actionLoading === publication.id;

  return (
    <div className="flex flex-col gap-4">
      <button onClick={onBack} className="font-poppins text-[11px] text-muted-foreground w-fit">← Back to calendar</button>

      <div className="bg-card rounded-xl border border-border p-4 flex items-center justify-between flex-wrap gap-2">
        <div>
          <p className="font-poppins text-[14px] font-semibold text-foreground">{publication.postTitle}</p>
          <p className="font-poppins text-[11px] text-muted-foreground">{publication.attempts} attempt{publication.attempts !== 1 ? "s" : ""}</p>
        </div>
        <StatusChip status={publication.status} />
      </div>

      {isPartial && (
        <PartialSuccessSummary
          items={publication.targets.map((t) => ({
            label: t.identityLabel,
            success: t.status === "PUBLISHED",
            errorCategory: t.errorCategory,
            retryable: t.retryable,
          }))}
          onRetry={() => retryPublication(publication.id)}
        />
      )}

      <div className="flex flex-col gap-2">
        {publication.targets.map((target) => (
          <ProviderResultCard
            key={target.identityId}
            provider={target.provider as BadgeProvider}
            identityLabel={target.identityLabel}
            status={target.status}
            providerUrl={target.providerUrl}
            errorCategory={target.errorCategory}
            retryable={target.retryable && permissions.social_publish_retry === "EDIT"}
            postingMode={target.postingMode}
            onRetry={() => retryPublication(publication.id)}
            actionLoading={isActing}
          />
        ))}
      </div>

      {publication.status === "PENDING" && permissions.social_publish_cancel === "EDIT" && (
        <button
          onClick={() => cancelPublication(publication.id)}
          disabled={isActing}
          className="font-poppins text-[12px] font-medium text-red-500 disabled:opacity-40 w-fit"
        >
          Cancel publication
        </button>
      )}
    </div>
  );
}