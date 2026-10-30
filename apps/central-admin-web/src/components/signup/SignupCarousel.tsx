"use client";

import React, { useState, useEffect } from "react";
import Image from "next/image";

const slides = [
  {
    background:
      "radial-gradient(102.19% 102.19% at 50% 46.56%, #2737A7 0%, #0F1341 100%)",
    title: "Create an Admin Account!",
    subtitle:
      "Set up your access to manage platform operations, users, and medical workflows.",
    image: "/signupImage/img1.png",
    alt: "Admin dashboard illustration",
  },
  {
    background:
      "radial-gradient(102.19% 102.19% at 50% 46.56%, #1557A7 0%, #0C1F47 100%)",
    title: "Join the Admin Team!",
    subtitle:
      "Let's get you started, your dashboard awaits with tools to manage care at scale.",
    image: "/signupImage/img2.png",
    alt: "Metrics dashboard illustration",
  },
  {
    background:
      "radial-gradient(102.19% 102.19% at 50% 46.56%, #1A3FA7 0%, #0A1535 100%)",
    title: "Become a Force Behind the Care!",
    subtitle:
      "Empower the health system from the inside by setting up your admin role on Cosmicforge.",
    image: "/signupImage/img3.png",
    alt: "User management illustration",
  },
];

export function SignupCarousel() {
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrent((prev) => (prev + 1) % slides.length);
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="hidden lg:flex flex-1 flex-col m-4 rounded-[32px] overflow-hidden relative">
      {/* Backgrounds */}
      {slides.map((slide, i) => (
        <div
          key={i}
          className="absolute inset-0 rounded-[32px] transition-opacity duration-700 ease-in-out"
          style={{
            background: slide.background,
            opacity: i === current ? 1 : 0,
          }}
        />
      ))}

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center h-full py-10 px-8">

        {/* Text — centered at top */}
        <div className="w-full text-center max-w-lg pt-4 shrink-0">
          {slides.map((slide, i) => (
            <div
              key={i}
              className="transition-all duration-700 ease-in-out"
              style={{
                opacity: i === current ? 1 : 0,
                transform: i === current ? "translateY(0)" : "translateY(12px)",
                position: i === current ? "relative" : "absolute",
                pointerEvents: i === current ? "auto" : "none",
              }}
            >
              <h2 className="text-[28px] font-sans font-bold text-white leading-tight">
                {slide.title}
              </h2>
              <p className="text-base font-poppins text-white/80 leading-relaxed mt-3">
                {slide.subtitle}
              </p>
            </div>
          ))}
        </div>

        {/* Image — fixed height container, image fills it clearly */}
        <div className="relative w-full grow my-6" style={{ minHeight: 0 }}>
          {slides.map((slide, i) => (
            <div
              key={i}
              className="absolute inset-0 transition-all duration-700 ease-in-out"
              style={{
                opacity: i === current ? 1 : 0,
                transform: i === current ? "translateX(0)" : "translateX(60px)",
              }}
            >
              <Image
                src={slide.image}
                alt={slide.alt}
                fill
                sizes="(max-width: 1280px) 55vw, 650px"
                className="object-contain"
                priority={i === 0}
              />
            </div>
          ))}
        </div>

        {/* Indicators — centered at bottom */}
        <div className="flex gap-2 shrink-0">
          {slides.map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrent(i)}
              className={`h-1.5 rounded-full transition-all duration-500 ${
                i === current ? "w-10 bg-white" : "w-1.5 bg-white/30"
              }`}
              aria-label={`Go to slide ${i + 1}`}
            />
          ))}
        </div>

      </div>
    </div>
  );
}