import HelpSubNav from "@/components/help/HelpSubNav";
import HelpStatCards from "@/components/help/HelpStatCards";
import RecentTickets from "@/components/help/RecentTickets";
import SupportRequestsChart from "@/components/help/SupportRequestsChart";
import TicketTypeChart from "@/components/help/TicketTypeChart";
import StaffActivity from "@/components/help/StaffActivity";
import UserTrafficChart from "@/components/help/UserTrafficChart";
import OpenTicketsPerAgent from "@/components/help/OpenTicketsPerAgent";

export default function HelpPage() {
  return (
    <div className="flex gap-4">

      {/* Sub Nav — left column, desktop only */}
      <div className="hidden min-[1014px]:block w-[160px] shrink-0">
        <HelpSubNav />
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col gap-4">

        {/* Mobile subnav — shows below 1014px */}
        <div className="min-[1014px]:hidden">
          <HelpSubNav />
        </div>

        {/* ROW 1: stat cards + Support Requests + Ticket Type */}
        <div className="flex gap-4">
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            <HelpStatCards />
            <RecentTickets />
          </div>
          <div className="hidden min-[1014px]:flex flex-col gap-4 w-[200px] shrink-0">
            <SupportRequestsChart />
            <TicketTypeChart />
          </div>
        </div>

        {/* ROW 2: Staff Activity + User Traffic */}
        <div className="flex gap-4">
          <div className="flex-1 min-w-0">
            <StaffActivity />
          </div>
          <div className="hidden min-[1014px]:block w-[280px] shrink-0">
            <UserTrafficChart />
          </div>
        </div>

        {/* ROW 3: Open Tickets per Agents */}
        <OpenTicketsPerAgent />

      </div>
    </div>
  );
}