import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { Star, MessageSquare, Flame, Trash2, Heart, Search, Award, RefreshCw, Edit, Camera, Siren, Plus, Smile, X, Flag, MapPin, Globe, Users as UsersIcon, MoreHorizontal } from "lucide-react";
import { BeerLog, UserProfile, isSeymoreBeers } from "../types";
import { useRetryImage } from "../utils";
import UserAvatar from "./UserAvatar";
import MentionDropdown from "./MentionDropdown";

// Retries a few times with backoff before falling back to a text-only card - see
// useRetryImage for why a bare <img onError> isn't enough here.
function PostPhoto({ imageUrl, alt }: { imageUrl: string; alt: string }) {
  const { src, failed, onError, retryKey } = useRetryImage(imageUrl);
  if (!src || failed) return null;
  return (
    <div className="relative rounded-xl overflow-hidden border border-slate-200/85 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 max-h-80 w-full flex items-center justify-center shadow-sm">
      <img
        key={retryKey}
        src={src}
        alt={alt}
        className="object-cover max-h-80 w-full hover:scale-[1.01] transition-all duration-300"
        referrerPolicy="no-referrer"
        onError={onError}
      />
    </div>
  );
}

interface ActivityFeedProps {
  logs: BeerLog[];
  users: UserProfile[];
  currentUser: string;
  selectedUserFilter?: string;
  onUserFilterChange?: (user: string) => void;
  searchTerm?: string;
  onSearchTermChange?: (term: string) => void;
  feedScope?: "everyone" | "friends";
  onFeedScopeChange?: (scope: "everyone" | "friends") => void;
  onCheersToggled: (id: string) => void;
  onReactionToggled?: (id: string, reactionType: string) => void;
  onLogDeleted: (id: string) => void;
  onLogUpdated: (updatedLog: BeerLog) => void;
  onEditLogRequested?: (log: BeerLog) => void;
  onQuickLogRequested?: () => void;
  onViewProfileRequested?: (username: string) => void;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  hasMore?: boolean;
}

interface CommentInputProps {
  logId: string;
  users: UserProfile[];
  currentUser: string;
  onLogUpdated: (updatedLog: BeerLog) => void;
  onViewProfileRequested?: (username: string) => void;
}

