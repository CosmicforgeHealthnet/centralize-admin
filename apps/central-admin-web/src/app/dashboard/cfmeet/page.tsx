import { Suspense } from "react";
import CfMeetSection from "@/components/cfmeet/CfMeetSection";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CfMeetSection />
    </Suspense>
  );
}
