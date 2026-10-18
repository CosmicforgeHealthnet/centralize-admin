"use client";

import { useState } from "react";
import { Search, Send, Paperclip, Smile } from "lucide-react";
import HelpSubNav from "@/components/help/HelpSubNav";

// --- Types ---
type Contact = {
  id: string;
  name: string;
  message: string;
  time: string;
  avatar: string;
  online: boolean;
  unread?: number;
};

type Message = {
  id: number;
  text: string;
  time: string;
  fromUser: boolean;
  avatar: string;
};

type UserInfo = {
  name: string;
  userId: string;
  avatar: string;
  bio: string;
  email: string;
  mobile: string;
  location: string;
  suite: string;
  membership: string;
};

// --- Static Data ---
const contacts: Contact[] = [
  { id: "1",  name: "Dr Tasnim Mridha", message: "You need to avoid anti-inflammatory...", time: "18:31 PM", avatar: "https://i.pravatar.cc/40?img=1",  online: true  },
  { id: "2",  name: "Dr Tasnim Mridha", message: "You need to avoid anti-inflammatory...", time: "18:31 PM", avatar: "https://i.pravatar.cc/40?img=2",  online: true, unread: 2 },
  { id: "3",  name: "Dr Tasnim Mridha", message: "You need to avoid anti-inflammatory...", time: "18:31 PM", avatar: "https://i.pravatar.cc/40?img=3",  online: false },
  { id: "4",  name: "Dr Tasnim Mridha", message: "You need to avoid anti-inflammatory...", time: "18:31 PM", avatar: "https://i.pravatar.cc/40?img=4",  online: true  },
  { id: "5",  name: "Dr Tasnim Mridha", message: "You need to avoid anti-inflammatory...", time: "18:31 PM", avatar: "https://i.pravatar.cc/40?img=5",  online: false },
  { id: "6",  name: "Dr Tasnim Mridha", message: "You need to avoid anti-inflammatory...", time: "18:31 PM", avatar: "https://i.pravatar.cc/40?img=6",  online: true  },
  { id: "7",  name: "Dr Tasnim Mridha", message: "You need to avoid anti-inflammatory...", time: "18:31 PM", avatar: "https://i.pravatar.cc/40?img=7",  online: true  },
  { id: "8",  name: "Dr Tasnim Mridha", message: "You need to avoid anti-inflammatory...", time: "18:31 PM", avatar: "https://i.pravatar.cc/40?img=8",  online: false },
  { id: "9",  name: "Dr Tasnim Mridha", message: "You need to avoid anti-inflammatory...", time: "18:31 PM", avatar: "https://i.pravatar.cc/40?img=9",  online: true  },
  { id: "10", name: "Dr Tasnim Mridha", message: "You need to avoid anti-inflammatory...", time: "18:31 PM", avatar: "https://i.pravatar.cc/40?img=10", online: false },
];

const mockMessages: Message[] = [
  { id: 1, text: "Good Afternoon Doctor",            time: "12:45pm", fromUser: true,  avatar: "https://i.pravatar.cc/40?img=11" },
  { id: 2, text: "Good Afternoon Grace",             time: "12:45pm", fromUser: false, avatar: "https://i.pravatar.cc/40?img=1"  },
  { id: 3, text: "I got your cultures...",            time: "12:47pm", fromUser: false, avatar: "https://i.pravatar.cc/40?img=1"  },
  { id: 4, text: "Other test results are out too",   time: "12:47pm", fromUser: false, avatar: "https://i.pravatar.cc/40?img=1"  },
  { id: 5, text: "I wish we had better news",        time: "12:48pm", fromUser: false, avatar: "https://i.pravatar.cc/40?img=1"  },
  { id: 6, text: "You should check in with Dr Jennifer.", time: "12:48pm", fromUser: false, avatar: "https://i.pravatar.cc/40?img=1" },
];

const mockUserInfo: UserInfo = {
  name: "Jeffrey Godwin",
  userId: "#1234567890",
  avatar: "https://i.pravatar.cc/120?img=11",
  bio: "Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book.",
  email: "jamaneisIag@gmail.com",
  mobile: "+2348067735987",
  location: "Lagos, Nigeria",
  suite: "Healthnet",
  membership: "Standard",
};

