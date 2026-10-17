"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Mail,
  Clock,
  Globe,
  Tag,
  Send,
  Paperclip,
  Smile,
  X,
  Plus,
} from "lucide-react";
import HelpSubNav from "@/components/help/HelpSubNav";

type Message = {
  id: number;
  sender: string;
  role: "User" | "Agent";
  time: string;
  text: string;
  avatar: string;
};

type Update = {
  status: string;
  date: string;
  timeAgo: string;
  body: string;
};

type Tab = {
  id: string;
  name: string;
  avatar: string;
};

const tabs: Tab[] = [
  { id: "1", name: "Jeffrey Godwin", avatar: "https://i.pravatar.cc/32?img=11" },
  { id: "2", name: "Sarah James",    avatar: "https://i.pravatar.cc/32?img=5"  },
  { id: "3", name: "John Doe",       avatar: "https://i.pravatar.cc/32?img=8"  },
  { id: "4", name: "Mary Johnson",   avatar: "https://i.pravatar.cc/32?img=9"  },
];

const messages: Message[] = [
  {
    id: 1,
    sender: "Jeffrey Godwin",
    role: "User",
    time: "1 minute ago",
    text: "Hi, I'm having issues with updating my account. It keeps failing when I upload a new profile picture. It keeps saying 'failed to upload'. How can you help me?",
    avatar: "https://i.pravatar.cc/32?img=11",
  },
  {
    id: 2,
    sender: "Sarah James",
    role: "Agent",
    time: "40 sec ago",
    text: "What device are you using?",
    avatar: "https://i.pravatar.cc/32?img=5",
  },
  {
    id: 3,
    sender: "Jeffrey Godwin",
    role: "User",
    time: "1 minute ago",
    text: "A tablet.",
    avatar: "https://i.pravatar.cc/32?img=11",
  },
];

const updates: Update[] = [
  {
    status: "Submitted",
    date: "12/04/2025  02:03:23",
    timeAgo: "3 Days ago",
    body: "Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book.",
  },
  {
    status: "Processing",
    date: "15/04/2025  02:03:23",
    timeAgo: "15 Secs ago",
    body: "Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book.",
  },
];

function TabBar({
  tabs,
  activeTab,
  onSelect,
  onClose,
}: {
  tabs: Tab[];
  activeTab: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div className="flex items-center bg-[#d7dbdb] overflow-x-auto scrollbar-none">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          className={`flex items-center gap-2 px-3 py-2.5 shrink-0 border-r border-border/20 transition-all ${
            activeTab === tab.id
              ? "bg-card text-primary"
              : "bg-[#d7dbdb] text-muted-foreground hover:bg-card/60"
          }`}
        >
          <img src={tab.avatar} alt={tab.name} className="w-5 h-5 rounded-full object-cover shrink-0" />
          <span className="text-[12px] font-medium whitespace-nowrap hidden sm:inline">{tab.name}</span>
          <span
            onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
            className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-black/10 transition-colors"
          >
            <X className="w-2.5 h-2.5" />
          </span>
        </button>
      ))}
      <button className="px-3 py-2.5 text-muted-foreground hover:text-primary transition-colors shrink-0 bg-[#d7dbdb]">
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}

