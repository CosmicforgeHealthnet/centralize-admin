import { Suspense, use } from "react";
import VerificationDetail from "@/components/verification/VerificationDetail";

interface Props {
  params: Promise<{ id: string }>;
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col bg-white min-h-screen animate-pulse">
      <div className="px-4 sm:px-6 pt-4 sm:pt-5 pb-3 flex items-center gap-2">
        <div className="h-4 w-20 bg-gray-100 rounded" />
        <div className="h-4 w-4 bg-gray-100 rounded" />
        <div className="h-4 w-32 bg-gray-100 rounded" />
      </div>
      <div className="flex flex-col md:flex-row gap-4 px-4 sm:px-6 flex-1 items-start">
        <div className="hidden md:flex flex-col gap-3 w-[175px] shrink-0">
          <div className="rounded-xl bg-gray-100 w-full aspect-[175/210]" />
          <div className="rounded-xl bg-gray-100 h-[160px]" />
          <div className="rounded-xl bg-gray-100 h-[70px]" />
        </div>
        <div className="flex-1 w-full rounded-xl bg-gray-100 h-[420px]" />
      </div>
      <div className="mt-4 h-[66px] bg-gray-100" />
    </div>
  );
}

export default function VerificationDetailPage({ params }: Props) {
  const { id } = use(params); // ✅ unwrap the Promise

  return (
    <Suspense fallback={<DetailSkeleton />}>
      <VerificationDetail id={id} />
    </Suspense>
  );
}