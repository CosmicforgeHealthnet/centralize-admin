"use client";

import Image from "next/image";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { LoginCarousel } from "@/components/login/LoginCarousel";
import { useAuthStore } from "@/stores/auth.store";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const googleError = searchParams.get("error");
  const { login, isLoading, error, clearError } = useAuthStore();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");

  const validateEmail = (val: string) => {
    if (!val) return "Email is required";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) return "Enter a valid email address";
    return "";
  };

  const validatePassword = (val: string) => {
    if (!val) return "Password is required";
    if (val.length < 6) return "Password must be at least 6 characters";
    return "";
  };

  const handleSubmit = async () => {
    const eErr = validateEmail(email);
    const pErr = validatePassword(password);
    setEmailError(eErr);
    setPasswordError(pErr);
    if (eErr || pErr) return;

    clearError();
    await login(email, password);

    const state = useAuthStore.getState();
    if (!state.error) {
      router.push(state.mustChangePassword ? "/change-password" : "/dashboard");
    }
  };

  return (
    <div className="flex min-h-screen w-full flex-col lg:flex-row">
      {/* Left Side: Login Form */}
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:px-8 lg:px-16 xl:px-24 md:py-20">
        <div className="w-full max-w-[420px]">
          {/* Logo */}
          <div className="mb-6">
            <Image
              src="/logo.svg"
              alt="Cosmicforge Healthnet Logo"
              width={200}
              height={57}
              className="object-contain max-w-[160px] sm:max-w-[200px]"
            />
          </div>

          <div className="space-y-1 mb-2 text-center">
            <h1 className="text-title text-black">Log In to your Account</h1>
            <p className="text-body-text text-muted-foreground py-4">Welcome Back!</p>
          </div>

          {/* Error banner */}
          {(error || googleError) && (
            <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error || googleError}
            </div>
          )}

          {/* Google Login */}
          {/* <Button
            variant="outline"
            className="w-full h-[50px] border-[#0000001C] font-roboto font-medium mb-4"
            type="button"
            disabled={isLoading}
            onClick={() => {
              window.location.href = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"}/api/auth/google`;
            }}
          >
            <svg className="mr-2 h-4 w-4 shrink-0" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.77c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            Continue with Google
          </Button> */}

          {/* Divider */}
          {/* <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-[#0000001C]" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-3 text-muted-foreground font-poppins">OR</span>
            </div>
          </div> */}

          {/* Form */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-priority">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="Enter your Email"
                className="h-[50px] bg-white border-[#0000001C]"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailError) setEmailError("");
                }}
                onBlur={() => setEmailError(validateEmail(email))}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                disabled={isLoading}
                aria-invalid={!!emailError}
              />
              {emailError && (
                <p className="text-xs text-destructive mt-1">{emailError}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-priority">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Enter Password"
                className="h-[50px] bg-white border-[#0000001C]"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (passwordError) setPasswordError("");
                }}
                onBlur={() => setPasswordError(validatePassword(password))}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                disabled={isLoading}
                aria-invalid={!!passwordError}
              />
              {passwordError && (
                <p className="text-xs text-destructive mt-1">{passwordError}</p>
              )}
            </div>

            <div className="flex items-center space-x-2 pt-1">
              <Checkbox
                id="remember"
                className="border-primary data-[state=checked]:bg-primary"
              />
              <label
                htmlFor="remember"
                className="text-[12px] font-poppins text-primary font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Remember Me
              </label>
            </div>

            <Button
              className="w-full text-subheading text-white mt-2"
              onClick={handleSubmit}
              disabled={isLoading || !email || !password}
            >
              {isLoading ? "Logging in…" : "Log In"}
            </Button>
          </div>
        </div>
      </div>

      {/* Right Side: Carousel */}
      <div className="hidden lg:flex lg:flex-1 lg:min-h-screen p-4">
        <LoginCarousel />
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground text-sm">Loading...</p>
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}