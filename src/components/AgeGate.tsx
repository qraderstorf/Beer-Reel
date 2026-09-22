import React, { useState } from "react";
import { ShieldCheck } from "lucide-react";
import Logo from "./Logo";

interface AgeGateProps {
  onVerified: () => void;
}

export default function AgeGate({ onVerified }: AgeGateProps) {
  const [showDenied, setShowDenied] = useState(false);

  if (showDenied) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center py-12 px-4 sm:px-6 lg:px-8 pt-safe text-center">
        <Logo size="lg" className="justify-center mb-6" />
        <div className="sm:mx-auto sm:w-full sm:max-w-md bg-white py-8 px-6 shadow-sm border border-slate-200 rounded-2xl">
          <h2 className="text-lg font-black text-slate-800 tracking-tight">You must be of legal drinking age</h2>
          <p className="mt-2 text-sm text-slate-500 font-medium leading-relaxed">
            BeerReel is a social app for tracking and sharing beer, and isn't available to anyone
            under the legal drinking age in their location.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center py-12 px-4 sm:px-6 lg:px-8 pt-safe text-center">
      <Logo size="lg" className="justify-center mb-3" />
      <p className="mt-1 text-sm text-slate-500 font-medium max-w-xs">
        Check in, rate pints, and see what your friends are drinking.
      </p>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-6 shadow-sm border border-slate-200 rounded-2xl sm:px-10">
          <div className="w-11 h-11 mx-auto rounded-full bg-amber-50 border border-amber-100 flex items-center justify-center mb-4">
            <ShieldCheck className="w-5 h-5 text-amber-600" />
          </div>
          <h2 className="text-base font-black text-slate-800 tracking-tight">Age Verification</h2>
          <p className="mt-2 text-xs text-slate-500 font-medium leading-relaxed">
            BeerReel involves content about alcohol. You must be 21 or older, or the legal
            drinking age in your location, to use this app.
          </p>

          <div className="mt-6 flex flex-col gap-2.5">
            <button
              type="button"
              onClick={onVerified}
              className="w-full bg-amber-500 hover:bg-amber-600 text-white text-sm font-bold py-2.5 px-4 rounded-xl transition-all cursor-pointer shadow-sm"
            >
              I'm 21 or older
            </button>
            <button
              type="button"
              onClick={() => setShowDenied(true)}
              className="w-full bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm font-bold py-2.5 px-4 rounded-xl transition-all cursor-pointer"
            >
              I'm under 21
            </button>
          </div>
        </div>

        <p className="mt-6 text-center text-[11px] text-slate-400 font-semibold">
          <a href="/privacy.html" target="_blank" rel="noopener noreferrer" className="hover:text-amber-600 hover:underline">
            Privacy Policy
          </a>
        </p>
      </div>
    </div>
  );
}
