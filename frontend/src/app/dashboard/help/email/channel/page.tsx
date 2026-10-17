"use client";

import { useState } from "react";
import { X } from "lucide-react";
import HelpSubNav from "@/components/help/HelpSubNav";

const defaultData = {
  senderName: "Cosmicforge Support",
  senderEmail: "support@cosmicforge.healthnet.help.com",
  autoResponse: `Hi there,\n\nThank you for your message.\nWe have received your message and would be in touch shortly.\n\nKind regards,\nSupport Team`,
  forwardingEmails: ["help@cosmicforge.healthnet.com"],
};

const inputClass =
  "w-full border border-border rounded-md px-4 py-2.5 text-[12px] text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors bg-card disabled:bg-muted disabled:text-muted-foreground";

export default function SupportChannelPage() {
  const [enabled, setEnabled]                   = useState(true);
  const [senderName, setSenderName]             = useState(enabled ? defaultData.senderName : "");
  const [senderEmail, setSenderEmail]           = useState(enabled ? defaultData.senderEmail : "");
  const [autoResponse, setAutoResponse]         = useState(enabled ? defaultData.autoResponse : "");
  const [forwardingEmails, setForwardingEmails] = useState<string[]>(enabled ? defaultData.forwardingEmails : []);
  const [newEmail, setNewEmail]                 = useState("");

  const handleToggle = () => {
    const next = !enabled;
    setEnabled(next);
    if (next) {
      setSenderName(defaultData.senderName);
      setSenderEmail(defaultData.senderEmail);
      setAutoResponse(defaultData.autoResponse);
      setForwardingEmails(defaultData.forwardingEmails);
    } else {
      setSenderName("");
      setSenderEmail("");
      setAutoResponse("");
      setForwardingEmails([]);
    }
  };

  const handleAddEmail = () => {
    if (newEmail.trim() && !forwardingEmails.includes(newEmail.trim())) {
      setForwardingEmails([...forwardingEmails, newEmail.trim()]);
      setNewEmail("");
    }
  };

  const handleRemoveEmail = (email: string) => {
    setForwardingEmails(forwardingEmails.filter((e) => e !== email));
  };

  const StepBadge = ({ n }: { n: number }) => (
    <span className="w-5 h-5 rounded-full bg-accent text-accent-foreground text-[10px] font-bold flex items-center justify-center shrink-0">
      {n}
    </span>
  );

  const Toggle = () => (
    <button
      onClick={handleToggle}
      className={`relative shrink-0 w-11 h-6 rounded-full transition-colors duration-200 ${
        enabled ? "bg-primary" : "bg-input"
      }`}
    >
      <span
        className={`absolute top-0.5 w-5 h-5 bg-primary-foreground rounded-full shadow transition-all duration-200 ${
          enabled ? "left-[22px]" : "left-0.5"
        }`}
      />
    </button>
  );

  return (
    <div className="flex gap-4">
      {/* Sub Nav — desktop */}
      <div className="hidden min-[1014px]:block w-[160px] shrink-0">
        <HelpSubNav />
      </div>

      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {/* Mobile subnav */}
        <div className="min-[1014px]:hidden">
          <HelpSubNav />
        </div>

        {/* Two column layout */}
        <div className="flex gap-4 items-start">

          {/* ---- LEFT: Form ---- */}
          <div className="flex-1 min-w-0 bg-card rounded-lg border border-border overflow-hidden">
            <div className="p-5 flex flex-col gap-6">

              {/* Step 1 */}
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <StepBadge n={1} />
                  <p className="text-[11px] font-bold text-primary uppercase tracking-wider">
                    Customize Emails to your Customers
                  </p>
                </div>

                <div className="flex flex-col gap-4">
                  {/* Sender Name */}
                  <div>
                    <label className="text-[12px] font-semibold text-foreground block mb-1.5">
                      Sender Name
                    </label>
                    <input
                      type="text"
                      value={senderName}
                      onChange={(e) => setSenderName(e.target.value)}
                      placeholder="Enter Username"
                      disabled={!enabled}
                      className={inputClass}
                    />
                  </div>

                  {/* Sender Email */}
                  <div>
                    <label className="text-[12px] font-semibold text-foreground block mb-1.5">
                      Sender Email
                    </label>
                    <input
                      type="email"
                      value={senderEmail}
                      onChange={(e) => setSenderEmail(e.target.value)}
                      placeholder="Enter Email"
                      disabled={!enabled}
                      className={inputClass}
                    />
                  </div>

                  {/* Auto-Response Message */}
                  <div>
                    <label className="text-[12px] font-semibold text-foreground block mb-1.5">
                      Auto-Response Message
                    </label>
                    <textarea
                      value={autoResponse}
                      onChange={(e) => setAutoResponse(e.target.value)}
                      placeholder="Auto-responder is off. Add a message to turn on."
                      disabled={!enabled}
                      rows={6}
                      className={`${inputClass} resize-none`}
                    />
                  </div>
                </div>
              </div>

              {/* Step 2 */}
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <StepBadge n={2} />
                  <p className="text-[11px] font-bold text-primary uppercase tracking-wider">
                    Setup Rules to Match Issues to this Channel
                  </p>
                </div>

                <div className="flex flex-col gap-3">
                  <div>
                    <p className="text-[12px] font-semibold text-foreground mb-1">
                      Forwarding Addresses
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Issues forwarded to{" "}
                      <span className="text-primary font-medium">
                        {senderEmail || "Sender Email"}
                      </span>{" "}
                      from this addresses will be associated with this channel.
                    </p>
                  </div>

                  {/* Existing forwarding emails */}
                  {forwardingEmails.map((email) => (
                    <div
                      key={email}
                      className="flex items-center justify-between border border-border rounded-md px-4 py-2.5 bg-card"
                    >
                      <span className="text-[12px] text-foreground">{email}</span>
                      <button
                        onClick={() => handleRemoveEmail(email)}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}

                  {/* Add forwarding email */}
                  <div className="flex gap-2">
                    <input
                      type="email"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleAddEmail()}
                      placeholder="Add forwarding email"
                      disabled={!enabled}
                      className={`flex-1 min-w-0 border border-border rounded-md px-4 py-2.5 text-[12px] text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors bg-card disabled:bg-muted`}
                    />
                    <button
                      onClick={handleAddEmail}
                      disabled={!enabled}
                      className="bg-primary hover:bg-primary/90 disabled:opacity-50 transition-colors text-primary-foreground text-[12px] font-semibold px-5 py-2.5 rounded-md shrink-0"
                    >
                      Add
                    </button>
                  </div>
                </div>
              </div>

            </div>
          </div>

          {/* ---- RIGHT: Toggle + Illustration ---- */}
          <div className="hidden min-[1014px]:flex flex-col w-[280px] xl:w-[320px] shrink-0 bg-card rounded-lg border border-border p-5 gap-6">

            {/* Toggle row */}
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-semibold text-foreground">
                Enable Custom Email Templates
              </p>
              <Toggle />
            </div>

            {/* Illustration */}
            <div className="flex flex-col items-center gap-4">
              <img
                src="/email-illustration.png"
                alt="Email illustration"
                style={{ width: 200, height: 224, objectFit: "contain" }}
              />
              <p className="text-[11px] text-foreground font-semibold text-center leading-relaxed">
                Enable custom email templates to customize the emails sent to customers through this channel.
              </p>
            </div>

          </div>

        </div>

        {/* Mobile toggle */}
        <div className="min-[1014px]:hidden bg-card rounded-lg border border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-semibold text-foreground">
              Enable Custom Email Templates
            </p>
            <Toggle />
          </div>
        </div>

      </div>
    </div>
  );
}