function UserPanel({ onStatusChange }: { onStatusChange: (s: string) => void }) {
  const [status, setStatus] = useState("Processing");

  const statusColors: Record<string, { text: string; bg: string; border: string }> = {
    Processing: { text: "text-warning",     bg: "bg-warning/10",     border: "border-warning/30"     },
    Pending:    { text: "text-warning",     bg: "bg-warning/10",     border: "border-warning/30"     },
    Resolved:   { text: "text-success",     bg: "bg-success/10",     border: "border-success/30"     },
    Failed:     { text: "text-destructive", bg: "bg-destructive/10", border: "border-destructive/30" },
  };

  const sc = statusColors[status] || statusColors.Processing;

  return (
    <div className="bg-card rounded-lg border border-border flex flex-col h-full overflow-hidden">

      {/* Avatar + Name */}
      <div className="flex items-center gap-3 px-4 pt-5 pb-4 border-b border-border">
        <img
          src="https://i.pravatar.cc/64?img=11"
          alt="Jeffrey Godwin"
          className="w-12 h-12 rounded-full object-cover shrink-0"
        />
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-foreground truncate">Jeffrey Godwin</p>
        </div>
      </div>

      {/* Info rows */}
      <div className="flex flex-col gap-3 px-4 py-4 border-b border-border">
        {[
          { icon: Mail,  text: "jamaneisIag@gmail.com" },
          { icon: Clock, text: "12/04/2025  02:03:23 pm" },
          { icon: Globe, text: "Lagos, Nigeria" },
        ].map(({ icon: Icon, text }) => (
          <div key={text} className="flex items-center gap-2 min-w-0">
            <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-[11px] text-muted-foreground truncate">{text}</span>
          </div>
        ))}

        {/* Tags */}
        <div className="flex items-start gap-2 mt-1">
          <Tag className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="flex gap-1.5 flex-wrap">
            <span className="text-[10px] font-semibold text-primary bg-accent px-2 py-0.5 rounded-full whitespace-nowrap">
              Account Ticket
            </span>
            <span className="text-[10px] font-semibold text-success bg-success/10 px-2 py-0.5 rounded-full whitespace-nowrap">
              Standard Plan
            </span>
          </div>
        </div>
      </div>

      {/* Status */}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-semibold text-foreground shrink-0">Status</span>
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); onStatusChange(e.target.value); }}
            className={`text-[11px] font-semibold border rounded-md px-2 py-1 outline-none cursor-pointer ${sc.text} ${sc.bg} ${sc.border}`}
          >
            <option value="Processing">Processing</option>
            <option value="Pending">Pending</option>
            <option value="Resolved">Resolved</option>
            <option value="Failed">Failed</option>
          </select>
        </div>
      </div>

      {/* Updates timeline */}
      <div className="px-4 py-3 flex-1 overflow-y-auto min-h-0">
        <p className="text-[12px] font-bold text-foreground mb-3">Updates</p>
        <div className="relative">
          <div className="absolute left-[5px] top-2 bottom-2 w-[1.5px] bg-border" />
          <div className="flex flex-col gap-5">
            {updates.map((u, i) => (
              <div key={i} className="pl-5 relative">
                <div className={`absolute left-0 top-1 w-[11px] h-[11px] rounded-full border-2 ${
                  i === 0 ? "bg-primary border-primary" : "bg-card border-border"
                }`} />
                <div className="flex items-center justify-between mb-0.5 gap-1">
                  <span className="text-[11px] font-bold text-foreground">{u.status}</span>
                  <span className="text-[9px] text-muted-foreground shrink-0">{u.timeAgo}</span>
                </div>
                <p className="text-[9px] text-muted-foreground mb-1">{u.date}</p>
                <p className="text-[9px] text-muted-foreground leading-relaxed">{u.body}</p>
              </div>
            ))}
            <div className="pl-5 relative">
              <div className="absolute left-0 top-1 w-[11px] h-[11px] rounded-full border-2 bg-card border-border" />
            </div>
          </div>
        </div>
      </div>

      {/* Bottom message bar */}
      <div className="px-3 py-3 border-t border-border">
        <div className="flex items-center gap-2 bg-muted rounded-md px-3 py-2">
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap shrink-0 ${sc.text} ${sc.bg}`}>
            {status}
          </span>
          <input
            type="text"
            placeholder="Write a message..."
            className="flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground min-w-0"
          />
          <button className="shrink-0 text-primary hover:opacity-70 transition-opacity">
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function TicketDetails() {
  return (
    <div className="bg-card rounded-lg border border-border p-4 md:p-5">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <span className="text-[14px] font-bold text-foreground">Ticket &nbsp;#123456789</span>
        <span className="text-[10px] font-semibold text-primary bg-accent px-2.5 py-1 rounded-full">
          Account Ticket
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground mb-1">Ticket Title</p>
          <p className="text-[11px] font-semibold text-primary">Log In or Access issue</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground mb-1">Ticket Type</p>
          <p className="text-[11px] font-semibold text-primary">Account Related</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground mb-1">Membership Type</p>
          <span className="inline-block text-[8px] font-semibold text-primary-foreground bg-primary px-2.5 py-0.5 rounded-full">
            Standard Plan
          </span>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground mb-1">Membership Status</p>
          <span className="inline-block text-[8px] font-semibold text-success bg-success/10 px-2.5 py-0.5 rounded-full">
            Active
          </span>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground mb-1">Product Suite</p>
          <p className="text-[11px] font-semibold text-primary">Healthnet</p>
        </div>
      </div>

      <div>
        <p className="text-[11px] font-bold text-foreground mb-1">Description</p>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry's standard
          dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen
          book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged.
        </p>
      </div>
    </div>
  );
}

function LiveChat({ messages }: { messages: Message[] }) {
  const [input, setInput] = useState("");

  return (
    <div className="bg-card rounded-lg border border-border flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="px-5 py-4 border-b border-border shrink-0">
        <p className="text-[14px] font-bold text-foreground">Live Chat</p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-5 py-4 flex flex-col gap-5 min-h-0">
        {messages.map((msg) => (
          <div key={msg.id} className="flex items-start gap-3">
            <img
              src={msg.avatar}
              alt={msg.sender}
              className="w-7 h-7 md:w-8 md:h-8 rounded-full object-cover shrink-0 mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                <span className="text-[12px] font-bold text-foreground">{msg.sender}</span>
                <span className="text-[9px] text-muted-foreground">{msg.time}</span>
              </div>
              <p className="text-[10px] text-muted-foreground mb-1">{msg.role}</p>
              <p className="text-[12px] text-foreground leading-relaxed">{msg.text}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="px-4 py-3 border-t border-border shrink-0">
        <div className="flex items-center gap-2 md:gap-3 bg-muted rounded-[10px] px-3 md:px-4 py-2.5">
          <button className="text-muted-foreground hover:text-primary transition-colors shrink-0">
            <Smile className="w-4 h-4" />
          </button>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Write a message..."
            className="flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground min-w-0"
          />
          <button className="text-muted-foreground hover:text-primary transition-colors shrink-0">
            <Paperclip className="w-4 h-4" />
          </button>
          <button className="w-8 h-8 rounded-full bg-primary flex items-center justify-center hover:bg-primary/80 transition-colors shrink-0">
            <Send className="w-3.5 h-3.5 text-primary-foreground" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ActiveConversationPage() {
  const router = useRouter();
  const [openTabs, setOpenTabs] = useState<Tab[]>(tabs);
  const [activeTab, setActiveTab] = useState(tabs[0].id);
  const [showUserPanel, setShowUserPanel] = useState(false);

  const handleClose = (id: string) => {
    const remaining = openTabs.filter((t) => t.id !== id);
    setOpenTabs(remaining);
    if (activeTab === id && remaining.length > 0) setActiveTab(remaining[0].id);
    if (remaining.length === 0) router.push("/dashboard/help/tickets");
  };

  return (
    <div className="flex gap-4 min-h-0">
      {/* Sub Nav */}
      <div className="hidden min-[1014px]:block w-[160px] shrink-0">
        <HelpSubNav />
      </div>

      <div className="flex-1 min-w-0 flex flex-col gap-3">

        {/* Mobile subnav */}
        <div className="min-[1014px]:hidden">
          <HelpSubNav />
        </div>

        {/* Add New Ticket */}
        <div className="flex justify-end">
          <button className="bg-primary hover:bg-primary/90 transition-colors text-primary-foreground text-[13px] font-semibold px-5 py-2.5 rounded-lg">
            Add New Ticket
          </button>
        </div>

        {/* Tab bar */}
        <div className="rounded-lg overflow-hidden border border-border">
          <TabBar
            tabs={openTabs}
            activeTab={activeTab}
            onSelect={setActiveTab}
            onClose={handleClose}
          />
        </div>

        {/* Mobile: toggle user panel button */}
        <div className="flex lg:hidden">
          <button
            onClick={() => setShowUserPanel(!showUserPanel)}
            className="text-[12px] font-semibold text-primary border border-primary/30 bg-accent px-4 py-2 rounded-md transition-colors hover:bg-secondary"
          >
            {showUserPanel ? "Hide User Info" : "Show User Info"}
          </button>
        </div>

        {/* Content */}
        <div className="flex gap-3 flex-1 min-h-0 items-start">

          {/* Left: user panel */}
          <div className={`
            shrink-0 flex flex-col
            ${showUserPanel ? "flex" : "hidden"} lg:flex
            w-full lg:w-[220px]
          `}
            style={{ minHeight: 500 }}
          >
            <UserPanel onStatusChange={() => {}} />
          </div>

          {/* Right: ticket + chat */}
          <div className="flex-1 min-w-0 flex flex-col gap-3">
            <TicketDetails />
            <div className="flex flex-col" style={{ minHeight: 340 }}>
              <LiveChat messages={messages} />
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}