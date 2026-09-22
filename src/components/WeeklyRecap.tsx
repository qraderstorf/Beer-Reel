import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, Loader2, Flame, Users, Award, MapPin } from "lucide-react";

interface RecapData {
  windowDays: number;
  postsThisWeek: number;
  topBeer: { name: string; count: number } | null;
  topPub: { name: string; count: number } | null;
  avgRating: string | null;
  highestRated: { beerName: string; rating: number; imageUrl?: string; date: string } | null;
  cheersReceived: number;
  firstPourCount: number;
  newStyleCount: number;
  goblinModeCount: number;
  dartComboCount: number;
  totalBadges: number;
  currentDryStreak: number;
  longestDryStreak: number;
  archetype: { emoji: string; title: string; tagline: string };
}

interface WeeklyRecapProps {
  username: string;
  isOwnRecap: boolean;
  onClose: () => void;
}

export default function WeeklyRecap({ username, isOwnRecap, onClose }: WeeklyRecapProps) {
  const [data, setData] = useState<RecapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/users/${encodeURIComponent(username)}/weekly-recap`)
      .then((res) => {
        if (!res.ok) throw new Error("Could not load weekly recap.");
        return res.json();
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Could not load weekly recap.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          onClick={(e) => e.stopPropagation()}
          className="relative bg-white dark:bg-slate-900 rounded-3xl max-w-sm w-full overflow-hidden border border-slate-200 dark:border-slate-800 shadow-2xl max-h-[88vh] flex flex-col"
        >
          <button
            onClick={onClose}
            className="absolute top-3 right-3 z-10 p-1.5 bg-black/20 hover:bg-black/30 text-white rounded-full transition-all cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>

          {loading ? (
            <div className="py-20 flex flex-col items-center gap-2.5 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin" />
              <span className="text-xs font-bold">Reading the week...</span>
            </div>
          ) : error || !data ? (
            <div className="py-20 px-6 text-center">
              <p className="text-sm font-bold text-red-500">{error || "Something went wrong."}</p>
            </div>
          ) : (
            <div className="overflow-y-auto">
              {/* Archetype hero */}
              <div className="bg-gradient-to-br from-amber-400 via-orange-400 to-orange-500 px-6 pt-10 pb-6 text-center">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-950/60 mb-1">
                  {isOwnRecap ? "Your Week" : `${username}'s Week`}
                </p>
                <div className="text-5xl mb-2">{data.archetype.emoji}</div>
                <h2 className="text-xl font-black text-slate-950 leading-tight">{data.archetype.title}</h2>
                <p className="text-xs font-semibold text-slate-950/70 mt-1.5 px-2">
                  {data.archetype.tagline}
                </p>
              </div>

              <div className="p-5 space-y-4">
                {/* Highlight: top beer + highest rated */}
                <div className="grid grid-cols-1 gap-2.5">
                  {data.topBeer && (
                    <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl p-3.5 flex items-center gap-3">
                      <span className="text-2xl shrink-0">🍺</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">
                          Top Beer This Week
                        </p>
                        <p className="text-sm font-extrabold text-slate-800 dark:text-slate-100 truncate">
                          {data.topBeer.name}
                          {data.topBeer.count > 1 && (
                            <span className="text-amber-500 font-black ml-1">×{data.topBeer.count}</span>
                          )}
                        </p>
                      </div>
                    </div>
                  )}

                  {data.highestRated && (
                    <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl p-3.5 flex items-center gap-3">
                      {data.highestRated.imageUrl ? (
                        <img
                          src={data.highestRated.imageUrl}
                          alt={data.highestRated.beerName}
                          className="w-11 h-11 rounded-xl object-cover shrink-0 border border-slate-200 dark:border-slate-800"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <span className="text-2xl shrink-0">⭐</span>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">
                          Highest Rated Pint
                        </p>
                        <p className="text-sm font-extrabold text-slate-800 dark:text-slate-100 truncate">
                          {data.highestRated.beerName}{" "}
                          <span className="text-amber-500">{"⭐".repeat(data.highestRated.rating)}</span>
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Stat grid */}
                <div className="grid grid-cols-3 gap-2">
                  <RecapStat
                    icon={<Flame className="w-3.5 h-3.5" />}
                    label="Days Dry"
                    value={`${data.currentDryStreak}d`}
                    colorClass="bg-sky-50 dark:bg-sky-950/30 border-sky-100 dark:border-sky-900/40 text-sky-700 dark:text-sky-300"
                  />
                  <RecapStat
                    icon={<span className="text-sm">🍻</span>}
                    label="Posts"
                    value={data.postsThisWeek}
                    colorClass="bg-amber-50 dark:bg-amber-950/30 border-amber-100 dark:border-amber-900/40 text-amber-700 dark:text-amber-300"
                  />
                  <RecapStat
                    icon={<Award className="w-3.5 h-3.5" />}
                    label="Badges"
                    value={data.totalBadges}
                    colorClass="bg-violet-50 dark:bg-violet-950/30 border-violet-100 dark:border-violet-900/40 text-violet-700 dark:text-violet-300"
                  />
                  <RecapStat
                    icon={<Users className="w-3.5 h-3.5" />}
                    label="Cheers"
                    value={data.cheersReceived}
                    colorClass="bg-rose-50 dark:bg-rose-950/30 border-rose-100 dark:border-rose-900/40 text-rose-700 dark:text-rose-300"
                  />
                  <RecapStat
                    icon={<span className="text-sm">⭐</span>}
                    label="Avg Rating"
                    value={data.avgRating || "—"}
                    colorClass="bg-emerald-50 dark:bg-emerald-950/30 border-emerald-100 dark:border-emerald-900/40 text-emerald-700 dark:text-emerald-300"
                  />
                  <RecapStat
                    icon={<MapPin className="w-3.5 h-3.5" />}
                    label="Top Pub"
                    value={data.topPub ? data.topPub.name : "—"}
                    colorClass="bg-teal-50 dark:bg-teal-950/30 border-teal-100 dark:border-teal-900/40 text-teal-700 dark:text-teal-300"
                    small
                  />
                </div>

                <p className="text-center text-[10px] text-slate-400 font-semibold pt-1">
                  Last 7 days · Longest dry streak on record: {data.longestDryStreak}d 🏛️
                </p>
              </div>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function RecapStat({
  icon,
  label,
  value,
  colorClass,
  small,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  colorClass: string;
  small?: boolean;
}) {
  return (
    <div className={`rounded-xl p-2.5 border text-center ${colorClass}`}>
      <div className="flex items-center justify-center gap-1 mb-0.5">{icon}</div>
      <p className={`font-black leading-tight truncate ${small ? "text-[11px]" : "text-sm"}`}>{value}</p>
      <p className="text-[8px] font-bold uppercase tracking-wider opacity-70">{label}</p>
    </div>
  );
}
