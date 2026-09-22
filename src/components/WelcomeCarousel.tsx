import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Users, Camera, Siren, Landmark, ChevronRight } from "lucide-react";
import Logo from "./Logo";

interface WelcomeCarouselProps {
  onDone: () => void;
}

interface Slide {
  icon: React.ReactNode;
  iconBg: string;
  image?: string;
  title: string;
  body: string;
}

const SLIDES: Slide[] = [
  {
    icon: <Users className="w-6 h-6 text-amber-600" />,
    iconBg: "bg-amber-50 border-amber-100",
    title: "Welcome to BeerReel 🍻",
    body: "BeerReel is built around community - your mates, your pints, your online local pub. Beer, cider, tea, or water in hand, log every pour, cheers your crew, and stay connected with your community, near and far.",
  },
  {
    icon: <Camera className="w-6 h-6 text-sky-600" />,
    iconBg: "bg-sky-50 border-sky-100",
    image: "/onboarding/log-pint.png",
    title: "Log Every Pint",
    body: "Snap a photo, rate it, and share what's in your glass. Every check-in lands in the Live Feed, giving your mates a tasty pint of FOMO - especially when the crew's all together and they're not.",
  },
  {
    icon: <Siren className="w-6 h-6 text-rose-600" />,
    iconBg: "bg-rose-50 border-rose-100",
    image: "/onboarding/react-rally.png",
    title: "React & Rally",
    body: "React with dozens of custom emojis, blast FOMO Alert on the pints worth chasing, and slap Imposter Pint on the ones that definitely aren't pints.",
  },
  {
    icon: <Landmark className="w-6 h-6 text-emerald-600" />,
    iconBg: "bg-emerald-50 border-emerald-100",
    image: "/onboarding/pub-hub.png",
    title: "Light the Beacons 🔥",
    body: "Open your own pub for your crew, make it yours with custom stats and vibes, and light the beacons when it's time to rally everyone to the bar.",
  },
];

export default function WelcomeCarousel({ onDone }: WelcomeCarouselProps) {
  const [index, setIndex] = useState(0);
  const isLast = index === SLIDES.length - 1;
  const slide = SLIDES[index];

  const goNext = () => {
    if (isLast) {
      onDone();
    } else {
      setIndex((i) => i + 1);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center py-12 px-4 sm:px-6 lg:px-8 pt-safe text-center">
      <Logo size="lg" className="justify-center mb-3" />

      <div className="mt-6 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-6 shadow-sm border border-slate-200 rounded-2xl sm:px-10 overflow-hidden">
          {/* Progress dots */}
          <div className="flex items-center justify-center gap-1.5 mb-6">
            {SLIDES.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Go to slide ${i + 1}`}
                className={`h-1.5 rounded-full transition-all cursor-pointer ${
                  i === index ? "w-6 bg-amber-500" : "w-1.5 bg-slate-200 hover:bg-slate-300"
                }`}
              />
            ))}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={index}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.2 }}
            >
              {slide.image ? (
                <div className="bg-slate-100 rounded-2xl p-2 shadow-inner border border-slate-200 mb-4">
                  <img
                    src={slide.image}
                    alt={slide.title}
                    className="mx-auto max-h-[220px] w-auto rounded-xl shadow-md object-contain"
                  />
                </div>
              ) : (
                <div className={`w-14 h-14 mx-auto rounded-2xl border flex items-center justify-center mb-4 ${slide.iconBg}`}>
                  {slide.icon}
                </div>
              )}
              <h2 className="text-base font-black text-slate-800 tracking-tight">{slide.title}</h2>
              <p className="mt-2 text-xs text-slate-500 font-medium leading-relaxed min-h-[70px]">
                {slide.body}
              </p>
            </motion.div>
          </AnimatePresence>

          <div className="mt-6 flex items-center gap-2.5">
            {!isLast && (
              <button
                type="button"
                onClick={onDone}
                className="text-xs font-bold text-slate-400 hover:text-slate-600 transition-colors cursor-pointer px-3 py-2.5"
              >
                Skip
              </button>
            )}
            <button
              type="button"
              onClick={goNext}
              className="flex-1 bg-amber-500 hover:bg-amber-600 text-white text-sm font-bold py-2.5 px-4 rounded-xl transition-all cursor-pointer shadow-sm flex items-center justify-center gap-1"
            >
              {isLast ? "Let's Go 🍻" : "Next"}
              {!isLast && <ChevronRight className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
