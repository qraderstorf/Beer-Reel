import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Camera, Star, X, Check, Loader2, Award, Percent, MessageSquare, RefreshCw, Sparkles, Plus, History, MapPin, LocateFixed, ChevronDown } from "lucide-react";
import { BeerLog, UserProfile } from "../types";
import { PRELOADED_BEERS, PreloadedBeer, normalizeBeerName, searchBeers } from "../data/beerCatalog";
import { compressAndResizeImage } from "../utils";

interface QuickLogWorkflowProps {
  isOpen: boolean;
  onClose: () => void;
  logs: BeerLog[];
  currentUser: string;
  selectedPubId?: string;
  onLogAdded: (newLog: BeerLog) => void;
  onLogUpdated: (updatedLog: BeerLog) => void;
  editLog?: BeerLog | null; // If provided, opens straight to the enrichment/edit screen!
}

export default function QuickLogWorkflow({
  isOpen,
  onClose,
  logs,
  currentUser,
  selectedPubId,
  onLogAdded,
  onLogUpdated,
  editLog = null,
}: QuickLogWorkflowProps) {
  // Main states
  const [step, setStep] = useState<"capture" | "preview" | "enrich">("capture");
  const [capturedPhoto, setCapturedPhoto] = useState<string | null>(null);
  const [isProcessingPhoto, setIsProcessingPhoto] = useState(false);
  const [isSubmittingLog, setIsSubmittingLog] = useState(false);
  const [isSavingEnrichment, setIsSavingEnrichment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeLog, setActiveLog] = useState<BeerLog | null>(null);

  // Enrichment fields
  const [beerName, setBeerName] = useState("");
  const [beerStyle, setBeerStyle] = useState("");
  const [abv, setAbv] = useState<string>("");
  const [rating, setRating] = useState<number>(0);
  const [comment, setComment] = useState("");
  const [hadCig, setHadCig] = useState(false);
  const [location, setLocation] = useState("");
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [showMoreDetails, setShowMoreDetails] = useState(false);

  // Autocomplete state
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isAutofilled, setIsAutofilled] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<HTMLDivElement>(null);

  // Dynamic list of available beers from catalog + previous user logs
  const availableBeers = React.useMemo(() => {
    const map = new Map<string, PreloadedBeer>();
    PRELOADED_BEERS.forEach((beer) => {
      map.set(beer.name.toLowerCase().trim(), beer);
    });
    logs.forEach((log) => {
      if (log.beerName) {
        const key = log.beerName.toLowerCase().trim();
        if (!map.has(key)) {
          map.set(key, {
            name: log.beerName.trim(),
            style: log.beerStyle || "Lager",
            abv: (log.abv || 5.0).toString()
          });
        }
      }
    });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [logs]);

  // Extract user's previously logged beers (most recent first)
  const userPreviousBeers = React.useMemo(() => {
    if (!currentUser) return [];
    const map = new Map<string, PreloadedBeer>();

    const userLogs = [...logs]
      .filter((l) => l.user && l.user.toLowerCase() === currentUser.toLowerCase())
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    userLogs.forEach((log) => {
      if (log.beerName) {
        const trimmed = log.beerName.trim();
        const lower = trimmed.toLowerCase();
        if (
          lower !== "unnamed pint" &&
          lower !== "unnamed pint 🍺" &&
          lower !== "unspecified" &&
          !map.has(lower)
        ) {
          map.set(lower, {
            name: trimmed,
            style: log.beerStyle || "Lager",
            abv: log.abv ? log.abv.toString() : "5.0",
          });
        }
      }
    });

    return Array.from(map.values()).slice(0, 5);
  }, [logs, currentUser]);

  // Handle Edit vs New Log flow initialization
  useEffect(() => {
    if (isOpen) {
      if (editLog) {
        // Step 4: Edit Mode
        setActiveLog(editLog);
        setBeerName(editLog.beerName || "");
        setBeerStyle(editLog.beerStyle || "IPA");
        setAbv(editLog.abv > 0 ? editLog.abv.toString() : "");
        setRating(editLog.rating || 0);
        setComment(editLog.comment || "");
        setHadCig(!!editLog.hadCig);
        setLocation(editLog.location || "");
        setShowMoreDetails(!!(editLog.abv > 0 || editLog.hadCig));
        setStep("enrich");
      } else {
        // Step 1: Trigger camera automatically on open!
        resetFields();
        setStep("capture");
        setTimeout(() => {
          triggerCamera();
        }, 100);
      }
    }
  }, [isOpen, editLog]);

  const resetFields = () => {
    setCapturedPhoto(null);
    setActiveLog(null);
    setBeerName("");
    setBeerStyle("");
    setAbv("");
    setRating(0);
    setComment("");
    setHadCig(false);
    setLocation("");
    setLocationError(null);
    setShowMoreDetails(false);
    setError(null);
  };

  const triggerCamera = () => {
    setError(null);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const isImage = file.type.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif|heic|heif)$/i.test(file.name);
      if (!isImage) {
        setError("Please upload or take a valid image file.");
        return;
      }

      setIsProcessingPhoto(true);
      setError(null);
      try {
        const base64 = await compressAndResizeImage(file);
        setCapturedPhoto(base64);
        setStep("preview");
        // Kick off location capture the moment there's a photo, rather than
        // waiting for someone to tap "use my location" - gives it the most
        // possible lead time to resolve before Post is tapped, without ever
        // making Post itself wait on it.
        autoFillLocation();
      } catch (err) {
        console.error(err);
        setError("Failed to process photo. Please try again.");
        setStep("capture");
      } finally {
        setIsProcessingPhoto(false);
      }
    }
  };

  // Helper to ensure base64 image is uploaded to server/storage and converted to a short URL.
  // A hard timeout matters here specifically: without one, a flaky connection (a bar with
  // one bar of signal is the whole use case for this app) could leave this hanging
  // indefinitely with the UI stuck mid-post instead of falling back and letting the post
  // go through. On any failure/timeout it falls back to the raw base64, which the server's
  // own POST /api/beers still runs through the same hardened upload path with its own
  // retries - this isn't a silent dead end.
  const ensureShortImageUrl = async (imageStr?: string): Promise<string | undefined> => {
    if (!imageStr) return undefined;
    if (!imageStr.startsWith("data:image/")) return imageStr;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch("/api/upload-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imageStr }),
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.url) return data.url;
      }
    } catch (err) {
      console.error("[QuickLogWorkflow] Image upload error or timeout:", err);
    } finally {
      clearTimeout(timeoutId);
    }
    return imageStr;
  };

  // "Use my location" - free device geolocation, then a best-effort free reverse
  // lookup (proxied through the server) to turn it into a place name. Never blocks
  // posting: on denial/failure it just leaves the box empty for manual typing.
  const handleUseMyLocation = () => {
    setLocationError(null);
    if (!navigator.geolocation) {
      setLocationError("Location isn't available on this device.");
      return;
    }
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const res = await fetch(`/api/reverse-geocode?lat=${latitude}&lng=${longitude}`);
          const data = res.ok ? await res.json() : null;
          if (data?.name) {
            setLocation(data.name);
          } else {
            setLocationError("Couldn't figure out a place name - type it in instead.");
          }
        } catch (err) {
          console.error("[QuickLogWorkflow] Reverse geocode error:", err);
          setLocationError("Couldn't look up your location.");
        } finally {
          setIsLocating(false);
        }
      },
      () => {
        setIsLocating(false);
        setLocationError("Location permission denied - type it in instead.");
      },
      { timeout: 8000, maximumAge: 60000 }
    );
  };

  // Auto version of "use my location" - same lookup, but only runs if the box
  // is still empty, so it never clobbers something already resolved or typed
  // in by hand. Fired automatically as soon as there's something to post,
  // rather than waiting on an explicit tap.
  const autoFillLocation = () => {
    if (location.trim()) return;
    handleUseMyLocation();
  };

  // Step 2: Post the photo with no details yet - beer, location, rating and
  // caption all get filled in afterward on the enrich screen.
  const handlePost = async () => {
    if (!capturedPhoto) {
      setError("No photo available to post!");
      return;
    }

    setIsSubmittingLog(true);
    setError(null);

    // Upload base64 image first to obtain short URL
    const shortImageUrl = await ensureShortImageUrl(capturedPhoto);

    // Nothing's been picked yet at this point - the log goes up with safe
    // defaults, and every field below gets filled in on the enrich screen next.
    const normalized = normalizeBeerName(beerName);
    const cleanedName = normalized.name || beerName.trim() || "Unnamed Pint";
    const numericAbv = abv ? parseFloat(abv) : (normalized.abv || 0);
    const payload = {
      user: currentUser || "Anonymous",
      beerName: cleanedName,
      beerStyle: (beerStyle && beerStyle !== "Unspecified") ? beerStyle : (normalized.style || "Unspecified"),
      abv: isNaN(numericAbv) ? 0 : numericAbv,
      rating: rating,
      comment: "",
      imageUrl: shortImageUrl,
      hadCig: false,
      date: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      pubId: selectedPubId && selectedPubId !== "global" && selectedPubId !== "all" ? selectedPubId : undefined,
      location: location.trim() || undefined,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch("/api/beers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error("Could not post pint log.");
      }

      const createdLog: BeerLog = await response.json();
      onLogAdded(createdLog); // Triggers realtime sync & feed updates immediately!
      setActiveLog(createdLog);
      
      // Auto-suggest what they were drinking before if available
      if (userPreviousBeers.length > 0 && !beerName) {
        const lastBeer = userPreviousBeers[0];
        setBeerName(lastBeer.name);
        setBeerStyle(lastBeer.style);
        setAbv(lastBeer.abv);
        setIsAutofilled(true);
      }

      // Post succeeded - on to the enrich screen to fill in the details.
      setStep("enrich");
    } catch (err: any) {
      console.error(err);
      setError("Could not submit post. Please try again.");
    } finally {
      setIsSubmittingLog(false);
    }
  };

  // Step 3: Save Optional Enrichment Details or Direct Manual Log
  const handleSaveEnrichment = async () => {
    setIsSavingEnrichment(true);
    setError(null);

    const normalized = normalizeBeerName(beerName);
    const cleanedName = normalized.name || beerName.trim() || "Unnamed Pint";
    const numericAbv = abv ? parseFloat(abv) : (normalized.abv || 0);

    if (!activeLog) {
      // Direct Post without camera photo or instant post step
      const shortImageUrl = await ensureShortImageUrl(capturedPhoto);
      const payload = {
        user: currentUser || "Anonymous",
        beerName: cleanedName,
        beerStyle: (beerStyle && beerStyle !== "Unspecified") ? beerStyle : (normalized.style || "Lager"),
        abv: isNaN(numericAbv) ? 0 : numericAbv,
        rating: rating,
        comment: comment.trim(),
        imageUrl: shortImageUrl || undefined,
        hadCig: hadCig,
        date: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        pubId: selectedPubId && selectedPubId !== "global" && selectedPubId !== "all" ? selectedPubId : undefined,
        location: location.trim() || undefined,
      };

      try {
        const response = await fetch("/api/beers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error("Failed to post pint log.");
        }

        const createdLog: BeerLog = await response.json();
        onLogAdded(createdLog);
        onClose();
      } catch (err: any) {
        console.error(err);
        setError("Could not submit post. Please try again.");
      } finally {
        setIsSavingEnrichment(false);
      }
      return;
    }

    // Payload for updating details of an existing log
    const payload = {
      currentUser,
      beerName: cleanedName,
      beerStyle: (beerStyle && beerStyle !== "Unspecified") ? beerStyle : (normalized.style || "Lager"),
      abv: isNaN(numericAbv) ? 0 : numericAbv,
      rating: rating,
      comment: comment.trim(),
      hadCig: hadCig,
      location: location.trim() || undefined,
    };

    try {
      const response = await fetch(`/api/beers/${activeLog.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error("Failed to save beer details.");
      }

      const updatedLog: BeerLog = await response.json();
      onLogUpdated(updatedLog); // Updates locally & in state right away!
      onClose(); // Seamlessly dismisses modal
    } catch (err: any) {
      console.error(err);
      setError("Saved to feed, but could not update enrichment details.");
    } finally {
      setIsSavingEnrichment(false);
    }
  };

  // Close suggestions box on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (autocompleteRef.current && !autocompleteRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleBeerNameType = (val: string) => {
    setBeerName(val);
    setShowSuggestions(true);
    const normalized = normalizeBeerName(val);
    const matchedBeer = availableBeers.find(
      (b) => b.name.toLowerCase() === val.trim().toLowerCase() || b.name.toLowerCase() === normalized.name.toLowerCase()
    );
    if (matchedBeer) {
      setBeerStyle(matchedBeer.style);
      setAbv(matchedBeer.abv);
      setIsAutofilled(true);
    } else if (normalized.style && normalized.abv) {
      setBeerStyle(normalized.style);
      setAbv(normalized.abv.toString());
      setIsAutofilled(true);
    } else {
      setIsAutofilled(false);
    }
  };

  const selectSuggestion = (beer: PreloadedBeer) => {
    setBeerName(beer.name);
    setBeerStyle(beer.style);
    setAbv(beer.abv);
    setIsAutofilled(true);
    setShowSuggestions(false);
  };

  const filteredSuggestions = React.useMemo(() => {
    return searchBeers(availableBeers, beerName, 40);
  }, [beerName, availableBeers]);

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[110] overflow-y-auto bg-slate-900/60 backdrop-blur-md flex items-center justify-center p-4 pt-[calc(1rem+env(safe-area-inset-top,0px))] pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          className="relative bg-white dark:bg-slate-900 rounded-3xl max-w-md w-full overflow-hidden border border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col"
        >
          {/* Header */}
          <div className="p-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="p-2 rounded-xl bg-amber-500/10 text-amber-500">
                {step === "enrich" ? <Sparkles className="w-5 h-5" /> : <Camera className="w-5 h-5" />}
              </span>
              <div>
                <h2 className="font-extrabold text-slate-800 dark:text-white text-md">
                  {step === "capture" && "Camera"}
                  {step === "preview" && "Preview"}
                  {step === "enrich" && (editLog ? "Edit Pint Details" : "Enrich Your Pint")}
                </h2>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                  {step === "preview" && "Ready to share?"}
                  {step === "enrich" && (editLog ? "Update log details" : "Fully optional details")}
                  {step === "capture" && "Snap your pint"}
                </p>
              </div>
            </div>

            {/* Close Button / Cancel */}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 transition-all focus:outline-none"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body Content */}
          <div className="p-6 overflow-y-auto max-h-[75vh]">
            {error && (
              <div className="mb-4 bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 p-3.5 rounded-xl border border-red-200 dark:border-red-900/40 text-xs font-semibold">
                ⚠️ {error}
              </div>
            )}

            {/* Step 1: Capture State */}
            {step === "capture" && (
              <div className="flex flex-col items-center justify-center p-6 space-y-4">
                <div className="w-20 h-20 bg-amber-500/10 text-amber-500 rounded-full flex items-center justify-center animate-pulse">
                  <Camera className="w-10 h-10" />
                </div>
                <div className="text-center">
                  <h3 className="font-bold text-slate-700 dark:text-slate-300">Log a Fresh Pint</h3>
                  <p className="text-xs text-slate-400 mt-1 max-w-[260px] mx-auto">
                    Take a photo of your pint or log details manually without a photo.
                  </p>
                </div>
                
                {isProcessingPhoto ? (
                  <div className="flex flex-col items-center justify-center gap-2 mt-4">
                    <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
                    <span className="text-xs text-slate-400">Processing photo...</span>
                  </div>
                ) : (
                  <div className="flex flex-col w-full space-y-2 pt-2">
                    <button
                      onClick={triggerCamera}
                      className="w-full px-5 py-3 bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white text-xs font-bold rounded-xl shadow-md transition-all cursor-pointer flex items-center justify-center gap-2"
                    >
                      <Camera className="w-4 h-4" /> Snap / Select Photo
                    </button>
                    <button
                      onClick={() => {
                        if (userPreviousBeers.length > 0 && !beerName) {
                          const lastBeer = userPreviousBeers[0];
                          setBeerName(lastBeer.name);
                          setBeerStyle(lastBeer.style);
                          setAbv(lastBeer.abv);
                          setIsAutofilled(true);
                        }
                        setStep("enrich");
                        autoFillLocation();
                      }}
                      className="w-full px-5 py-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center justify-center gap-2 border border-slate-200 dark:border-slate-700"
                    >
                      <Plus className="w-4 h-4" /> Log Manually (No Photo)
                    </button>
                  </div>
                )}

                {/* Hidden File Input */}
                <input
                  type="file"
                  ref={fileInputRef}
                  accept="image/*"
                  capture="environment"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </div>
            )}

            {/* Step 2: Photo Preview - snap it and go, everything else gets added after */}
            {step === "preview" && capturedPhoto && (
              <div className="space-y-5">
                <div className="relative rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 max-h-80 w-full flex items-center justify-center shadow-md">
                  <img
                    src={capturedPhoto}
                    alt="Captured pint preview"
                    className="object-cover max-h-80 w-full"
                    referrerPolicy="no-referrer"
                  />

                  <button
                    onClick={triggerCamera}
                    className="absolute bottom-3 right-3 bg-slate-900/80 backdrop-blur-sm text-white p-2 rounded-xl text-xs font-bold hover:bg-slate-900 transition-all flex items-center gap-1 border border-white/10"
                    title="Retake photo"
                  >
                    <Camera className="w-4 h-4" /> Retake
                  </button>
                </div>

                <p className="text-center text-xs text-slate-400">
                  Post it now, add the beer, rating, and location after.
                </p>

                <button
                  onClick={handlePost}
                  disabled={isSubmittingLog}
                  className="w-full bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white font-extrabold py-3.5 px-4 rounded-xl shadow-lg shadow-amber-500/20 focus:outline-none disabled:opacity-50 transition-all flex items-center justify-center gap-2 cursor-pointer text-sm"
                >
                  {isSubmittingLog ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Posting...
                    </>
                  ) : (
                    "Post"
                  )}
                </button>
              </div>
            )}

            {/* Step 3: Optional Enrichment */}
            {step === "enrich" && (
              <div className="space-y-5">
                {!editLog && (
                  <div className="p-3 bg-emerald-50 dark:bg-emerald-950/15 border border-emerald-100 dark:border-emerald-900/40 rounded-xl flex items-center gap-2.5 text-emerald-800 dark:text-emerald-400 text-xs font-semibold">
                    <Check className="w-4 h-4 shrink-0 bg-emerald-500 text-white rounded-full p-0.5" />
                    <span>Pint logged live! You can skip this or add details below.</span>
                  </div>
                )}

                {/* 1. What are you drinking (Autocomplete Catalog) */}
                <div className="relative" ref={autocompleteRef}>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-400">
                      What are you drinking?
                    </label>
                    <span className="text-[10px] text-amber-600 dark:text-amber-400 font-bold">
                      {availableBeers.length} Catalog Beers Available
                    </span>
                  </div>

                  <input
                    type="text"
                    autoComplete="off"
                    placeholder="Search catalog: Guinness, Modelo, Heady Topper..."
                    value={beerName}
                    onChange={(e) => handleBeerNameType(e.target.value)}
                    onFocus={() => setShowSuggestions(true)}
                    className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/10 focus:border-amber-500 text-slate-800 dark:text-white font-medium"
                  />

                  {/* Autocomplete suggestions dropdown */}
                  {showSuggestions && filteredSuggestions.length > 0 && (
                    <div className="absolute left-0 right-0 mt-1.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl z-30 max-h-56 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-900">
                      <div className="p-2 bg-slate-50 dark:bg-slate-900 text-[10px] font-bold text-slate-400 uppercase tracking-wider sticky top-0 border-b border-slate-100 dark:border-slate-800">
                        {beerName.trim() ? "Catalog Search Results" : "Popular Catalog Beers"}
                      </div>
                      {filteredSuggestions.map((beer) => (
                        <button
                          key={beer.name}
                          type="button"
                          onClick={() => selectSuggestion(beer)}
                          className="w-full text-left px-4 py-2.5 hover:bg-amber-50 dark:hover:bg-amber-950/20 transition-colors flex items-center justify-between group cursor-pointer"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-base">🍺</span>
                            <span className="text-xs font-bold text-slate-800 dark:text-slate-200 group-hover:text-amber-500">
                              {beer.name}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400">
                            <span className="bg-slate-100 dark:bg-slate-800 group-hover:bg-amber-100 dark:group-hover:bg-amber-900/40 px-1.5 py-0.5 rounded font-medium">
                              {beer.style}
                            </span>
                            <span className="font-extrabold text-amber-600 dark:text-amber-400">
                              {beer.abv}% ABV
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Previously Drank / Your Recent Chips */}
                  {userPreviousBeers.length > 0 && (
                    <div className="mt-2.5 flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar text-xs">
                      <span className="text-[10px] text-amber-600 dark:text-amber-400 font-extrabold shrink-0 flex items-center gap-1">
                        <History className="w-3 h-3" /> Recent:
                      </span>
                      {userPreviousBeers.map((beer, idx) => (
                        <button
                          key={`prev-${beer.name}-${idx}`}
                          type="button"
                          onClick={() => selectSuggestion(beer)}
                          className={`shrink-0 px-2.5 py-1 text-[11px] font-extrabold rounded-md border transition-all flex items-center gap-1 cursor-pointer shadow-2xs ${
                            beerName.toLowerCase().trim() === beer.name.toLowerCase().trim()
                              ? "bg-amber-500 text-white border-amber-600 ring-2 ring-amber-400/30"
                              : "bg-amber-500/15 hover:bg-amber-500/25 text-amber-800 dark:text-amber-200 border-amber-500/30"
                          }`}
                          title={`Logged before: ${beer.name} (${beer.style}, ${beer.abv}%)`}
                        >
                          <span>🍺</span>
                          <span>{beer.name}</span>
                          <span className="text-[9px] opacity-80 font-bold">{beer.abv}%</span>
                          {idx === 0 && (
                            <span className="text-[8px] bg-amber-600/30 text-amber-900 dark:text-amber-100 px-1 rounded uppercase tracking-tighter ml-0.5">
                              Last
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Popular beers row removed - the dropdown above already shows "Popular
                      Catalog Beers" the moment you focus the input while it's empty, so a
                      second, always-visible popular-chips row was just repeating it. */}

                  {isAutofilled && (
                    <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold mt-1.5 flex items-center gap-1 animate-pulse">
                      ✨ Auto-suggested: {beerName} ({beerStyle}, {abv}% ABV)
                    </p>
                  )}
                </div>

                {/* 2. Rating Star scale */}
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                    How creamy is this pint?
                  </label>
                  <div className="flex flex-col items-center gap-2 p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl">
                    <div className="flex items-center gap-1.5">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <button
                          key={star}
                          type="button"
                          onClick={() => setRating(star)}
                          className="p-1 focus:outline-none transition-transform active:scale-90"
                        >
                          <Star
                            className={`w-7 h-7 transition-all ${
                              star <= rating
                                ? "fill-amber-400 text-amber-400 scale-110"
                                : "text-slate-300 dark:text-slate-700"
                            }`}
                          />
                        </button>
                      ))}
                    </div>
                    {rating > 0 && (
                      <span className="text-[11px] font-extrabold text-amber-500 uppercase tracking-wider">
                        {rating === 5 && "Bad day to be a Beer 🏆"}
                        {rating === 4 && "Thats a Creamy Pint! 👍"}
                        {rating === 3 && "Solid pint. 👌"}
                        {rating === 2 && "Flat and Warm but still a pint. 👎"}
                        {rating === 1 && "Filled with Regret 🤮"}
                      </span>
                    )}
                  </div>
                </div>

                {/* 3. Location */}
                <div className="space-y-1">
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                    Where are you?
                  </label>
                  <div className="flex items-center gap-2 px-3.5 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl">
                    <MapPin className="w-4 h-4 shrink-0 text-slate-400" />
                    <input
                      type="text"
                      autoComplete="off"
                      placeholder="Optional"
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      className="flex-1 min-w-0 bg-transparent border-0 text-sm text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleUseMyLocation}
                      disabled={isLocating}
                      title="Use my location"
                      className="shrink-0 p-1 rounded-full text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 transition-all cursor-pointer disabled:opacity-50"
                    >
                      {isLocating ? <Loader2 className="w-4 h-4 animate-spin" /> : <LocateFixed className="w-4 h-4" />}
                    </button>
                  </div>
                  {locationError && (
                    <p className="text-[10px] text-red-500 dark:text-red-400 px-1">{locationError}</p>
                  )}
                </div>

                {/* 4. Caption text field */}
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                    Caption / Vibe notes
                  </label>
                  <textarea
                    placeholder="Vibe notes, who are you with..."
                    rows={2}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/10 focus:border-amber-500 text-slate-800 dark:text-white placeholder-slate-400"
                  />
                </div>

                {/* 4/5. ABV + Dart Combo - the two fields people touch least often, tucked
                    behind a closed-by-default disclosure instead of always taking up
                    space. Opens automatically if editing a log that already has one set. */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowMoreDetails((v) => !v)}
                    className="w-full flex items-center justify-between px-1 py-1 text-xs font-bold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors cursor-pointer"
                  >
                    <span>More details {(abv || hadCig) && !showMoreDetails ? "(ABV, Dart Combo set)" : "(ABV, Dart Combo)"}</span>
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showMoreDetails ? "rotate-180" : ""}`} />
                  </button>

                  {showMoreDetails && (
                    <div className="mt-3 space-y-3">
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center justify-between">
                          <span>ABV (%)</span>
                          <span className="text-[9px] text-slate-400 normal-case font-medium">Optional, enter if known</span>
                        </label>
                        <div className="relative">
                          <Percent className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                          <input
                            type="number"
                            step="0.1"
                            placeholder="e.g. 4.2"
                            value={abv}
                            onChange={(e) => setAbv(e.target.value)}
                            className="w-full pl-9 pr-4 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/10 focus:border-amber-500 text-slate-800 dark:text-white"
                          />
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => setHadCig(!hadCig)}
                        className={`w-full flex items-center justify-between gap-2 px-4 py-3 rounded-xl border text-sm font-bold transition-all cursor-pointer ${
                          hadCig
                            ? "bg-amber-500/10 border-amber-500 text-amber-600 dark:text-amber-400"
                            : "bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-400"
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span className="text-lg">🎯</span>
                          Dart Combo Activated
                        </span>
                        {hadCig && <Check className="w-4 h-4" />}
                      </button>
                    </div>
                  )}
                </div>

                {/* Action buttons (Skip vs Save) */}
                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center gap-3">
                  {/* Skip Option */}
                  {!editLog && (
                    <button
                      type="button"
                      onClick={onClose}
                      className="flex-1 px-4 py-3 bg-slate-50 hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-350 font-bold rounded-xl text-xs transition-colors cursor-pointer text-center"
                    >
                      Skip / Skip Details
                    </button>
                  )}

                  <button
                    onClick={handleSaveEnrichment}
                    disabled={isSavingEnrichment}
                    className="flex-1 px-4 py-3 bg-emerald-500 hover:bg-emerald-600 text-white font-bold rounded-xl text-xs shadow-md shadow-emerald-500/10 transition-all cursor-pointer flex items-center justify-center gap-1.5"
                  >
                    {isSavingEnrichment ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Check className="w-4 h-4" />
                    )}
                    {editLog ? "Save Changes" : "Save Details"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