// --- Components ---

function ContactRow({
  contact,
  isActive,
  onClick,
}: {
  contact: Contact;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 transition-all duration-150 text-left border-b border-border last:border-0 ${
        isActive ? "bg-secondary" : "hover:bg-muted"
      }`}
    >
      <div className="relative shrink-0">
        <img src={contact.avatar} alt={contact.name} className="w-9 h-9 rounded-full object-cover" />
        <span className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-card ${
          contact.online ? "bg-success" : "bg-input"
        }`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1 mb-0.5">
          <span className="text-[12px] font-semibold text-foreground truncate">{contact.name}</span>
          <span className="text-[9px] text-muted-foreground shrink-0">{contact.time}</span>
        </div>
        <div className="flex items-center justify-between gap-1">
          <p className="text-[11px] text-muted-foreground truncate">{contact.message}</p>
          {contact.unread && (
            <span className="shrink-0 w-4 h-4 rounded-full bg-primary text-primary-foreground text-[8px] font-bold flex items-center justify-center">
              {contact.unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function ChatArea({
  messages,
  onBack,
}: {
  messages: Message[];
  onBack: () => void;
}) {
  const [input, setInput] = useState("");

  return (
    <div
      className="flex-1 min-w-0 flex flex-col relative overflow-hidden"
      style={{
        backgroundImage: "url('/chat-pattern.png')",
        backgroundSize: "auto",
        backgroundRepeat: "repeat",
        backgroundColor: "#3D44C4",
      }}
    >
      {/* Mobile back */}
      <button
        onClick={onBack}
        className="md:hidden absolute top-3 left-3 z-20 flex items-center gap-1.5 bg-card/90 backdrop-blur-sm border border-card/30 rounded-md px-3 py-1.5 text-[11px] font-semibold text-primary shadow-sm"
      >
        ← Back
      </button>

      {/* Today label */}
      <div className="flex justify-center pt-4 pb-2 relative z-10">
        <span className="text-[11px] font-semibold text-white/80 bg-white/10 backdrop-blur-sm px-4 py-1 rounded-full">
          Today
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3 relative z-10">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex items-end gap-2 ${msg.fromUser ? "flex-row" : "flex-row-reverse"}`}
          >
            <img
              src={msg.avatar}
              alt="avatar"
              className="w-7 h-7 rounded-full object-cover shrink-0 mb-0.5"
            />
            <div className={`flex flex-col gap-0.5 max-w-[65%] ${msg.fromUser ? "items-start" : "items-end"}`}>
              <div
                className={`px-3 py-2 rounded-[10px] text-[12px] leading-relaxed ${
                  msg.fromUser
                    ? "bg-white/20 backdrop-blur-sm text-white rounded-bl-none"
                    : "bg-card/90 text-foreground rounded-br-none"
                }`}
              >
                {msg.text}
              </div>
              <span className="text-[9px] text-white/60">{msg.time}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Input bar */}
      <div className="relative z-10 px-4 py-3">
        <div className="flex items-center gap-2 bg-card rounded-[10px] px-4 py-2.5 shadow-sm">
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

function EmptyChatArea() {
  return (
    <div
      className="flex-1 min-w-0 relative overflow-hidden"
      style={{
        backgroundImage: "url('/chat-pattern.png')",
        backgroundSize: "auto",
        backgroundRepeat: "repeat",
        backgroundColor: "#3D44C4",
      }}
    >
      <div className="relative z-10 flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
        <div className="w-14 h-14 rounded-full bg-white/15 flex items-center justify-center mb-1">
          <svg className="w-7 h-7 text-white/80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
        </div>
        <p className="text-white/70 text-[12px] font-medium">
          Select a conversation to start chatting
        </p>
      </div>
    </div>
  );
}

function UserInfoPanel({ user, onBack }: { user: UserInfo; onBack: () => void }) {
  return (
    <div className="w-full lg:w-[200px] xl:w-[220px] shrink-0 bg-card border-l border-border flex flex-col overflow-y-auto">

      {/* Mobile back */}
      <button
        onClick={onBack}
        className="lg:hidden flex items-center gap-1.5 px-4 py-3 text-[11px] font-semibold text-primary border-b border-border"
      >
        ← Back to chat
      </button>

      {/* Avatar */}
      <div className="flex flex-col items-center px-4 pt-6 pb-4 border-b border-border">
        <img
          src={user.avatar}
          alt={user.name}
          className="w-20 h-20 rounded-full object-cover mb-3 ring-4 ring-primary/10"
        />
        <p className="text-[13px] font-bold text-foreground text-center">{user.name}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">User ID: {user.userId}</p>
      </div>

      {/* Bio + Info */}
      <div className="px-4 py-4 flex flex-col gap-4">
        <div>
          <p className="text-[11px] font-bold text-foreground mb-1.5">Bio</p>
          <p className="text-[10px] text-muted-foreground leading-relaxed">{user.bio}</p>
        </div>

        <div className="flex flex-col gap-2.5">
          {[
            { label: "Email",      value: user.email      },
            { label: "Mobile",     value: user.mobile     },
            { label: "Location",   value: user.location   },
            { label: "Suite",      value: user.suite      },
            { label: "Membership", value: user.membership },
          ].map(({ label, value }) => (
            <div key={label}>
              <p className="text-[10px] font-semibold text-foreground">{label}:{" "}
                <span className="font-normal text-muted-foreground">{value}</span>
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Main Page ---
export default function LiveChatPage() {
  const [activeContact, setActiveContact] = useState<string | null>(null);
  const [search, setSearch]               = useState("");
  const [mobileView, setMobileView]       = useState<"list" | "chat" | "info">("list");

  const filtered = contacts.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleSelect = (id: string) => {
    setActiveContact(id);
    setMobileView("chat");
  };

  return (
    <div className="flex gap-4">

      {/* Sub Nav — desktop */}
      <div className="hidden min-[1014px]:block w-[160px] shrink-0">
        <HelpSubNav />
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col gap-4">

        {/* Mobile subnav */}
        <div className="min-[1014px]:hidden">
          <HelpSubNav />
        </div>

        {/* Chat container */}
        <div
          className="flex w-full overflow-hidden rounded-lg border border-border"
          style={{ minHeight: 620 }}
        >

          {/* ---- 1. Contact List ---- */}
          <div className={`
            flex flex-col bg-card border-r border-border
            w-full md:w-[210px] lg:w-[220px] shrink-0
            ${mobileView === "list" ? "flex" : "hidden md:flex"}
          `}>
            <div className="px-4 pt-4 pb-3 border-b border-border">
              <h2 className="text-[13px] font-bold text-foreground mb-3">Live Chat Request</h2>
              <div className="flex items-center gap-2 bg-muted border border-border rounded-md px-3 h-[34px]">
                <Search className="w-3 h-3 text-muted-foreground shrink-0" />
                <input
                  type="text"
                  placeholder="Search here..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="bg-transparent text-[11px] text-foreground outline-none w-full placeholder:text-muted-foreground"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {filtered.map((contact) => (
                <ContactRow
                  key={contact.id}
                  contact={contact}
                  isActive={activeContact === contact.id}
                  onClick={() => handleSelect(contact.id)}
                />
              ))}
            </div>
          </div>

          {/* ---- 2. Chat Area ---- */}
          <div className={`
            flex-1 min-w-0 overflow-hidden
            ${mobileView === "chat" ? "flex" : "hidden md:flex"}
            ${activeContact ? "flex-col" : ""}
          `}>
            {activeContact ? (
              <ChatArea
                messages={mockMessages}
                onBack={() => setMobileView("list")}
              />
            ) : (
              <EmptyChatArea />
            )}
          </div>

          {/* ---- 3. User Info Panel ---- */}
          {activeContact && (
            <div className={`
              ${mobileView === "info" ? "flex" : "hidden lg:flex"}
              flex-col
            `}>
              <UserInfoPanel
                user={mockUserInfo}
                onBack={() => setMobileView("chat")}
              />
            </div>
          )}

        </div>

        {/* Mobile: show info button when in chat */}
        {activeContact && mobileView === "chat" && (
          <button
            onClick={() => setMobileView("info")}
            className="lg:hidden text-[12px] font-semibold text-primary border border-primary/30 bg-accent px-4 py-2 rounded-md self-start transition-colors hover:bg-secondary"
          >
            View User Info →
          </button>
        )}

      </div>
    </div>
  );
}