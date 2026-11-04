import type { ReactNode } from "react";
import "./mail-theme.css";

export default function MailLayout({ children }: { children: ReactNode }) {
  return <div className="mail-workspace min-w-0 text-foreground">{children}</div>;
}
