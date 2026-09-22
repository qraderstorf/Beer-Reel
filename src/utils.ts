import { useState, useRef, useEffect } from "react";
import { BeerLog } from "./types";

// A remotely-hosted image (post photo, profile photo, pub emblem) failing to load is
// far more often a transient hiccup - a cold serverless instance, a brief network
// blip - than a genuinely missing file. Retrying a few times with backoff before
// giving up avoids a one-off failure turning into a permanently "broken" image for
// the rest of the viewer's session. `url` changing (e.g. switching profiles) resets
// the retry state and gives the new URL a fresh start.
const IMAGE_RETRY_MAX = 3;
const IMAGE_RETRY_BASE_MS = 1200;

export function useRetryImage(url: string | undefined | null) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setAttempt(0);
    setFailed(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, [url]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const onError = () => {
    setAttempt((prev) => {
      const next = prev + 1;
      if (next > IMAGE_RETRY_MAX) {
        setFailed(true);
        return prev;
      }
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setAttempt(next), next * IMAGE_RETRY_BASE_MS);
      return prev;
    });
  };

  const src = !url ? undefined : attempt > 0 ? `${url}${url.includes("?") ? "&" : "?"}_retry=${attempt}` : url;
  return { src, failed, onError, retryKey: attempt };
}

export interface UserStatsResult {
  totalPints: number;
  avgRating: string;
  favoriteStyle: string;
  totalCheers: number;
  topBeer: string;
}

export function isImposterLog(log: BeerLog): boolean {
  if (!log || !log.reactions) return false;
  const dislikes = log.reactions["dislike"] || log.reactions["imposter"];
  return Array.isArray(dislikes) && dislikes.length >= 3;
}

// normalizeBeerName()'s two "didn't really say" fallbacks: "House Draft" for a blank
// name, "House Lager" for junk/generic input ("beer", "bad", "unnamed pint", trolling).
// Neither is a real preference, so they shouldn't win "favorite beer"/"most-logged
// beer" stats just for being the most common non-answer. Other "House ___" names
// (House Hazy IPA, House Wine, ...) DO carry real signal - a style or brand match -
// and stay counted.
const UNSPECIFIED_BEER_NAMES = new Set(["house draft", "house lager"]);
export function isUnspecifiedBeerName(name: string | undefined): boolean {
  return UNSPECIFIED_BEER_NAMES.has((name || "").trim().toLowerCase());
}

export function calculateUserStats(logs: BeerLog[], username?: string): UserStatsResult {
  const validLogs = logs.filter((l) => !isImposterLog(l));
  const userLogs = username
    ? validLogs.filter((l) => l.user.toLowerCase() === username.toLowerCase())
    : validLogs;

  const totalPints = userLogs.length;

  const ratedLogs = userLogs.filter((l) => l.rating > 0);
  const avgRating =
    ratedLogs.length > 0
      ? (ratedLogs.reduce((acc, l) => acc + l.rating, 0) / ratedLogs.length).toFixed(1)
      : "0.0";

  const styleCounts: Record<string, number> = {};
  userLogs.forEach((l) => {
    const s = l.beerStyle || "Unknown";
    styleCounts[s] = (styleCounts[s] || 0) + 1;
  });
  let favoriteStyle = "None yet";
  let maxStyleCount = 0;
  Object.entries(styleCounts).forEach(([style, count]) => {
    if (count > maxStyleCount) {
      favoriteStyle = style;
      maxStyleCount = count;
    }
  });

  const totalCheers = userLogs.reduce((acc, l) => acc + (l.cheers?.length || 0), 0);

  const beerCounts: Record<string, number> = {};
  userLogs.forEach((l) => {
    const name = l.beerName.trim();
    if (name && !isUnspecifiedBeerName(name)) {
      beerCounts[name] = (beerCounts[name] || 0) + 1;
    }
  });
  let topBeerName = "";
  let maxBeerCount = 0;
  Object.entries(beerCounts).forEach(([name, count]) => {
    if (count > maxBeerCount) {
      topBeerName = name;
      maxBeerCount = count;
    }
  });
  const topBeer = topBeerName
    ? `${topBeerName} (${maxBeerCount} pint${maxBeerCount > 1 ? "s" : ""})`
    : "No beers logged yet";

  return {
    totalPints,
    avgRating,
    favoriteStyle,
    totalCheers,
    topBeer,
  };
}

export function getMostDrankBeerForUser(username: string, logs: BeerLog[]): string {
  if (!username) return "No beers logged yet";
  return calculateUserStats(logs, username).topBeer;
}

function isHeicFile(file: File): boolean {
  const type = (file.type || "").toLowerCase();
  if (type === "image/heic" || type === "image/heif") return true;
  const name = (file.name || "").toLowerCase();
  return name.endsWith(".heic") || name.endsWith(".heif");
}

// HEIC is the iPhone camera's default format. WebKit (Safari, and every iOS browser -
// Apple requires them all to use WKWebView) decodes it natively via <img>, but desktop
// Chrome/Firefox and Android Chrome can't, so the canvas-based compression below would
// otherwise just silently fail to load the image for those users. Converted lazily via
// dynamic import so the ~2.7MB WASM decoder only ever loads for someone actually
// uploading a HEIC file, not for every photo upload in the app.
export async function convertHeicIfNeeded(file: File): Promise<File> {
  if (!isHeicFile(file)) return file;
  try {
    const heic2any = (await import("heic2any")).default;
    const result = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
    const blob = Array.isArray(result) ? result[0] : result;
    return new File([blob], file.name.replace(/\.hei[cf]$/i, ".jpg"), { type: "image/jpeg" });
  } catch (err) {
    console.error("[HEIC] Conversion failed - falling back to the original file:", err);
    return file;
  }
}

export async function compressAndResizeImage(
  file: File,
  maxWidth = 600,
  maxHeight = 600,
  quality = 0.5
): Promise<string> {
  const sourceFile = await convertHeicIfNeeded(file);
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(sourceFile);
    const img = new Image();
    img.src = objectUrl;

    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxWidth) {
            height *= maxWidth / width;
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width *= maxHeight / height;
            height = maxHeight;
          }
        }

        canvas.width = Math.round(width);
        canvas.height = Math.round(height);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(objectUrl);
          const reader = new FileReader();
          reader.readAsDataURL(sourceFile);
          reader.onload = (e) => resolve(e.target?.result as string);
          reader.onerror = (e) => reject(e);
          return;
        }

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        URL.revokeObjectURL(objectUrl);
        resolve(dataUrl);
      } catch (err) {
        URL.revokeObjectURL(objectUrl);
        reject(err);
      }
    };

    img.onerror = (err) => {
      URL.revokeObjectURL(objectUrl);
      reject(err);
    };
  });
}

export function compressImage(file: File, maxWidth = 150, maxHeight = 150): Promise<string> {
  return compressAndResizeImage(file, maxWidth, maxHeight, 0.85);
}
