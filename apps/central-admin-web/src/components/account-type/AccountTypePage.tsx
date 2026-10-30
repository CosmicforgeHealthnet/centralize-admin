"use client";

import Image from "next/image";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Users, ShieldCheck, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoginCarousel } from "@/components/login/LoginCarousel";

const accountTypes = [
  {
    id: "executive",
    title: "Executive Account",
    subtitle: "If this is you, select to proceed!",
    icon: Users,
  },
  {
    id: "super",
    title: "Super Account",
    subtitle: "If this is you, select to proceed!",
    icon: Users,
  },
  {
    id: "admin",
    title: "Admin Account",
    subtitle: "If this is you, select to proceed!",
    icon: ShieldCheck,
  },
  {
    id: "employee",
    title: "Employee Account",
    subtitle: "If this is you, select to proceed!",
    icon: UserRound,
  },
];

export default function AccountTypePage() {
  const [selected, setSelected] = useState<string | null>(null);
  const router = useRouter();

  return (
    <div className="flex min-h-screen w-full flex-col lg:flex-row">
      {/* Left Side */}
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:px-8 lg:px-16 xl:px-24 md:py-20">
        <div className="w-full max-w-[420px]">

          {/* Logo */}
          <div className="mb-8">
            <Image
              src="/logo.svg"
              alt="Cosmicforge Healthnet Logo"
              width={200}
              height={57}
              className="object-contain max-w-[160px] sm:max-w-[200px]"
            />
          </div>

          {/* Heading */}
          <div className="flex flex-col gap-[5px] mb-10">
            <h1 className="text-title text-foreground">
              Select your account type to continue.
            </h1>
            <p className="text-[12px] font-poppins text-muted-foreground">
              Set up your access to manage platform operations, users, and
              medical workflows.
            </p>
          </div>

          {/* Account Type Cards */}
          <div className="flex flex-col gap-[12px]">
            {accountTypes.map((account) => {
              const Icon = account.icon;
              const isSelected = selected === account.id;

              return (
                <button
                  key={account.id}
                  onClick={() => setSelected(account.id)}
                  className={`flex items-center gap-4 w-full px-4 h-[70px] rounded-lg border transition-all duration-200 text-left ${
                    isSelected
                      ? "border-primary bg-secondary"
                      : "border-border bg-card hover:border-primary/40"
                  }`}
                >
                  {/* Icon circle */}
                  <div
                    className={`flex items-center justify-center w-10 h-10 rounded-full shrink-0 transition-all duration-200 ${
                      isSelected ? "bg-primary" : "bg-secondary"
                    }`}
                  >
                    <Icon
                      className={`w-5 h-5 transition-all duration-200 ${
                        isSelected ? "text-primary-foreground" : "text-primary"
                      }`}
                    />
                  </div>

                  {/* Text */}
                  <div className="flex flex-col gap-[3px]">
                    <span className="text-priority text-foreground">
                      {account.title}
                    </span>
                    <span className="text-[12px] font-poppins text-muted-foreground">
                      {account.subtitle}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Proceed Button */}
          <Button
            className="w-full h-[44px] text-[16px] font-poppins font-semibold text-primary-foreground mt-8"
            disabled={!selected}
            onClick={() => router.push("/dashboard")}
          >
            Proceed
          </Button>

        </div>
      </div>

      {/* Right Side */}
      <div className="hidden lg:flex lg:flex-1 lg:min-h-screen p-4">
        <LoginCarousel />
      </div>
    </div>
  );
}