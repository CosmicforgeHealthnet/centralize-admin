"use client";

const staff = [
  { id: "#123456789", name: "Praise Adedipupo", category: "Live Chat", assigned: 200, resolved: 149 },
  { id: "#123456789", name: "Praise Adedipupo", category: "Live Chat", assigned: 200, resolved: 149 },
  { id: "#123456789", name: "Praise Adedipupo", category: "Live Chat", assigned: 200, resolved: 149 },
  { id: "#123456789", name: "Praise Adedipupo", category: "Live Chat", assigned: 200, resolved: 149 },
  { id: "#123456789", name: "Praise Adedipupo", category: "Live Chat", assigned: 200, resolved: 149 },
];

export default function StaffActivity() {
  return (
    <div className="bg-card rounded-lg border border-border flex flex-col w-full min-w-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4">
        <h2 className="text-[14px] font-bold text-foreground">Staff Activity</h2>
        <button className="flex items-center gap-2 border border-border rounded-md px-3 py-1.5 hover:bg-muted transition-colors">
          <span className="text-[12px] font-medium text-muted-foreground">All Category</span>
          <span className="text-[10px] text-muted-foreground">▼</span>
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-secondary border-y border-border">
              {["Staff ID", "Staff Name", "Category", "Assigned", "Resolved"].map((h) => (
                <th
                  key={h}
                  className="text-[11px] font-semibold text-muted-foreground text-left py-3 px-4 whitespace-nowrap uppercase tracking-wider"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {staff.map((s, i) => (
              <tr key={i} className="hover:bg-muted transition-colors">
                <td className="text-[11px] text-muted-foreground py-4 px-4 whitespace-nowrap">{s.id}</td>
                <td className="text-[11px] font-medium text-foreground py-4 px-4 whitespace-nowrap">{s.name}</td>
                <td className="text-[11px] text-foreground py-4 px-4 whitespace-nowrap">{s.category}</td>
                <td className="text-[11px] font-bold text-foreground py-4 px-4 whitespace-nowrap">{s.assigned}</td>
                <td className="text-[11px] font-bold text-foreground py-4 px-4 whitespace-nowrap">{s.resolved}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}