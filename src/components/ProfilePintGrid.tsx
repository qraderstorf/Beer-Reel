import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { Star, MapPin, X, Loader2 } from "lucide-react";
import { BeerLog } from "../types";
import { isImposterLog, useRetryImage } from "../utils";

const PAGE_SIZE = 12;

// A single grid tile needs its own useRetryImage instance (same reason PubEmblem/
// PostPhoto are their own components elsewhere) - a hook can't safely be called once
// per item inside a .map(). Posts without a photo (early quick-posts, or ones where
// upload failed) fall back to a plain beer-name tile instead of a broken image.
function PintThumbnail({ log, onClick }: { log: BeerLog; onClick: () => void }) {
  const { src, failed, onError, retryKey } = useRetryImage(log.imageUrl);
  const showPhoto = log.imageUrl && src && !failed;

  return (
    <button
      type="button"
      onClick={onClick}
      className="relative aspect-square rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-800 cursor-pointer group"
    >
      {showPhoto ? (
        <img
          key={retryKey}
          src={src}
          alt={log.beerName}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={onError}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-gradient-to-br from-amber-100 to-amber-50 dark:from-amber-950/40 dark:to-slate-900 p-1.5 text-center">
          <span className="text-lg">🍺</span>
          <span className="text-[8px] font-bold text-amber-800 dark:text-amber-300 leading-tight line-clamp-2">
            {log.beerName}
          </span>
        </div>
      )}
      {log.rating > 0 && (
        <div className="absolute bottom-1 right-1 bg-slate-950/70 text-white text-[9px] font-black px-1 py-0.5 rounded-md flex items-center gap-0.5">
          <Star className="w-2.5 h-2.5 fill-amber-400 text-amber-400" />
          {log.rating}
        </div>
      )}
    </button>
  );
}

// Read-only detail lightbox for a single tapped tile - deliberately not a full feed
// card (no reactions/comments here); that interactivity already exists wherever this
// same post shows up in the normal feed, so it isn't duplicated into this view.
function PintDetailModal({ log, onClose }: { log: BeerLog; onClose: () => void }) {
  const { src, failed, onError, retryKey } = useRetryImage(log.imageUrl);
  const showPhoto = log.imageUrl && src && !failed;

  return createPortal(
    <div
      className="fixed inset-0 bg-slate-950/90 backdrop-blur-sm z-[120] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl max-w-sm w-full overflow-hidden max-h-[85dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <h3 className="font-extrabold text-sm text-slate-800 dark:text-slate-100 truncate pr-2">
            {log.beerName}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto custom-scrollbar">
          {showPhoto && (
            <img
              key={retryKey}
              src={src}
              alt={log.beerName}
              referrerPolicy="no-referrer"
              onError={onError}
              className="w-full max-h-80 object-cover"
            />
          )}
          <div className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-bold text-slate-500 dark:text-slate-400">{log.beerStyle}</span>
              {log.rating > 0 && (
                <span className="flex items-center gap-0.5 font-bold text-amber-500">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className={`w-3.5 h-3.5 ${i < log.rating ? "fill-amber-400 text-amber-400" : "text-slate-300 dark:text-slate-700"}`} />
                  ))}
                </span>
              )}
            </div>
            {log.abv > 0 && (
              <p className="text-[11px] text-slate-400 font-semibold">{log.abv}% ABV</p>
            )}
            {log.location && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400 font-semibold flex items-center gap-1">
                <MapPin className="w-3 h-3 shrink-0" /> {log.location}
              </p>
            )}
            {log.comment && (
              <p className="text-xs text-slate-600 dark:text-slate-300 italic bg-slate-50 dark:bg-slate-950 rounded-lg p-2.5 border border-slate-100 dark:border-slate-800">
                "{log.comment}"
              </p>
            )}
            <p className="text-[10px] text-slate-400 pt-1">
              {new Date(log.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function ProfilePintGrid({ username }: { username: string }) {
  const [logs, setLogs] = useState<BeerLog[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedLog, setSelectedLog] = useState<BeerLog | null>(null);

  // Own paginated fetch, deliberately not sharing App.tsx's Feed-tab filter state -
  // opening a profile shouldn't be able to silently hijack whatever someone else was
  // browsing (a search, a pub filter) in the main feed.
  useEffect(() => {
    let isCancelled = false;
    setLogs([]);
    setOffset(0);
    setHasMore(true);
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch(`/api/beers?user=${encodeURIComponent(username)}&limit=${PAGE_SIZE}&offset=0`);
        if (!res.ok) throw new Error("Failed to load pints");
        const data = await res.json();
        if (isCancelled) return;
        const fetched: BeerLog[] = (data.beers || []).filter((l: BeerLog) => !isImposterLog(l));
        setLogs(fetched);
        setOffset((data.beers || []).length);
        setHasMore(!!data.hasMore);
      } catch (err) {
        console.error("[ProfilePintGrid] Failed to load pints:", err);
        if (!isCancelled) setError("Couldn't load pints right now.");
      } finally {
        if (!isCancelled) setLoading(false);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [username]);

  const handleLoadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/beers?user=${encodeURIComponent(username)}&limit=${PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) throw new Error("Failed to load more pints");
      const data = await res.json();
      const fetched: BeerLog[] = (data.beers || []).filter((l: BeerLog) => !isImposterLog(l));
      setLogs((prev) => [...prev, ...fetched]);
      setOffset((prev) => prev + (data.beers || []).length);
      setHasMore(!!data.hasMore);
    } catch (err) {
      console.error("[ProfilePintGrid] Failed to load more pints:", err);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <span className="block text-xs font-bold uppercase tracking-wider text-slate-400">
        Pints Logged
      </span>

      {loading ? (
        <div className="grid grid-cols-3 gap-1.5">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="aspect-square rounded-lg bg-slate-100 dark:bg-slate-800 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="text-xs text-red-500 font-semibold p-3 bg-red-50 dark:bg-red-950/20 rounded-lg">
          ⚠️ {error}
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center text-xs text-slate-400 font-medium p-4 bg-slate-50 dark:bg-slate-950 rounded-xl">
          No pints logged yet.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            {logs.map((log) => (
              <div key={log.id} className="contents">
                <PintThumbnail log={log} onClick={() => setSelectedLog(log)} />
              </div>
            ))}
          </div>
          {hasMore && (
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="w-full py-2 text-xs font-bold text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/20 rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {loadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {loadingMore ? "Loading..." : "Load More"}
            </button>
          )}
        </>
      )}

      {selectedLog && (
        <PintDetailModal log={selectedLog} onClose={() => setSelectedLog(null)} />
      )}
    </div>
  );
}
