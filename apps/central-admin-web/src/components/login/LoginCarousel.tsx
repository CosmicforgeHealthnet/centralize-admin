"use client";

import React, { useState, useEffect } from "react";
import Image from "next/image";

const slides = [
  {
    background:
      "radial-gradient(102.19% 102.19% at 50% 46.56%, #2787A7 0%, #0F3E41 100%)",
    title: "Manage all Departments in one System",
    subtitle:
      "Set up your access to manage platform operations, users, and staff workflows.",
    image: "/loginImage/img1.png",
    alt: "Department management illustration",
  },
  {
    background:
      "radial-gradient(102.19% 102.19% at 50% 46.56%, #157947 0%, #0C3706 100%)",
    title: "View All Data and Metrics in one view",
    subtitle: "Gain access to masterview across all boards.",
    image: "/loginImage/img2.png",
    alt: "Data and metrics dashboard illustration",
  },
  {
    background:
      "radial-gradient(102.19% 102.19% at 50% 46.56%, #DEBD70 0%, #2D1D03 100%)",
    title: "Your Customer Service System",
    subtitle: "Your Customer service in one place.",
    image: "/loginImage/img3.png",
    alt: "Customer service illustration",
  },
];

export function LoginCarousel() {
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrent((prev) => (prev + 1) % slides.length);
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="hidden lg:flex flex-1 flex-col m-4 rounded-[32px] overflow-hidden relative">
      {/* Stacked gradient backgrounds — each fades in/out */}
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

      {/* Content — sits above the backgrounds */}
      <div className="relative z-10 flex flex-col justify-between h-full p-10">
        {/* Text Content — crossfades */}
        <div className="w-full max-w-lg mt-4 space-y-4">
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
              <p className="text-base font-poppins text-white/80 leading-relaxed mt-2">
                {slide.subtitle}
              </p>
            </div>
          ))}

          {/* Indicators */}
          <div className="flex gap-2 pt-4 mt-4">
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

        {/* Image — slides in from right */}
        <div className="relative w-full flex justify-center mt-6">
          {slides.map((slide, i) => (
            <div
              key={i}
              className="absolute bottom-0 w-full aspect-square max-w-[420px] transition-all duration-700 ease-in-out"
              style={{
                opacity: i === current ? 1 : 0,
                transform: i === current ? "translateX(0)" : "translateX(60px)",
              }}
            >
              <Image
                src={slide.image}
                alt={slide.alt}
                fill
                className="object-contain"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