function CommentInput({
  logId,
  users,
  currentUser,
  onLogUpdated,
  onViewProfileRequested
}: CommentInputProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`/api/beers/${encodeURIComponent(logId)}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user: currentUser, text: trimmed }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error("Could not post comment");
      }

      const updatedLog: BeerLog = await response.json();
      onLogUpdated(updatedLog);
      setText("");
    } catch (err) {
      console.error("Comment submission error or timeout:", err);
    } finally {
      clearTimeout(timeoutId);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex gap-2.5 items-center pt-2 border-t border-slate-100 dark:border-slate-800/60">
      <div 
        className="cursor-pointer hover:opacity-85 transition-all shrink-0"
        onClick={() => onViewProfileRequested?.(currentUser)}
      >
        <UserAvatar username={currentUser} users={users} className="w-6 h-6 text-[10px] rounded-lg" />
      </div>
      <div className="flex-1 flex gap-2 relative">
        <input
          ref={inputRef}
          type="text"
          placeholder="Write a comment..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleSubmit();
            }
          }}
          disabled={isSubmitting}
          className="flex-1 px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-amber-500/10 focus:border-amber-500 text-slate-850 dark:text-slate-100 placeholder-slate-400 transition-all"
        />
        <MentionDropdown
          text={text}
          onChange={setText}
          inputRef={inputRef}
          users={users}
          currentUser={currentUser}
          className="bottom-full mb-1 left-0"
        />
        <button
          onClick={handleSubmit}
          disabled={!text.trim() || isSubmitting}
          className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white rounded-lg text-[11px] font-bold transition-all cursor-pointer"
        >
          {isSubmitting ? "..." : "Post"}
        </button>
      </div>
    </div>
  );
}

function renderTextWithMentions(
  text: string | undefined,
  users: UserProfile[],
  onViewProfileRequested?: (username: string) => void
) {
  if (!text) return null;

  // New usernames can't contain spaces, but legacy accounts (e.g. the admin
  // "Seymore Beerz") still can - matching the longest known username first
  // means those still link/highlight correctly instead of only "@Seymore".
  const knownUsernames = [...new Set(users.map((u) => u.username))].sort((a, b) => b.length - a.length);

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  while (cursor < text.length) {
    const atIndex = text.indexOf("@", cursor);
    if (atIndex === -1) {
      nodes.push(text.slice(cursor));
      break;
    }
    if (atIndex > cursor) {
      nodes.push(text.slice(cursor, atIndex));
    }

    const remainder = text.slice(atIndex + 1);
    const matchedUsername = knownUsernames.find((name) => {
      if (!remainder.toLowerCase().startsWith(name.toLowerCase())) return false;
      const nextChar = remainder[name.length];
      return !nextChar || !/[a-zA-Z0-9_-]/.test(nextChar);
    });

    if (matchedUsername) {
      nodes.push(
        <span
          key={key++}
          onClick={() => onViewProfileRequested?.(matchedUsername)}
          className="text-amber-600 dark:text-amber-400 font-bold hover:underline cursor-pointer underline decoration-amber-500/50 underline-offset-2"
        >
          @{matchedUsername}
        </span>
      );
      cursor = atIndex + 1 + matchedUsername.length;
    } else {
      // Not a recognized user - render as plain text, same as before.
      const fallback = remainder.match(/^[a-zA-Z0-9_-]*/)?.[0] || "";
      nodes.push(`@${fallback}`);
      cursor = atIndex + 1 + fallback.length;
    }
  }

  return <>{nodes}</>;
}

const POST_REPORT_REASONS = [
  "Spam",
  "Harassment or bullying",
  "Inappropriate or offensive content",
  "Underage drinking concern",
  "Other",
];

const REACTION_TYPES = [
  { key: "cheers", emoji: "🍻", label: "Cheers" },
  { key: "creamy", emoji: "🍺", label: "Creamy" },
  { key: "fomo", emoji: "🚨", label: "FOMO Alert" },
  { key: "nightnight", emoji: "🌙", label: "Night night" },
  { key: "dislike", emoji: "👎", label: "Imposter Pint" }
];

// Every reaction (preset or custom) renders in one of these color themes - shared
// between the picker grid (so a cell previews the color its pill will take) and the
// active pill on a post. Tailwind's build-time class scanner needs every class as a
// literal substring somewhere in source, so these are spelled out in full rather than
// built from `bg-${theme}-50`-style template strings, which it can't see and won't
// generate.
type ReactionTheme = "amber" | "orange" | "rose" | "fuchsia" | "sky" | "emerald" | "slate" | "indigo";

const THEME_STYLES: Record<ReactionTheme, { cell: string; active: string; unselected: string }> = {
  amber: {
    cell: "bg-amber-50/90 dark:bg-amber-950/40 border-amber-200/80 dark:border-amber-800/80 text-amber-800 dark:text-amber-300",
    active: "bg-amber-500 text-white border-amber-500 ring-2 ring-amber-500/20 shadow-xs",
    unselected: "bg-amber-50/90 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 border-amber-200/80 dark:border-amber-800/80 hover:bg-amber-100 dark:hover:bg-amber-900/50",
  },
  orange: {
    cell: "bg-orange-50/90 dark:bg-orange-950/40 border-orange-200/80 dark:border-orange-800/80 text-orange-800 dark:text-orange-300",
    active: "bg-orange-600 text-white border-orange-600 ring-2 ring-orange-500/20 shadow-xs",
    unselected: "bg-orange-50/90 text-orange-900 dark:bg-orange-950/40 dark:text-orange-300 border-orange-200/80 dark:border-orange-800/80 hover:bg-orange-100 dark:hover:bg-orange-900/50",
  },
  rose: {
    cell: "bg-rose-50/90 dark:bg-rose-950/40 border-rose-200/80 dark:border-rose-800/80 text-rose-800 dark:text-rose-300",
    active: "bg-rose-600 text-white border-rose-600 ring-2 ring-rose-500/20 shadow-xs",
    unselected: "bg-rose-50/90 text-rose-900 dark:bg-rose-950/40 dark:text-rose-300 border-rose-200/80 dark:border-rose-800/80 hover:bg-rose-100 dark:hover:bg-rose-900/50",
  },
  fuchsia: {
    cell: "bg-fuchsia-50/90 dark:bg-fuchsia-950/40 border-fuchsia-200/80 dark:border-fuchsia-800/80 text-fuchsia-800 dark:text-fuchsia-300",
    active: "bg-fuchsia-600 text-white border-fuchsia-600 ring-2 ring-fuchsia-500/20 shadow-xs",
    unselected: "bg-fuchsia-50/90 text-fuchsia-900 dark:bg-fuchsia-950/40 dark:text-fuchsia-300 border-fuchsia-200/80 dark:border-fuchsia-800/80 hover:bg-fuchsia-100 dark:hover:bg-fuchsia-900/50",
  },
  sky: {
    cell: "bg-sky-50/90 dark:bg-sky-950/40 border-sky-200/80 dark:border-sky-800/80 text-sky-800 dark:text-sky-300",
    active: "bg-sky-600 text-white border-sky-600 ring-2 ring-sky-500/20 shadow-xs",
    unselected: "bg-sky-50/90 text-sky-900 dark:bg-sky-950/40 dark:text-sky-300 border-sky-200/80 dark:border-sky-800/80 hover:bg-sky-100 dark:hover:bg-sky-900/50",
  },
  emerald: {
    cell: "bg-emerald-50/90 dark:bg-emerald-950/40 border-emerald-200/80 dark:border-emerald-800/80 text-emerald-800 dark:text-emerald-300",
    active: "bg-emerald-600 text-white border-emerald-600 ring-2 ring-emerald-500/20 shadow-xs",
    unselected: "bg-emerald-50/90 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300 border-emerald-200/80 dark:border-emerald-800/80 hover:bg-emerald-100 dark:hover:bg-emerald-900/50",
  },
  slate: {
    cell: "bg-slate-100/90 dark:bg-slate-800/60 border-slate-200/80 dark:border-slate-700/80 text-slate-700 dark:text-slate-300",
    active: "bg-slate-600 text-white border-slate-600 ring-2 ring-slate-500/20 shadow-xs",
    unselected: "bg-slate-100/90 text-slate-800 dark:bg-slate-800/60 dark:text-slate-300 border-slate-200/80 dark:border-slate-700/80 hover:bg-slate-200 dark:hover:bg-slate-700/60",
  },
  indigo: {
    cell: "bg-indigo-50/90 dark:bg-indigo-950/40 border-indigo-200/80 dark:border-indigo-800/80 text-indigo-800 dark:text-indigo-300",
    active: "bg-indigo-600 text-white border-indigo-600 ring-2 ring-indigo-500/20 shadow-xs",
    unselected: "bg-indigo-50/90 text-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300 border-indigo-200/80 dark:border-indigo-800/80 hover:bg-indigo-100 dark:hover:bg-indigo-900/50",
  },
};

// Grouped by theme (rather than the original arbitrary order) so the picker grid reads
// as color "neighborhoods" instead of a randomly speckled wall of emoji.
const CUSTOM_EMOJIS: { emoji: string; label: string; theme: ReactionTheme }[] = [
  // Not cosmetically special, but real usage data shows this as by far the most-used
  // custom reaction on real posts (well ahead of everything else in this list) - it's
  // pinned first so the picker doesn't bury what people already reach for most.
  // A few reactions that are really just slang for "very drunk" ("Drunk" 🥴, "Sunk"
  // ⚓, "Twisted" 🥨) are deliberately left out even where they have real historical
  // usage - not a vibe worth encouraging on a platform centered around drinking.
  // "Stiff" 🥃 stays - it describes the drink's strength, not the drinker's state,
  // same category as "Creamy".
  { emoji: "🍑", label: "Juicy", theme: "rose" },
  { emoji: "🍺", label: "Creamy", theme: "amber" },
  { emoji: "🍻", label: "Cheers", theme: "amber" },
  { emoji: "✨", label: "Magic", theme: "amber" },
  { emoji: "🌟", label: "Legend", theme: "amber" },
  { emoji: "👑", label: "PintKing", theme: "amber" },
  { emoji: "🏰", label: "TheLocal", theme: "amber" },
  { emoji: "🏆", label: "Champ", theme: "amber" },
  { emoji: "🥃", label: "Stiff", theme: "orange" },
  { emoji: "🔥", label: "Banger", theme: "orange" },
  { emoji: "👀", label: "FOMO", theme: "orange" },
  { emoji: "❤️", label: "Mates", theme: "rose" },
  { emoji: "👎", label: "Imposter", theme: "rose" },
  { emoji: "💔", label: "Spilled", theme: "rose" },
  { emoji: "🥂", label: "Posh", theme: "fuchsia" },
  { emoji: "🍷", label: "Snooty", theme: "fuchsia" },
  { emoji: "🎉", label: "Session", theme: "fuchsia" },
  { emoji: "🤩", label: "Stellar", theme: "fuchsia" },
  { emoji: "🥳", label: "Rowdy", theme: "fuchsia" },
  { emoji: "🍹", label: "Fruity", theme: "sky" },
  { emoji: "🚀", label: "Sent", theme: "sky" },
  { emoji: "😎", label: "Smooth", theme: "sky" },
  { emoji: "👍", label: "Solid", theme: "emerald" },
  { emoji: "💯", label: "Elite", theme: "emerald" },
  { emoji: "👏", label: "Respect", theme: "emerald" },
  { emoji: "🙌", label: "Preach", theme: "emerald" },
  { emoji: "🎯", label: "Nailed It", theme: "emerald" },
  { emoji: "🍀", label: "Lucky", theme: "emerald" },
  { emoji: "😂", label: "Banter", theme: "slate" },
  { emoji: "🍕", label: "SoberUp", theme: "slate" },
  { emoji: "🍔", label: "PubGrub", theme: "slate" },
  { emoji: "🍟", label: "Chips", theme: "slate" },
  { emoji: "🥓", label: "Crispy", theme: "slate" },
  { emoji: "🌙", label: "Night night", theme: "indigo" },
  { emoji: "🤔", label: "Dodgy", theme: "indigo" },
  { emoji: "😮", label: "Gasp", theme: "indigo" },
];

// The tapback-style "first look" row shown when you tap the react button - the same
// 5 reactions that already get their own pill in the bar below once someone's used
// them, stored under these semantic keys (not the raw emoji) so they line up with the
// existing preset pills and server-side notification labels. Anything beyond these
// five lives one tap further in, in the full CUSTOM_EMOJIS grid.
const QUICK_REACTION_PRESETS: { key: string; emoji: string; label: string }[] = [
  { key: "cheers", emoji: "🍻", label: "Cheers" },
  { key: "creamy", emoji: "🍺", label: "Creamy" },
  { key: "fomo", emoji: "🚨", label: "FOMO Alert" },
  { key: "nightnight", emoji: "🌙", label: "Night night" },
  { key: "dislike", emoji: "👎", label: "Imposter" },
];

function getReactionTheme(key: string): ReactionTheme {
  const byEmoji = CUSTOM_EMOJIS.find((e) => e.emoji === key);
  if (byEmoji) return byEmoji.theme;
  const byLabel = CUSTOM_EMOJIS.find((e) => e.label.toLowerCase() === key.toLowerCase());
  return byLabel?.theme || "amber";
}

// Tapback-style reaction picker, in a fixed-position portal anchored to the react
// button's live on-screen position. A portal (rather than an absolutely-positioned
// child of the post card) is required here: post cards are wrapped in framer-motion's
// `motion.div` with layout animations, which apply a CSS transform and would silently
// make any `position: fixed` descendant relative to that card instead of the viewport
// - exactly what was clipping the picker off-screen whenever it opened near the top of
// the feed. Position is recomputed from the anchor element on every scroll/resize
// (rather than closing on scroll) so it tracks the button instead of detaching from it.
//
// Opens on a compact 5-item "quick" row (iMessage tapback-style) and only drops down
// into the full emoji grid if you tap "more" - most reactions people actually send are
// one of the five, so this avoids making everyone scan a ~25-emoji wall just to hit
// Cheers.
function ReactionPicker({
  anchorEl,
  onSelect,
  onClose,
}: {
  anchorEl: HTMLElement;
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<"quick" | "full">("quick");
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<{ top: number; left: number } | null>(null);
  const popoverWidth = view === "quick" ? 236 : 260;

  useEffect(() => {
    const margin = 8;

    const reposition = () => {
      if (!anchorEl.isConnected) {
        onClose();
        return;
      }
      const anchorRect = anchorEl.getBoundingClientRect();
      const popoverHeight = popoverRef.current?.offsetHeight || (view === "quick" ? 56 : 320);

      const roomAbove = anchorRect.top - margin;
      const top =
        roomAbove >= popoverHeight
          ? Math.max(margin, anchorRect.top - popoverHeight - margin)
          : Math.min(anchorRect.bottom + margin, window.innerHeight - margin - popoverHeight);

      let left = anchorRect.left;
      left = Math.min(left, window.innerWidth - popoverWidth - margin);
      left = Math.max(left, margin);

      setStyle({ top, left });
    };

    reposition();

    let rafId: number | null = null;
    const onScrollOrResize = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        reposition();
      });
    };
    window.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [anchorEl, onClose, view, popoverWidth]);

  return createPortal(
    <>
      <div className="fixed inset-0 z-[95]" onClick={onClose} onTouchStart={onClose} />
      <div
        ref={popoverRef}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          top: style?.top ?? -9999,
          left: style?.left ?? -9999,
          width: popoverWidth,
          visibility: style ? "visible" : "hidden",
        }}
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl z-[96] overflow-hidden"
      >
        {view === "quick" ? (
          <div className="flex items-center gap-1 p-1.5">
            {QUICK_REACTION_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => onSelect(p.key)}
                title={p.label}
                className="w-9 h-9 flex items-center justify-center text-xl rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-90 transition-all cursor-pointer select-none"
              >
                {p.emoji}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setView("full")}
              title="More reactions"
              className="w-9 h-9 flex items-center justify-center rounded-full border border-slate-200 dark:border-slate-700 text-slate-400 hover:text-amber-500 hover:border-amber-400 transition-all cursor-pointer shrink-0"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="p-2.5 max-h-[340px] overflow-y-auto custom-scrollbar">
            <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 pl-0.5">React with Emoji</span>
            <div className="grid grid-cols-4 gap-1 mt-1.5">
              {CUSTOM_EMOJIS.map((em) => {
                const theme = THEME_STYLES[em.theme];
                return (
                  <button
                    key={em.emoji}
                    type="button"
                    onClick={() => onSelect(em.emoji)}
                    className={`flex flex-col items-center justify-center gap-0.5 rounded-lg border py-1.5 px-0.5 transition-all active:scale-90 hover:scale-105 cursor-pointer select-none ${theme.cell}`}
                  >
                    <span className="text-lg leading-none">{em.emoji}</span>
                    <span className="text-[7.5px] font-black uppercase tracking-wide leading-none truncate max-w-full">
                      {em.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>,
    document.body
  );
}

export default function ActivityFeed({
  logs,
  users,
  currentUser,
  selectedUserFilter,
  onUserFilterChange,
  searchTerm: propSearchTerm,
  onSearchTermChange,
  feedScope = "everyone",
  onFeedScopeChange,
  onCheersToggled,
  onReactionToggled,
  onLogDeleted,
  onLogUpdated,
  onEditLogRequested,
  onQuickLogRequested,
  onViewProfileRequested,
  onLoadMore,
  loadingMore,
  hasMore
}: ActivityFeedProps) {
  const [activeReactionTooltip, setActiveReactionTooltip] = useState<string | null>(null);
  const [activeReactionPicker, setActiveReactionPicker] = useState<{ logId: string; el: HTMLElement } | null>(null);
  const [activeReportLogId, setActiveReportLogId] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [reportNote, setReportNote] = useState("");
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);
  const [reportSubmittedLogId, setReportSubmittedLogId] = useState<string | null>(null);

  const handleSubmitPostReport = async (log: BeerLog) => {
    if (!reportReason) return;
    setIsSubmittingReport(true);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reporterUsername: currentUser,
          targetType: "post",
          targetId: log.id,
          targetUsername: log.user,
          reason: reportReason,
          note: reportNote.trim() || undefined,
        }),
      });
      if (res.ok) {
        setReportSubmittedLogId(log.id);
        setTimeout(() => {
          setActiveReportLogId(null);
          setReportSubmittedLogId(null);
          setReportReason("");
          setReportNote("");
        }, 1600);
      }
    } catch (err) {
      console.error("Failed to submit report:", err);
    } finally {
      setIsSubmittingReport(false);
    }
  };
  const [localSearchTerm, setLocalSearchTerm] = useState(propSearchTerm || "");
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setLocalSearchTerm(propSearchTerm || "");
  }, [propSearchTerm]);

  const handleSearchInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setLocalSearchTerm(val);

    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }

    if (onSearchTermChange) {
      searchDebounceRef.current = setTimeout(() => {
        onSearchTermChange(val);
      }, 250);
    }
  };

  const handleClearSearch = () => {
    setLocalSearchTerm("");
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }
    onSearchTermChange?.("");
  };

  useEffect(() => {
    const handleGlobalClick = () => {
      setActiveReactionTooltip(null);
      setActiveReactionPicker(null);
    };

    document.addEventListener("click", handleGlobalClick);
    document.addEventListener("touchstart", handleGlobalClick);

    return () => {
      document.removeEventListener("click", handleGlobalClick);
      document.removeEventListener("touchstart", handleGlobalClick);
    };
  }, []);

  const REACTION_METADATA_MAP: Record<string, { emoji: string; label: string }> = {
    cheers: { emoji: "🍻", label: "Cheers" },
    creamy: { emoji: "🍺", label: "Creamy" },
    fomo: { emoji: "🚨", label: "FOMO Alert" },
    nightnight: { emoji: "🌙", label: "Night night" },
    dislike: { emoji: "👎", label: "Imposter" },
    drunk: { emoji: "🥴", label: "Drunk" },
    juicy: { emoji: "🍑", label: "Juicy" },
  };

  const getReactionDisplay = (key: string): { emoji: string; label: string } => {
    if (REACTION_METADATA_MAP[key]) {
      return REACTION_METADATA_MAP[key];
    }
    const customByEmoji = CUSTOM_EMOJIS.find(e => e.emoji === key);
    if (customByEmoji) {
      return { emoji: customByEmoji.emoji, label: customByEmoji.label };
    }
    const customByLabel = CUSTOM_EMOJIS.find(e => e.label.toLowerCase() === key.toLowerCase());
    if (customByLabel) {
      return { emoji: customByLabel.emoji, label: customByLabel.label };
    }
    const isEmojiChar = /\p{Extended_Pictographic}/u.test(key);
    if (isEmojiChar) {
      return { emoji: key, label: key };
    }
    return { emoji: "🍺", label: key };
  };

  const getReactionList = (log: BeerLog, type: string): string[] => {
    if (type === "cheers") {
      return log.cheers || [];
    }
    return log.reactions?.[type] || [];
  };

  const mapEmojiToReactionKey = (emoji: string): string => {
    const mapping: Record<string, string> = {
      "🍻": "cheers",
      "🍺": "creamy",
      "🚨": "fomo",
      "🌙": "nightnight",
      "🥴": "drunk",
      "🍑": "juicy",
      "👎": "dislike"
    };
    return mapping[emoji] || emoji;
  };

  const handleReact = (logId: string, reactionKey: string) => {
    if (!currentUser) {
      return;
    }
    const key = mapEmojiToReactionKey(reactionKey);
    if (key === "cheers") {
      onCheersToggled(logId);
    } else if (onReactionToggled) {
      onReactionToggled(logId, key);
    }
  };

  const renderReactionSummary = (log: BeerLog) => {
    // Collect standard reactions
    const standardReactions = REACTION_TYPES.map((react) => {
      const list = getReactionList(log, react.key);
      return { react: { key: react.key, emoji: react.emoji, label: react.label }, list };
    });

    // Collect custom ones
    const standardKeys = ["cheers", "creamy", "fomo", "drunk", "juicy", "dislike"];
    const customReactionKeys = log.reactions 
      ? Object.keys(log.reactions).filter(k => !standardKeys.includes(k) && log.reactions[k] && log.reactions[k].length > 0)
      : [];

    const customReactions = customReactionKeys.map((emojiKey) => {
      const list = getReactionList(log, emojiKey);
      return { react: { key: emojiKey, emoji: emojiKey, label: emojiKey }, list };
    });

    const activeReactions = [...standardReactions, ...customReactions].filter(({ list }) => list.length > 0);

    if (activeReactions.length === 0) {
      return <span className="italic text-slate-300 text-[10px] dark:text-slate-600">Be the first to react!</span>;
    }

    return (
      <div className="flex flex-wrap justify-start gap-x-1.5 gap-y-1 text-[9px] font-extrabold text-slate-500 uppercase tracking-wider">
        {activeReactions.map(({ react, list }, i) => {
          const tooltipKey = `${log.id}-${react.key}`;
          const isTooltipActive = activeReactionTooltip === tooltipKey;
          return (
            <span
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                setActiveReactionTooltip(prev => prev === tooltipKey ? null : tooltipKey);
              }}
              onTouchStart={(e) => {
                e.stopPropagation();
              }}
              className={`relative group px-2 py-0.5 rounded-full border cursor-pointer flex items-center gap-1.5 transition-all duration-150 text-[10px] font-extrabold select-none ${
                isTooltipActive
                  ? "bg-amber-500/15 text-amber-600 border-amber-300 dark:bg-amber-500/20 dark:text-amber-400 dark:border-amber-500/40"
                  : "bg-slate-50 hover:bg-slate-100 text-slate-500 hover:text-slate-700 border-slate-200 dark:bg-slate-900/40 dark:hover:bg-slate-850 dark:text-slate-400 dark:hover:text-slate-200 dark:border-slate-800"
              }`}
            >
              <span className="text-[11px]">{react.emoji}</span>
              <span className="text-[9px] font-extrabold uppercase tracking-wider">{react.label}</span>
              <span className="text-[10px] font-black opacity-80">{list.length}</span>

              {/* Custom interactive tooltip showing who reacted what */}
              <div
                className={`absolute bottom-full mb-2 right-0 transition-all duration-150 z-30 flex flex-col items-end ${
                  isTooltipActive
                    ? "opacity-100 scale-100 pointer-events-auto"
                    : "opacity-0 group-hover:opacity-100 pointer-events-none scale-95 group-hover:scale-100"
                }`}
              >
                <div className="bg-slate-900/95 text-white text-[10px] font-extrabold normal-case py-1.5 px-2.5 rounded-lg shadow-xl whitespace-nowrap border border-slate-800 flex flex-col gap-0.5 min-w-[120px] text-right">
                  <span className="text-amber-400 font-black tracking-wider text-[8px] uppercase mb-0.5">{react.label} by:</span>
                  {list.map((uname, idx) => {
                    const uProfile = users.find(u => u.username === uname);
                    return (
                      <span key={idx} className="block text-slate-200">
                        {uProfile?.realName ? `${uProfile.realName} (@${uname})` : `@${uname}`}
                      </span>
                    );
                  })}
                </div>
                <div className="w-1.5 h-1.5 bg-slate-900 rotate-45 -mt-[3px] mr-3 border-r border-b border-slate-800"></div>
              </div>
            </span>
          );
        })}
      </div>
    );
  };

  const [logToDelete, setLogToDelete] = useState<string | null>(null);

  const [newCommentTexts, setNewCommentTexts] = useState<Record<string, string>>({});
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({});
  const [activeCommentPicker, setActiveCommentPicker] = useState<string | null>(null);

  const toggleComments = (logId: string) => {
    setExpandedComments((prev) => {
      const log = logs.find((l) => l.id === logId);
      const defaultExpanded = !!(log?.comments && log.comments.length > 0);
      const currentVal = prev[logId] ?? defaultExpanded;
      return {
        ...prev,
        [logId]: !currentVal
      };
    });
  };

  const handleAddComment = async (logId: string) => {
    const text = newCommentTexts[logId]?.trim();
    if (!text) return;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`/api/beers/${encodeURIComponent(logId)}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user: currentUser, text }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error("Could not post comment");
      }

      const updatedLog: BeerLog = await response.json();
      onLogUpdated(updatedLog);
      
      // Clear input text
      setNewCommentTexts((prev) => ({
        ...prev,
        [logId]: "",
      }));
    } catch (err) {
      console.error("Add comment error/timeout:", err);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const handleDeleteComment = async (logId: string, commentId: string) => {
    const targetLog = logs.find((l) => l.id === logId);
    if (!targetLog) return;

    // Optimistically remove comment locally
    const updatedComments = (targetLog.comments || []).filter((c) => c.id !== commentId);
    const updatedLog = { ...targetLog, comments: updatedComments };
    onLogUpdated(updatedLog);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`/api/beers/${encodeURIComponent(logId)}/comments/${encodeURIComponent(commentId)}?currentUser=${encodeURIComponent(currentUser)}`, {
        method: "DELETE",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error("Could not delete comment");
      }

      const serverLog: BeerLog = await response.json();
      onLogUpdated(serverLog);
    } catch (err) {
      console.error(err);
      // Revert if failed
      onLogUpdated(targetLog);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const handleToggleCommentReaction = async (logId: string, commentId: string, reaction: string) => {
    const targetLog = logs.find((l) => l.id === logId);
    if (!targetLog) return;

    const targetComment = (targetLog.comments || []).find((c) => c.id === commentId);
    if (!targetComment) return;

    // Optimistically update comment reaction
    const currentReactions = targetComment.reactions ? { ...targetComment.reactions } : {};
    const currentUsers = currentReactions[reaction] ? [...currentReactions[reaction]] : [];
    const userIdx = currentUsers.indexOf(currentUser);

    if (userIdx !== -1) {
      currentUsers.splice(userIdx, 1);
    } else {
      currentUsers.push(currentUser);
    }

    if (currentUsers.length === 0) {
      delete currentReactions[reaction];
    } else {
      currentReactions[reaction] = currentUsers;
    }

    const updatedComments = (targetLog.comments || []).map((c) => {
      if (c.id === commentId) {
        return { ...c, reactions: currentReactions };
      }
      return c;
    });

    const updatedLog = { ...targetLog, comments: updatedComments };
    onLogUpdated(updatedLog);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(
        `/api/beers/${encodeURIComponent(logId)}/comments/${encodeURIComponent(commentId)}/reactions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user: currentUser, reaction }),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        throw new Error("Could not update comment reaction");
      }

      const serverLog: BeerLog = await response.json();
      onLogUpdated(serverLog);
    } catch (err) {
      console.error("Error toggling comment reaction:", err);
      // Revert on error
      onLogUpdated(targetLog);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const getUserAvatar = (username: string) => {
    const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    return user?.avatar || "👤";
  };

  const getUserBio = (username: string) => {
    const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    return user?.bio || "Craft beer enjoyer.";
  };

  // Helper to format date beautifully
  const formatBeerDate = (isoString: string) => {
    const d = new Date(isoString);
    const now = new Date();
    
    // Check if valid date
    if (isNaN(d.getTime())) return "Sometime";

    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;

    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  };

  // Helper to get the exact time string, in the POSTER's local timezone (not
  // the viewer's) when we captured one at check-in time - e.g. "3:45 PM EST"
  // for a friend on the east coast even if you're viewing from California.
  // Falls back to the viewer's own local time for older logs with no stored
  // timezone.
  const getExactTimeStr = (isoString: string, timezone?: string) => {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return "";
    if (!timezone) {
      return d.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      });
    }
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short"
      }).formatToParts(d);
      const hour = parts.find((p) => p.type === "hour")?.value || "";
      const minute = parts.find((p) => p.type === "minute")?.value || "";
      const dayPeriod = parts.find((p) => p.type === "dayPeriod")?.value || "";
      const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "";
      return [`${hour}:${minute} ${dayPeriod}`, tzName].filter(Boolean).join(" ");
    } catch (e) {
      return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
    }
  };

  // Helper to determine if a date is "after midnight" (12:00 AM to 4:59 AM)
  // in the POSTER's local time, not the viewer's.
  const isAfterMidnight = (isoString: string, timezone?: string) => {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return false;
    if (!timezone) {
      const hours = d.getHours();
      return hours >= 0 && hours < 5;
    }
    try {
      const hourPart = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false }).formatToParts(d).find((p) => p.type === "hour")?.value;
      const hours = hourPart ? parseInt(hourPart, 10) % 24 : d.getHours();
      return hours >= 0 && hours < 5;
    } catch (e) {
      const hours = d.getHours();
      return hours >= 0 && hours < 5;
    }
  };

  // Helper to format date with its exact time
  const formatBeerDateWithTime = (isoString: string, timezone?: string) => {
    const baseDate = formatBeerDate(isoString);
    const timeStr = getExactTimeStr(isoString, timezone);
    if (!timeStr) return baseDate;

    if (baseDate === "Just now") return `Just now (${timeStr})`;
    if (baseDate.endsWith("ago")) return `${baseDate} (${timeStr})`;

    return `${baseDate} at ${timeStr}`;
  };

  const activeSearchTerm = (propSearchTerm || localSearchTerm).trim();

  // Filtering logs (database-scoped queries handle user/pub/style/search filters)
  const filteredLogs = logs.filter((log) => {

    if (!activeSearchTerm) return true;
    const term = activeSearchTerm.toLowerCase();
    return (
      (log.beerName && log.beerName.toLowerCase().includes(term)) ||
      (log.beerStyle && log.beerStyle.toLowerCase().includes(term)) ||
      (log.comment && log.comment.toLowerCase().includes(term)) ||
      (log.user && log.user.toLowerCase().includes(term))
    );
  });

  const uniqueFilteredLogs: BeerLog[] = [];
  const seenLogIds = new Set<string>();
  filteredLogs.forEach((l) => {
    if (l && l.id && !seenLogIds.has(l.id)) {
      seenLogIds.add(l.id);
      uniqueFilteredLogs.push(l);
    }
  });

  return (
    <div className="space-y-6 max-w-2xl mx-auto" id="activity-feed-view">
      {/* Quick Log Pint CTA Banner - Sticky on scroll */}
      <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top,0px))] sm:top-[calc(4rem+env(safe-area-inset-top,0px))] z-30 -mt-6 pt-2 pb-2 bg-slate-50 dark:bg-slate-950 transition-all">
        <div className="bg-gradient-to-r from-amber-500 via-amber-600 to-orange-500 rounded-xl p-2.5 sm:p-3.5 shadow-md border border-amber-600/10 flex flex-row items-center justify-between gap-2.5">
          <div className="space-y-0.5 min-w-0">
            <h3 className="text-white font-extrabold text-xs sm:text-sm uppercase tracking-wider flex items-center gap-1.5 truncate">
              Time for a Pint? 🍻
            </h3>
            <p className="text-white/90 text-[11px] font-semibold leading-normal hidden sm:block">
              Creamy pint, meet camera. Friends, meet regret.
            </p>
          </div>
          
          <button
            onClick={onQuickLogRequested}
            className="bg-white hover:bg-slate-50 text-amber-600 font-extrabold px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg text-[11px] sm:text-xs shadow-sm active:scale-95 transition-all flex items-center justify-center gap-1.5 select-none cursor-pointer uppercase shrink-0 tracking-wider font-sans whitespace-nowrap"
          >
            <Camera className="w-3.5 h-3.5 text-amber-500" /> Log a Pint
          </button>
        </div>
      </div>

      {/* Compact Search & Filter Bar */}
      <div className="bg-white dark:bg-slate-900 p-2 sm:p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-2">
        {/* Feed Scope Toggle - Everyone vs Friends only */}
        {onFeedScopeChange && (
          <div className="inline-flex items-center self-start gap-0.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-0.5">
            <button
              type="button"
              onClick={() => onFeedScopeChange("everyone")}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
                feedScope === "everyone"
                  ? "bg-amber-500 text-slate-950 shadow-sm"
                  : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
              }`}
            >
              <Globe className="w-3 h-3" /> Everyone
            </button>
            <button
              type="button"
              onClick={() => onFeedScopeChange("friends")}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
                feedScope === "friends"
                  ? "bg-amber-500 text-slate-950 shadow-sm"
                  : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
              }`}
            >
              <UsersIcon className="w-3 h-3" /> Friends
            </button>
          </div>
        )}

        <div className="flex flex-row gap-2 items-center w-full">
          {/* Search Input */}
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
            <input
              type="text"
              placeholder="Search beers, styles, notes..."
              value={localSearchTerm}
              onChange={handleSearchInputChange}
              className="w-full pl-8 pr-7 py-1.5 bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800/80 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-amber-500/10 focus:border-amber-500 text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 transition-all truncate"
            />
            {localSearchTerm && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="absolute right-2 top-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                title="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {activeSearchTerm && (
          <div className="flex items-center justify-between bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 px-2.5 py-1 rounded-lg text-xs text-amber-900 dark:text-amber-200">
            <span className="font-semibold flex items-center gap-1.5 text-[11px] truncate">
              <span>🔍</span> Results for: <span className="font-bold underline">{activeSearchTerm}</span>
            </span>
            <button
              onClick={handleClearSearch}
              className="text-amber-700 dark:text-amber-300 hover:underline text-[10px] font-bold cursor-pointer shrink-0 ml-2"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Feed List */}
      <div className="space-y-4">
        <AnimatePresence mode="popLayout">
          {uniqueFilteredLogs.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="text-center bg-white border border-dashed border-slate-200 rounded-xl py-12 px-6"
            >
              <div className="text-4xl mb-3">🍻</div>
              <h3 className="text-lg font-bold text-slate-700">
                {feedScope === "friends" ? "No pints from friends yet" : "No pints found"}
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                {feedScope === "friends"
                  ? "Add some friends, or switch to Everyone to see the wider feed."
                  : "Be the first to log a pint, or try adjusting your search filters!"}
              </p>
            </motion.div>
          ) : (
            uniqueFilteredLogs.map((log) => {
              const hasCheered = log.cheers.includes(currentUser);
              const isDenied = getReactionList(log, "dislike").length >= 3;
              const isCelebrated = (log.isFirstOfDay || log.isNewStyle) && !isDenied;
              // 3+ FOMO Alerts gets a drifting/blurring "too good to miss" treatment -
              // a real moment people don't want to miss, worth calling out visually.
              // Denied posts keep their own treatment regardless (that stamp already
              // covers the whole card, so layering another effect underneath would be wasted).
              const isFomoAlert = !isDenied && getReactionList(log, "fomo").length >= 3;

              return (
                <motion.div
                  key={log.id}
                  layout
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.25 }}
                  className={`bg-white dark:bg-slate-900 rounded-xl border overflow-hidden transition-all shadow-sm relative ${
                    isDenied
                      ? "border-red-600 dark:border-red-800 shadow-[inset_0_0_20px_rgba(220,38,38,0.08)] bg-red-50/5"
                      : isFomoAlert
                        ? "fomo-alert-card"
                        : isCelebrated
                          ? "border-amber-400/80 dark:border-amber-500/50 shadow-sm ring-1 ring-amber-500/20"
                          : "border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700"
                  }`}
                >
                  {isDenied && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20 select-none bg-red-500/[0.03] backdrop-blur-[0.5px]">
                      <div className="border-8 border-double border-red-600 text-red-600 font-sans font-black text-4xl sm:text-5xl md:text-6xl px-6 py-3 sm:px-8 sm:py-4 rounded-2xl bg-white/95 dark:bg-slate-900/95 shadow-2xl tracking-widest -rotate-12 transform scale-100 flex flex-col items-center gap-1 animate-pulse select-none">
                        <span className="text-[9px] sm:text-[10px] uppercase tracking-[0.25em] text-red-500 font-black">👮‍♂️ INQUISITION POLICE 👮‍♂️</span>
                        <span className="font-extrabold text-red-700 text-5xl sm:text-6xl md:text-7xl tracking-widest drop-shadow-sm select-none">DENIED</span>
                        <span className="text-[9px] sm:text-[11px] font-black uppercase text-red-500 tracking-[0.15em]">NOT A REAL PINT! 🕵️</span>
                      </div>
                    </div>
                  )}

                  {/* Log Header */}
                  <div className="p-4 flex items-center justify-between border-b border-slate-100 dark:border-slate-800">
                    <div className="flex items-center gap-3">
                      <div 
                        className="cursor-pointer hover:opacity-80 transition-opacity"
                        onClick={() => onViewProfileRequested?.(log.user)}
                      >
                        <UserAvatar username={log.user} users={users} className="w-9 h-9 text-lg" />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span 
                            className="font-bold text-slate-800 text-sm hover:underline cursor-pointer"
                            onClick={() => onViewProfileRequested?.(log.user)}
                          >
                            {log.user}
                          </span>
                          {log.rating === 5 && (
                            <Award className="w-3.5 h-3.5 text-amber-500 fill-amber-500" title="Elite rating!" />
                          )}
                          {log.isFirstOfDay && !isDenied && (
                            <span
                              className="bg-amber-500/10 dark:bg-amber-950/70 text-amber-700 dark:text-amber-300 font-extrabold px-2 py-0.5 rounded-full text-[9px] uppercase tracking-wider inline-flex items-center gap-1 border border-amber-300 dark:border-amber-700/60 shadow-xs"
                              title={`${log.user} poured the first pint of the day!`}
                            >
                              🌅 First Pour
                            </span>
                          )}
                          {log.isNewStyle && !isDenied && (
                            <span
                              className="bg-emerald-500/10 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 font-extrabold px-2 py-0.5 rounded-full text-[9px] uppercase tracking-wider inline-flex items-center gap-1 border border-emerald-300 dark:border-emerald-700/60 shadow-xs"
                              title={`${log.user}'s first time logging a ${log.beerStyle}!`}
                            >
                              🆕 New Style
                            </span>
                          )}
                          {isFomoAlert && (
                            <span
                              className="fomo-alert-badge text-white font-extrabold px-2 py-0.5 rounded-full text-[9px] uppercase tracking-wider inline-flex items-center gap-1 shadow-xs"
                              title="3+ people hit FOMO Alert on this one - don't miss it!"
                            >
                              🚨 FOMO Alert
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">
                            {formatBeerDateWithTime(log.date, log.timezone)}
                          </p>
                          {isAfterMidnight(log.date, log.timezone) && (
                            <span className="bg-violet-500/10 text-violet-600 dark:text-violet-400 font-black px-1.5 py-0.5 rounded text-[8px] uppercase tracking-widest border border-violet-500/20">
                              👺 Goblin Mode
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2 relative">
                      {log.user === currentUser && (
                        <button
                          onClick={() => onEditLogRequested?.(log)}
                          className="text-slate-300 hover:text-amber-500 p-2 rounded-lg hover:bg-amber-50/50 transition-all focus:outline-none cursor-pointer"
                          title="Edit pint details"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                      )}
                      {log.user.toLowerCase() !== currentUser.toLowerCase() && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveReportLogId(activeReportLogId === log.id ? null : log.id);
                            setReportReason("");
                            setReportNote("");
                          }}
                          className="text-slate-300 hover:text-red-500 p-2 rounded-lg hover:bg-red-50/50 transition-all focus:outline-none cursor-pointer"
                          title="Report this post"
                        >
                          <Flag className="w-4 h-4" />
                        </button>
                      )}
                      {(isSeymoreBeers(currentUser) || log.user.toLowerCase() === currentUser.toLowerCase()) && (
                        <button
                          onClick={() => setLogToDelete(log.id)}
                          className="text-slate-300 hover:text-red-500 p-2 rounded-lg hover:bg-red-50/50 transition-all focus:outline-none cursor-pointer"
                          title={log.user.toLowerCase() === currentUser.toLowerCase() ? "Delete your post" : "Delete log (Admin)"}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}

                      {activeReportLogId === log.id && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="absolute top-full right-0 mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 shadow-2xl z-40 w-[220px] space-y-2"
                        >
                          {reportSubmittedLogId === log.id ? (
                            <p className="text-emerald-600 dark:text-emerald-400 text-[11px] font-bold">
                              Report submitted. Thanks for flagging this.
                            </p>
                          ) : (
                            <>
                              <span className="text-[9px] font-black uppercase tracking-wider text-slate-400 block">
                                Report this post
                              </span>
                              <select
                                value={reportReason}
                                onChange={(e) => setReportReason(e.target.value)}
                                className="w-full px-2 py-1.5 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-[11px] text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-amber-500"
                              >
                                <option value="">Select a reason...</option>
                                {POST_REPORT_REASONS.map((r) => (
                                  <option key={r} value={r}>{r}</option>
                                ))}
                              </select>
                              <input
                                type="text"
                                placeholder="Additional details (optional)"
                                value={reportNote}
                                onChange={(e) => setReportNote(e.target.value)}
                                className="w-full px-2 py-1.5 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-[11px] text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-amber-500"
                              />
                              <div className="flex gap-1.5">
                                <button
                                  type="button"
                                  disabled={!reportReason || isSubmittingReport}
                                  onClick={() => handleSubmitPostReport(log)}
                                  className="px-2.5 py-1 bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white font-bold rounded cursor-pointer transition-colors text-[10px] shrink-0"
                                >
                                  {isSubmittingReport ? "..." : "Submit"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setActiveReportLogId(null)}
                                  className="px-2.5 py-1 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-bold rounded cursor-pointer transition-colors text-[10px] shrink-0"
                                >
                                  Cancel
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Log Body */}
                  <div className="p-5 space-y-3.5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        {log.beerName && 
                         log.beerName.trim().toLowerCase() !== "unnamed pint" && 
                         log.beerName.trim().toLowerCase() !== "unnamed pint 🍺" ? (
                          <>
                            <h3 className={`font-extrabold text-base md:text-lg leading-tight ${
                              log.rating === 5
                                ? "bg-gradient-to-r from-amber-500 via-yellow-400 to-amber-500 bg-clip-text text-transparent"
                                : "text-slate-900 dark:text-slate-100"
                            }`}>
                              {log.beerName}
                            </h3>
                            <div className="flex flex-wrap items-center gap-2 mt-1.5">
                              {log.abv > 0 && (
                                <span className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 px-2.5 py-0.5 rounded-md text-[10px] font-bold uppercase">
                                  {log.abv.toFixed(1)}% ABV
                                </span>
                              )}
                              {log.location && (
                                <span className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 px-2.5 py-0.5 rounded-md text-[10px] font-bold">
                                  <MapPin className="w-2.5 h-2.5 shrink-0" />
                                  {log.location}
                                </span>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            {log.abv > 0 && (
                              <span className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 px-2.5 py-0.5 rounded-md text-[10px] font-bold uppercase">
                                {log.abv.toFixed(1)}% ABV
                              </span>
                            )}
                            {log.location && (
                              <span className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 px-2.5 py-0.5 rounded-md text-[10px] font-bold">
                                <MapPin className="w-2.5 h-2.5 shrink-0" />
                                {log.location}
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Display Stars */}
                      {log.rating > 0 ? (
                        <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-0.5">
                          <div className="flex items-center gap-0.5">
                            {[1, 2, 3, 4, 5].map((star) => (
                              <Star
                                key={star}
                                className={`w-3.5 h-3.5 ${
                                  star <= log.rating
                                    ? "fill-amber-400 text-amber-400"
                                    : "text-slate-200 dark:text-slate-600"
                                }`}
                              />
                            ))}
                          </div>
                          <span className="text-[10px] font-black text-slate-500 dark:text-slate-400 leading-none pl-0.5 border-l border-slate-200 dark:border-slate-700">
                            {log.rating}.0
                          </span>
                        </div>
                      ) : null}
                    </div>

                    {log.imageUrl && (
                      <PostPhoto imageUrl={log.imageUrl} alt={`${log.beerName} by ${log.user}`} />
                    )}

                    {/* Reaction Bar & Preset Buttons */}
                    {(() => {
                      const presets = [
                        { 
                          key: "cheers", 
                          emoji: "🍻", 
                          label: "Cheers", 
                          activeClass: "bg-amber-500 text-white border-amber-500 ring-2 ring-amber-500/20 shadow-xs",
                          unselectedClass: "bg-amber-50/90 text-amber-850 dark:bg-amber-950/40 dark:text-amber-300 border-amber-200/80 dark:border-amber-800/80 hover:bg-amber-100 dark:hover:bg-amber-900/50"
                        },
                        { 
                          key: "creamy", 
                          emoji: "🍺", 
                          label: "Creamy", 
                          activeClass: "bg-amber-600 text-white border-amber-600 ring-2 ring-amber-500/20 shadow-xs",
                          unselectedClass: "bg-amber-50/90 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 border-amber-200/80 dark:border-amber-800/80 hover:bg-amber-100 dark:hover:bg-amber-900/50"
                        },
                        { 
                          key: "fomo", 
                          emoji: "🚨", 
                          label: "FOMO Alert", 
                          activeClass: "bg-orange-600 text-white border-orange-600 ring-2 ring-orange-500/20 shadow-xs",
                          unselectedClass: "bg-orange-50/90 text-orange-900 dark:bg-orange-950/40 dark:text-orange-300 border-orange-200/80 dark:border-orange-800/80 hover:bg-orange-100 dark:hover:bg-orange-900/50"
                        },
                        { 
                          key: "nightnight", 
                          emoji: "🌙", 
                          label: "Night night", 
                          activeClass: "bg-indigo-600 text-white border-indigo-600 ring-2 ring-indigo-500/20 shadow-xs",
                          unselectedClass: "bg-indigo-50/90 text-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300 border-indigo-200/80 dark:border-indigo-800/80 hover:bg-indigo-100 dark:hover:bg-indigo-900/50"
                        },
                        { 
                          key: "dislike", 
                          emoji: "👎", 
                          label: "Imposter", 
                          activeClass: "bg-rose-600 text-white border-rose-600 ring-2 ring-rose-500/20 shadow-xs",
                          unselectedClass: "bg-rose-50/90 text-rose-900 dark:bg-rose-950/40 dark:text-rose-300 border-rose-200/80 dark:border-rose-800/80 hover:bg-rose-100 dark:hover:bg-rose-900/50"
                        },
                      ];

                      const presetKeys = presets.map(p => p.key);
                      const customReactionKeys = log.reactions 
                        ? Object.keys(log.reactions).filter(k => !presetKeys.includes(k) && log.reactions[k] && log.reactions[k].length > 0)
                        : [];

                      const customReactions = customReactionKeys.map((emojiKey) => {
                        const list = getReactionList(log, emojiKey);
                        const display = getReactionDisplay(emojiKey);
                        return { key: emojiKey, emoji: display.emoji, label: display.label, list };
                      });

                      return (
                        <div className="flex items-center justify-start gap-2 mt-3 pt-2.5 border-t border-slate-100 dark:border-slate-800">
                          {/* Pre-labeled buttons & Custom emoji reactions & Plus selector - only reactions someone has
                              actually used get a pill, so the row stays compact instead of wrapping/scrolling. The "+"
                              button is always visible and is the one discovery point for every reaction type, used or not. */}
                          <div className="flex flex-wrap items-center gap-1 min-w-0">
                            {/* Preset Buttons - hidden until at least one person has used them, except
                                FOMO Alert and Imposter which stay visible always: otherwise nobody
                                could ever be the first to use them since the button that starts it
                                off would never appear. Unused, those two collapse to icon-only (no
                                label, tighter padding) so having two permanent pills instead of one
                                doesn't bulk out the row - they expand to a normal labeled pill the
                                moment someone actually reacts. */}
                            {presets.filter((react) => react.key === "fomo" || react.key === "dislike" || getReactionList(log, react.key).length > 0).map((react) => {
                              const reactorList = getReactionList(log, react.key);
                              const hasReacted = reactorList.includes(currentUser);
                              const count = reactorList.length;
                              const isAlwaysVisible = react.key === "fomo" || react.key === "dislike";
                              const isIdle = isAlwaysVisible && count === 0;

                              return (
                                <div key={react.key} className="relative group shrink-0">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      handleReact(log.id, react.key);
                                    }}
                                    title={isIdle ? react.label : undefined}
                                    className={`flex items-center gap-1 rounded-full text-[9px] font-extrabold border transition-all duration-150 active:scale-95 hover:scale-105 cursor-pointer select-none ${
                                      isIdle ? "py-0.5 px-1.5" : "py-0.5 px-2"
                                    } ${
                                      hasReacted
                                        ? `${react.activeClass} font-black`
                                        : react.unselectedClass
                                    }`}
                                  >
                                    <span className="text-[11px]">{react.emoji}</span>
                                    {!isIdle && <span className="text-[9px] font-bold">{react.label}</span>}
                                    {count > 0 && (
                                      <span className={`ml-0.5 px-1 py-0.5 rounded-full text-[8px] font-black leading-none ${
                                        hasReacted ? "bg-black/25 text-white" : "bg-black/10 dark:bg-white/10 text-current"
                                      }`}>
                                        {count}
                                      </span>
                                    )}
                                  </button>

                                  {/* Hover Tooltip showing who reacted */}
                                  {count > 0 && (
                                    <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 pointer-events-none transition-all duration-150 z-30 scale-95 group-hover:scale-100 flex flex-col items-center">
                                      <div className="bg-slate-900/95 text-white text-[10px] font-extrabold normal-case py-1.5 px-2.5 rounded-lg shadow-xl whitespace-nowrap border border-slate-800 flex flex-col gap-0.5 min-w-[120px] text-center">
                                        <span className="text-amber-400 font-black tracking-wider text-[8px] uppercase mb-0.5">{react.label}:</span>
                                        {reactorList.map((uname, idx) => {
                                          const uProfile = users.find(u => u.username === uname);
                                          return (
                                            <span key={idx} className="block text-slate-200">
                                              {uProfile?.realName ? `${uProfile.realName} (@${uname})` : `@${uname}`}
                                            </span>
                                          );
                                        })}
                                      </div>
                                      <div className="w-1.5 h-1.5 bg-slate-900 rotate-45 -mt-[3px] border-r border-b border-slate-800"></div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}

                            {/* Additional Custom Active Reactions */}
                            {customReactions.map(({ key, emoji, label, list }) => {
                              const hasReacted = list.includes(currentUser);
                              const theme = THEME_STYLES[getReactionTheme(key)];
                              return (
                                <div key={key} className="relative group shrink-0">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      handleReact(log.id, key);
                                    }}
                                    className={`flex items-center gap-1 py-0.5 px-2 rounded-full text-[9px] font-extrabold border transition-all duration-150 active:scale-95 hover:scale-105 cursor-pointer select-none ${
                                      hasReacted ? `${theme.active} font-black` : theme.unselected
                                    }`}
                                  >
                                    <span className="text-[11px]">{emoji}</span>
                                    <span className="text-[9px] font-bold">{label}</span>
                                    <span className={`ml-0.5 px-1 py-0.5 rounded-full text-[8px] font-black leading-none ${
                                      hasReacted ? "bg-black/25 text-white" : "bg-black/10 dark:bg-white/10 text-current"
                                    }`}>
                                      {list.length}
                                    </span>
                                  </button>

                                  {/* Hover Tooltip showing who reacted */}
                                  <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 pointer-events-none transition-all duration-150 z-30 scale-95 group-hover:scale-100 flex flex-col items-center">
                                    <div className="bg-slate-900/95 text-white text-[10px] font-extrabold normal-case py-1.5 px-2.5 rounded-lg shadow-xl whitespace-nowrap border border-slate-800 flex flex-col gap-0.5 min-w-[120px] text-center">
                                      <span className="text-amber-400 font-black tracking-wider text-[8px] uppercase mb-0.5">{label}:</span>
                                      {list.map((uname, idx) => {
                                        const uProfile = users.find(u => u.username === uname);
                                        return (
                                          <span key={idx} className="block text-slate-200">
                                            {uProfile?.realName ? `${uProfile.realName} (@${uname})` : `@${uname}`}
                                          </span>
                                        );
                                      })}
                                    </div>
                                    <div className="w-1.5 h-1.5 bg-slate-900 rotate-45 -mt-[3px] border-r border-b border-slate-800"></div>
                                  </div>
                                </div>
                              );
                            })}

                            {/* React Button - opens the tapback-style quick picker */}
                            <div className="relative shrink-0">
                              <button
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  if (activeReactionPicker?.logId === log.id) {
                                    setActiveReactionPicker(null);
                                  } else {
                                    setActiveReactionPicker({ logId: log.id, el: e.currentTarget });
                                  }
                                }}
                                onTouchStart={(e) => {
                                  e.stopPropagation();
                                }}
                                className={`flex items-center justify-center w-5 h-5 rounded-full border transition-all cursor-pointer ${
                                  activeReactionPicker?.logId === log.id
                                    ? "bg-amber-500 border-amber-500 text-white"
                                    : "border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 hover:text-amber-500"
                                }`}
                                title="React"
                              >
                                <Plus className="w-3 h-3" />
                              </button>

                              {activeReactionPicker?.logId === log.id && (
                                <ReactionPicker
                                  anchorEl={activeReactionPicker.el}
                                  onClose={() => setActiveReactionPicker(null)}
                                  onSelect={(value) => {
                                    handleReact(log.id, value);
                                    setActiveReactionPicker(null);
                                  }}
                                />
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Caption Block */}
                    {log.comment && (
                      <div className="bg-amber-500/10 dark:bg-amber-950/60 rounded-xl p-3 border-l-4 border-amber-500 border border-amber-500/20 dark:border-amber-700/50 shadow-2xs relative mt-3 transition-all">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className="text-[10px] font-extrabold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                            📝 Current Vibe
                          </span>
                        </div>
                        <p className="font-semibold text-slate-800 dark:text-slate-200 text-xs sm:text-sm leading-snug">
                          {renderTextWithMentions(log.comment, users, onViewProfileRequested)}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Interaction Footer */}
                  <div className="px-3 py-2 sm:px-5 sm:py-2.5 bg-slate-50/50 dark:bg-slate-900/50 border-t border-slate-150 dark:border-slate-800 flex items-center justify-between gap-2">
                    {/* Left: Comments Button */}
                    <div className="flex items-center shrink-0">
                      {(() => {
                        const hasComments = !!(log.comments && log.comments.length > 0);
                        const isExpanded = expandedComments[log.id] ?? hasComments;
                        return (
                          <button
                            onClick={() => toggleComments(log.id)}
                            className={`flex items-center gap-1.5 py-1 px-2.5 rounded-full text-[11px] font-extrabold border transition-all cursor-pointer ${
                              isExpanded
                                ? "bg-amber-100/80 border-amber-400 text-amber-900 shadow-xs"
                                : hasComments
                                ? "bg-amber-50/60 hover:bg-amber-50 border-amber-200 text-amber-850"
                                : "bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-800"
                            }`}
                          >
                            <MessageSquare className={`w-3.5 h-3.5 ${isExpanded || hasComments ? "text-amber-500 fill-amber-500" : "text-slate-500"}`} />
                            <span className="hidden sm:inline">Comments</span>
                            <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-extrabold ${isExpanded || hasComments ? "bg-amber-200/80 text-amber-900" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"}`}>
                              {log.comments?.length || 0}
                            </span>
                          </button>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Comments Section */}
                  <AnimatePresence>
                    {(expandedComments[log.id] ?? !!(log.comments && log.comments.length > 0)) && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="comment-container"
                      >
                        <div className="p-4 space-y-4">
                          {/* List of comments */}
                          {log.comments && log.comments.length > 0 ? (
                            <div className="space-y-3 max-h-60 overflow-y-auto pr-1">
                              {log.comments.map((cmt) => (
                                <div key={cmt.id} className="flex gap-2.5 items-start">
                                  <div 
                                    className="cursor-pointer hover:opacity-80 transition-opacity shrink-0"
                                    onClick={() => onViewProfileRequested?.(cmt.user)}
                                  >
                                    <UserAvatar username={cmt.user} users={users} className="w-6 h-6 text-[10px] rounded-lg" />
                                  </div>
                                  <div className="flex-1 comment-bubble min-w-0">
                                    <div className="flex items-center justify-between gap-1.5">
                                      <div className="flex items-center gap-1.5 min-w-0">
                                        <span 
                                          className="comment-username hover:underline cursor-pointer truncate"
                                          onClick={() => onViewProfileRequested?.(cmt.user)}
                                        >
                                          {cmt.user}
                                        </span>
                                        <span className="text-[9px] text-slate-400 dark:text-slate-500 font-semibold shrink-0">
                                          {formatBeerDate(cmt.date)}
                                        </span>
                                      </div>

                                      <div className="flex items-center gap-1 shrink-0">
                                        {/* Thumbs up & Thumbs down in top right */}
                                        {[
                                          { emoji: "👍", label: "Like" },
                                          { emoji: "👎", label: "Dislike" },
                                        ].map(({ emoji, label }) => {
                                          const userList = cmt.reactions?.[emoji] || [];
                                          const hasReacted = userList.includes(currentUser);
                                          return (
                                            <button
                                              key={emoji}
                                              type="button"
                                              onClick={() => handleToggleCommentReaction(log.id, cmt.id, emoji)}
                                              title={
                                                userList.length > 0
                                                  ? `${label}: ${userList.join(", ")}`
                                                  : `React with ${label}`
                                              }
                                              className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium transition-all flex items-center gap-0.5 border select-none ${
                                                hasReacted
                                                  ? "bg-amber-100 dark:bg-amber-900/50 border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-100 font-bold shadow-2xs"
                                                  : "bg-slate-50 dark:bg-slate-800/60 border-slate-200/60 dark:border-slate-700/60 text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700/80 hover:text-slate-600 dark:hover:text-slate-300"
                                              }`}
                                            >
                                              <span className="leading-none text-[11px]">{emoji}</span>
                                              {userList.length > 0 && (
                                                <span className="text-[9px] font-extrabold">{userList.length}</span>
                                              )}
                                            </button>
                                          );
                                        })}

                                        {(isSeymoreBeers(currentUser) || cmt.user.toLowerCase() === currentUser.toLowerCase()) && (
                                          <button
                                            onClick={() => handleDeleteComment(log.id, cmt.id)}
                                            className="text-slate-400 hover:text-red-500 p-0.5 rounded transition-all focus:outline-none ml-0.5"
                                            title="Delete comment"
                                          >
                                            <Trash2 className="w-3 h-3" />
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                    <p className="comment-body break-words mt-0.5">
                                      {renderTextWithMentions(cmt.text, users, onViewProfileRequested)}
                                    </p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-[11px] text-slate-400 italic text-center py-2">No comments yet. Write something friendly below!</p>
                          )}

                          {/* Write comment box */}
                          <CommentInput
                            logId={log.id}
                            users={users}
                            currentUser={currentUser}
                            onLogUpdated={onLogUpdated}
                            onViewProfileRequested={onViewProfileRequested}
                          />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })
          )}
        </AnimatePresence>

        {hasMore && onLoadMore && (
          <div className="mt-8 flex justify-center pb-4">
            <button
              onClick={onLoadMore}
              disabled={loadingMore}
              className="px-6 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-amber-400 dark:hover:border-amber-500 hover:text-amber-500 rounded-xl text-xs font-extrabold text-slate-600 dark:text-slate-300 transition-all shadow-sm hover:shadow active:scale-[0.98] flex items-center gap-2 disabled:opacity-50"
            >
              {loadingMore ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin text-amber-500" />
                  <span>Fetching older pints...</span>
                </>
              ) : (
                <span>Load More Pints 🍻</span>
              )}
            </button>
          </div>
        )}
      </div>

      <AnimatePresence>
        {logToDelete && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 max-w-sm w-full text-center space-y-4"
            >
              <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto text-red-600">
                <Trash2 className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 className="font-extrabold text-slate-800 text-lg">Are you sure?</h3>
                <p className="text-xs text-slate-500 leading-relaxed font-medium">
                  This action cannot be undone. Are you sure you want to delete this pint check-in?
                </p>
              </div>
              <div className="flex gap-2.5 pt-2">
                <button
                  onClick={() => setLogToDelete(null)}
                  className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold py-2 rounded-lg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    onLogDeleted(logToDelete);
                    setLogToDelete(null);
                  }}
                  className="flex-1 bg-red-500 hover:bg-red-600 text-white text-xs font-bold py-2 rounded-lg transition-colors cursor-pointer"
                >
                  Delete Log
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
