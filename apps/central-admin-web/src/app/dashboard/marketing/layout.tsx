import type { ReactNode } from "react";
import "./marketing-theme.css";
export default function MarketingLayout({children}: {children: ReactNode}) {return <div className="marketing-workspace min-w-0 text-foreground">{children}</div>;}
