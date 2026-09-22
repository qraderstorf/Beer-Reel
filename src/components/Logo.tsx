import React from "react";

interface LogoProps {
  size?: "sm" | "md" | "lg";
  showText?: boolean;
  className?: string;
  onClick?: () => void;
}

export default function Logo({ size = "md", showText = true, className = "", onClick }: LogoProps) {
  const iconSizes = {
    sm: "w-8 h-7",
    md: "w-10 h-8 sm:w-11 sm:h-9",
    lg: "w-13 h-10 sm:w-14 sm:h-11",
  };

  const textSizes = {
    sm: "text-sm sm:text-base",
    md: "text-lg sm:text-xl",
    lg: "text-2xl sm:text-3xl",
  };

  return (
    <div 
      className={`flex items-center gap-2 select-none ${onClick ? "cursor-pointer group" : ""} ${className}`}
      onClick={onClick}
    >
      {/* Clinking Beer Mugs Toasting Vector Logo */}
      <div className={`relative ${iconSizes[size]} flex items-center justify-center group-hover:scale-105 transition-transform duration-200 shrink-0`}>
        <svg viewBox="0 0 64 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full filter drop-shadow-sm">
          {/* Toast Clink Impact Sparkles / Liquid Splash */}
          <g>
            <path d="M32 5L33.2 9.2L37 10.5L33.2 11.8L32 16L30.8 11.8L27 10.5L30.8 9.2L32 5Z" fill="#F59E0B" />
            <circle cx="32" cy="20" r="1.5" fill="#FBBF24" />
            <circle cx="28.5" cy="7.5" r="1" fill="#F59E0B" />
            <circle cx="35.5" cy="7.5" r="1" fill="#FBBF24" />
          </g>

          {/* LEFT BEER MUG (Tilted Right & Shifted Closer) */}
          <g transform="translate(6, 0)">
            <g transform="translate(14, 25) rotate(13) translate(-14, -25)">
              {/* Mug Handle */}
              <path d="M7 21C4.5 21 3 23 3 26.5C3 30 4.5 32 7 32" stroke="#D97706" strokeWidth="2.5" strokeLinecap="round" fill="none" />
              <path d="M7 22.5C5.5 22.5 4.5 24 4.5 26.5C4.5 29 5.5 30.5 7 30.5" stroke="#FBBF24" strokeWidth="1" strokeLinecap="round" fill="none" />

              {/* Mug Glass Body */}
              <rect x="7" y="18" width="14" height="18" rx="2" fill="url(#mug-left-grad)" stroke="#B45309" strokeWidth="1.2" />
              
              {/* Glass Ribs / Vertical Texture */}
              <path d="M11 21V33" stroke="#FEF08A" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
              <path d="M15 21V33" stroke="#FEF08A" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
              <path d="M19 21V33" stroke="#D97706" strokeWidth="1" strokeLinecap="round" opacity="0.4" />

              {/* Fluffy Overflowing Foam Head */}
              <path d="M5.5 18C5.5 15.5 7.5 14 9.5 14C10.5 14 11.2 14.5 11.8 15C12.5 14.2 13.8 13.5 15 13.5C16.5 13.5 17.8 14.5 18.2 15.2C18.8 14.8 19.8 14.5 20.5 14.5C22 14.5 23 16 23 18C23 18.8 22.5 19.5 22 20H6.5C6 19.5 5.5 18.8 5.5 18Z" fill="#FFFFFF" stroke="#E2E8F0" strokeWidth="1" />
              {/* Foam Drip */}
              <path d="M21 19.5C21.5 21 21 22.5 20 23" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" />
            </g>
          </g>

          {/* RIGHT BEER MUG (Tilted Left & Shifted Closer) */}
          <g transform="translate(-6, 0)">
            <g transform="translate(50, 25) rotate(-13) translate(-50, -25)">
              {/* Mug Handle */}
              <path d="M57 21C59.5 21 61 23 61 26.5C61 30 59.5 32 57 32" stroke="#D97706" strokeWidth="2.5" strokeLinecap="round" fill="none" />
              <path d="M57 22.5C58.5 22.5 59.5 24 59.5 26.5C59.5 29 58.5 30.5 57 30.5" stroke="#FBBF24" strokeWidth="1" strokeLinecap="round" fill="none" />

              {/* Mug Glass Body */}
              <rect x="43" y="18" width="14" height="18" rx="2" fill="url(#mug-right-grad)" stroke="#B45309" strokeWidth="1.2" />
              
              {/* Glass Ribs / Vertical Texture */}
              <path d="M47 21V33" stroke="#D97706" strokeWidth="1" strokeLinecap="round" opacity="0.4" />
              <path d="M51 21V33" stroke="#FEF08A" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
              <path d="M55 21V33" stroke="#FEF08A" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />

              {/* Fluffy Overflowing Foam Head */}
              <path d="M41 18C41 16 42 14.5 43.5 14.5C44.2 14.5 45.2 14.8 45.8 15.2C46.2 14.5 47.5 13.5 49 13.5C50.2 13.5 51.5 14.2 52.2 15C52.8 14.5 53.5 14 54.5 14C56.5 14 58.5 15.5 58.5 18C58.5 18.8 58 19.5 57.5 20H42C41.5 19.5 41 18.8 41 18Z" fill="#FFFFFF" stroke="#E2E8F0" strokeWidth="1" />
              {/* Foam Drip */}
              <path d="M43 19.5C42.5 21 43 22.5 44 23" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" />
            </g>
          </g>

          <defs>
            <linearGradient id="mug-left-grad" x1="7" y1="18" x2="21" y2="36" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FCD34D" />
              <stop offset="0.5" stopColor="#F59E0B" />
              <stop offset="1" stopColor="#D97706" />
            </linearGradient>
            <linearGradient id="mug-right-grad" x1="57" y1="18" x2="43" y2="36" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FCD34D" />
              <stop offset="0.5" stopColor="#F59E0B" />
              <stop offset="1" stopColor="#D97706" />
            </linearGradient>
          </defs>
        </svg>
      </div>

      {showText && (
        <span className={`${textSizes[size]} font-black tracking-tight text-slate-900 dark:text-white leading-none flex items-center gap-0.5 whitespace-nowrap`}>
          Beer<span className="text-amber-500">Reel</span>
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse ml-0.5" />
        </span>
      )}
    </div>
  );
}
