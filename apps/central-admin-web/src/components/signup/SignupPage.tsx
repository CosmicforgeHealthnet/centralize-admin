"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { SignupCarousel } from "@/components/signup/SignupCarousel";

export default function SignupPage() {
  const router = useRouter();

  const [form, setForm] = useState({
    name: "",
    email: "",
    position: "",
    password: "",
    confirmPassword: "",
    terms: false,
  });

  const isValid =
    form.name.trim() !== "" &&
    form.email.trim() !== "" &&
    form.position.trim() !== "" &&
    form.password.trim() !== "" &&
    form.confirmPassword.trim() !== "" &&
    form.terms;

  return (
    <div className="flex min-h-screen w-full flex-col lg:flex-row">
      {/* Left Side: Signup Form */}
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:px-8 lg:px-16 xl:px-24 md:py-20">
        <div className="w-full max-w-[420px]">

          {/* Heading */}
          <div className="flex flex-col gap-[5px] mb-6">
            <h1 className="text-title text-black">Create Your Account</h1>
            <p className="text-[12px] font-poppins text-muted-foreground">
              Welcome! Let&apos;s get you Started.
            </p>
          </div>

          {/* Google Signup */}
          <Button
            variant="outline"
            className="w-full h-[44px] border-[#0000001C] font-roboto font-medium mb-4"
          >
            <svg className="mr-2 h-4 w-4 shrink-0" viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Continue with Google
          </Button>

          {/* Divider */}
          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-[#0000001C]" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-3 text-muted-foreground font-poppins">
                OR
              </span>
            </div>
          </div>

          {/* Form */}
          <div className="flex flex-col gap-[12px]">
            <div className="flex flex-col gap-[5px]">
              <Label htmlFor="name" className="text-priority">
                Name
              </Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Enter Full Name"
                className="h-[44px] bg-white border-[#0000001C]"
              />
            </div>

            <div className="flex flex-col gap-[5px]">
              <Label htmlFor="email" className="text-priority">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="Enter your Email"
                className="h-[44px] bg-white border-[#0000001C]"
              />
            </div>

            <div className="flex flex-col gap-[5px]">
              <Label htmlFor="position" className="text-priority">
                Position
              </Label>
              <Input
                id="position"
                value={form.position}
                onChange={(e) => setForm({ ...form, position: e.target.value })}
                placeholder="Enter your position"
                className="h-[44px] bg-white border-[#0000001C]"
              />
            </div>

            <div className="flex flex-col gap-[5px]">
              <Label htmlFor="password" className="text-priority">
                Password
              </Label>
              <Input
                id="password"
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="Enter Password"
                className="h-[44px] bg-white border-[#0000001C]"
              />
            </div>

            <div className="flex flex-col gap-[5px]">
              <Label htmlFor="confirmPassword" className="text-priority">
                Confirm Password
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                value={form.confirmPassword}
                onChange={(e) =>
                  setForm({ ...form, confirmPassword: e.target.value })
                }
                placeholder="Enter Password"
                className="h-[44px] bg-white border-[#0000001C]"
              />
            </div>

            <div className="flex items-center space-x-2 pt-1">
              <Checkbox
                id="terms"
                checked={form.terms}
                onCheckedChange={(checked) =>
                  setForm({ ...form, terms: !!checked })
                }
                className="border-primary data-[state=checked]:bg-primary"
              />
              <label
                htmlFor="terms"
                className="text-[12px] font-poppins text-foreground font-medium leading-none"
              >
                I accept the{" "}
                <Link href="/terms" className="text-primary font-semibold">
                  Terms & Condition
                </Link>
              </label>
            </div>

            <Button
              className="w-full h-[44px] text-[16px] font-poppins font-semibold text-white"
              disabled={!isValid}
              onClick={() => router.push("/account-type")}
            >
              Sign Up
            </Button>

            <p className="text-center text-[12px] font-poppins text-muted-foreground">
              Already have an account?{" "}
              <Link href="/" className="text-primary font-semibold">
                Sign In
              </Link>
            </p>
          </div>
        </div>
      </div>

      {/* Right Side: Carousel */}
      <div className="hidden lg:flex lg:flex-1 lg:min-h-screen p-4">
        <SignupCarousel />
      </div>
    </div>
  );
}