import React, { useState, useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Users, Plus, Trash2, LogOut, Check, Shield, AlertCircle,
  Sparkles, Edit2, Image, Smile, Send, UserPlus, X,
  Trophy, Award, Zap, Moon, Coffee, Crown, ArrowLeft, TrendingUp,
  Beer, Star, Calendar, ChevronRight, ChevronDown, Pin, Filter, BarChart3, LineChart as LineChartIcon,
  MessageSquare, Flame, Settings2, Gauge, Target, Lock, Globe
} from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend
} from "recharts";
import { Pub, UserProfile, BeerLog, PubChatMessage, PubWidgetConfig } from "../types";
import { getMostDrankBeerForUser, isImposterLog, isUnspecifiedBeerName, useRetryImage } from "../utils";
import UserAvatar from "./UserAvatar";

function isEmblemUrl(str: string | undefined): boolean {
  if (!str) return false;
  return str.startsWith("http://") || str.startsWith("https://") || str.startsWith("/") || str.startsWith("data:image");
}

// Color scheme for the semicircle gauge widgets (Beverage/ABV/Rating gauges), keyed by
// widget type so each one's gradient direction actually means something instead of the
// same flat gray-to-gold dial regardless of what's being measured: ABV runs cool-to-hot
// (light beer -> heavy hitter), Rating runs bad-to-great, Beverage-match just runs
// gray-to-gold since "more of this specific drink" has no inherent good/bad direction.
function getGaugeTheme(widgetType: string, percent: number): { stops: [string, string, string]; zoneColor: string } {
  const stops: [string, string, string] =
    widgetType === "abv-gauge"
      ? ["#38bdf8", "#f59e0b", "#ef4444"]
      : widgetType === "rating-gauge"
        ? ["#ef4444", "#f59e0b", "#10b981"]
        : ["#64748b", "#d97706", "#fbbf24"];
  const zoneColor = percent < 34 ? stops[0] : percent < 67 ? stops[1] : stops[2];
  return { stops, zoneColor };
}

// A plain function called once per pub in a roster/carousel can't call useRetryImage
// itself without breaking the Rules of Hooks (each call site needs its own hook
// instance) - this small component is that instance.
function PubEmblem({ emblem, sizeClass = "w-9 h-9 text-xl" }: { emblem: string | undefined; sizeClass?: string }) {
  const isImg = isEmblemUrl(emblem);
  const { src, failed, onError, retryKey } = useRetryImage(isImg ? emblem : undefined);

  if (!emblem) return <span className="shrink-0 text-lg">🍺</span>;
  if (!isImg) return <span className="shrink-0 text-xl align-middle">{emblem}</span>;
  if (!src || failed) return <span className="shrink-0 text-xl align-middle">🍺</span>;

  return (
    <img
      key={retryKey}
      src={src}
      alt="Pub Emblem"
      className={`${sizeClass} rounded-xl object-cover shrink-0 align-middle shadow-sm border border-slate-200/50 dark:border-slate-800/80`}
      referrerPolicy="no-referrer"
      onError={onError}
    />
  );
}

interface PubHubProps {
  currentUser: string;
  users: UserProfile[];
  pubs: Pub[];
  logs: BeerLog[];
  selectedPubId?: string;
  onPubSelect?: (pubId: string) => void;
  pinnedPubId?: string;
  onPinPub?: (pubId: string) => void;
  onPubCreated: (newPub: Pub) => void;
  onPubUpdated: (updatedPub: Pub) => void;
  onPubDeleted: (pubId: string) => void;
  onViewProfileRequested?: (username: string) => void;
}

const MEMBER_COLORS = [
  "#f59e0b", // Amber
  "#3b82f6", // Blue
  "#10b981", // Emerald
  "#f43f5e", // Rose
  "#8b5cf6", // Purple
  "#06b6d4", // Cyan
  "#ec4899", // Pink
  "#84cc16", // Lime
  "#eab308", // Yellow
  "#6366f1", // Indigo
];

interface PubChatSectionProps {
  pubId: string;
  pubName: string;
  pubOwner: string;
  currentUser: string;
  users: UserProfile[];
  onViewProfileRequested?: (username: string) => void;
  messageRefreshKey?: number;
}

// "How are you getting here?" reactions for beacon calls - keys match what the server
// maps to a friendly label for notifications. Horse fits the Lord of the Rings "the
// beacons are lit" reference the whole feature is already named after.
const BEACON_TRAVEL_REACTIONS: { key: string; emoji: string; label: string }[] = [
  { key: "horse", emoji: "🐎", label: "Horse" },
  { key: "car", emoji: "🚗", label: "Driving" },
  { key: "bus", emoji: "🚌", label: "Bus" },
  { key: "taxi", emoji: "🚕", label: "Taxi" },
  { key: "bike", emoji: "🚲", label: "Bike" },
  { key: "running", emoji: "🏃", label: "Running" },
  { key: "walking", emoji: "🚶", label: "Walking" },
  { key: "flying", emoji: "✈️", label: "Flying" },
  { key: "here", emoji: "📍", label: "Already Here" },
  { key: "cant_make_it", emoji: "❌", label: "Can't Make It" },
];

// Renders a chat message as one big standalone emoji instead of a normal text
// bubble - covers both the beacon "how are you getting here" picker below and
// anyone just typing a bare emoji into chat.
const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}‍️\s]+$/u;
function isEmojiOnlyText(text: string | undefined): boolean {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  return EMOJI_ONLY_RE.test(trimmed);
}

function PubChatSection({
  pubId,
  pubName,
  pubOwner,
  currentUser,
  users,
  onViewProfileRequested,
  messageRefreshKey
}: PubChatSectionProps) {
  const [messages, setMessages] = useState<PubChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [openPickerMsgId, setOpenPickerMsgId] = useState<string | null>(null);
  const chatContainerRef = React.useRef<HTMLDivElement | null>(null);

  const fetchMessages = async () => {
    if (!pubId) return;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`/api/pubs/${encodeURIComponent(pubId)}/messages`, {
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setMessages(data);
        }
      }
    } catch (e) {
      console.warn("Could not fetch pub messages:", e);
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMessages();
    const interval = setInterval(fetchMessages, 4000);
    return () => clearInterval(interval);
  }, [pubId, messageRefreshKey]);

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages.length]);

  const handleSendMessage = async (e?: React.FormEvent, customText?: string) => {
    if (e) e.preventDefault();
    const textToSend = (customText || inputText).trim();
    if (!textToSend || sending) return;

    if (!customText) setInputText("");
    setSending(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(`/api/pubs/${encodeURIComponent(pubId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: currentUser, username: currentUser, text: textToSend }),
        signal: controller.signal,
      });
      if (res.ok) {
        const newMsg = await res.json();
        setMessages(prev => [...prev, newMsg]);
      }
    } catch (err) {
      console.error("Failed to send pub message:", err);
    } finally {
      clearTimeout(timeoutId);
      setSending(false);
    }
  };

  // Sends a beacon travel-emoji pick as its own big standalone chat message,
  // rather than a reaction tucked under the original beacon call.
  const handleSendEmojiReply = (emoji: string) => {
    setOpenPickerMsgId(null);
    handleSendMessage(undefined, emoji);
  };

  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs p-4 sm:p-5 space-y-4">
      {/* Chat Header */}
      <div className="border-b border-slate-100 dark:border-slate-800 pb-3 flex justify-between items-center">
        <div>
          <h3 className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-slate-100 tracking-tight flex items-center gap-1.5">
            <MessageSquare className="w-4 h-4 text-amber-500" />
            {pubName} Banter & Chat
          </h3>
          <p className="text-[10px] sm:text-[11px] text-slate-400 mt-0.5">Live member chat & session banter</p>
        </div>
        <span className="text-[9px] sm:text-[10px] text-amber-600 dark:text-amber-400 font-extrabold bg-amber-50 dark:bg-amber-500/10 border border-amber-200/60 dark:border-amber-500/20 px-2.5 py-1 rounded-full uppercase tracking-wider flex items-center gap-1 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
        </span>
      </div>

      {/* Messages List Area */}
      <div ref={chatContainerRef} className="bg-slate-950 rounded-xl p-3.5 sm:p-4 min-h-[200px] max-h-[340px] overflow-y-auto space-y-3 border border-slate-800 custom-scrollbar">
        {loading ? (
          <div className="py-12 text-center text-slate-500 text-xs italic">Loading pub chat...</div>
        ) : messages.length === 0 ? (
          <div className="py-12 text-center text-slate-400 text-xs space-y-2">
            <p className="text-2xl">🍻</p>
            <p className="font-bold text-slate-300">No chat messages in this pub yet!</p>
            <p className="text-[11px] text-slate-500">Break the ice and start the banter with your mates.</p>
          </div>
        ) : (
          messages.map(msg => {
            const isMe = msg.user.toLowerCase() === currentUser.toLowerCase();
            const isOwner = msg.user.toLowerCase() === pubOwner.toLowerCase();
            const timeStr = msg.date ? new Date(msg.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
            const isBeaconMsg = msg.text?.includes("BEACONS ARE LIT");

            return (
              <div
                key={msg.id}
                className={`flex gap-2.5 items-start ${isMe ? "flex-row-reverse" : "flex-row"}`}
              >
                <div
                  className="cursor-pointer shrink-0 mt-0.5"
                  onClick={() => onViewProfileRequested?.(msg.user)}
                >
                  <UserAvatar username={msg.user} users={users} className="w-7 h-7 sm:w-8 sm:h-8 text-xs" />
                </div>

                <div className={`max-w-[85%] space-y-1 ${isMe ? "items-end text-right" : "items-start"}`}>
                  <div className={`flex items-center gap-1.5 text-[10px] ${isMe ? "justify-end text-slate-400" : "text-slate-400"}`}>
                    <span
                      onClick={() => onViewProfileRequested?.(msg.user)}
                      className="font-extrabold text-slate-300 hover:text-amber-400 hover:underline cursor-pointer flex items-center gap-1"
                    >
                      @{msg.user}
                      {isOwner && <Shield className="w-3 h-3 text-amber-400" title="Host" />}
                    </span>
                    <span>•</span>
                    <span className="text-[9px] text-slate-500">{timeStr}</span>
                  </div>

                  {isEmojiOnlyText(msg.text) ? (
                    <div className="text-4xl sm:text-5xl leading-none px-0.5">
                      {msg.text}
                    </div>
                  ) : (
                    <div
                      className={`px-3 py-2 sm:px-3.5 sm:py-2.5 rounded-2xl text-xs sm:text-sm font-semibold leading-relaxed break-words shadow-xs ${
                        isMe
                          ? "bg-amber-500 text-slate-950 rounded-tr-none"
                          : "bg-slate-800/90 text-slate-100 border border-slate-700/80 rounded-tl-none"
                      }`}
                    >
                      {msg.text}
                    </div>
                  )}

                  {isBeaconMsg && (
                    <div className={`relative flex ${isMe ? "justify-end" : "justify-start"}`}>
                      <button
                        type="button"
                        onClick={() => setOpenPickerMsgId(openPickerMsgId === msg.id ? null : msg.id)}
                        className="px-2 py-1 rounded-full bg-slate-800/60 border border-slate-700 text-slate-300 hover:text-amber-400 hover:border-amber-500/50 text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer"
                      >
                        <Smile className="w-3 h-3" />
                        I'm coming...
                      </button>

                      {openPickerMsgId === msg.id && (
                        <div
                          className={`absolute bottom-full mb-2 ${isMe ? "right-0" : "left-0"} z-20 grid grid-cols-5 gap-1 p-2 bg-slate-800 border border-slate-700 rounded-xl shadow-lg w-[210px]`}
                        >
                          {BEACON_TRAVEL_REACTIONS.map((r) => (
                            <button
                              key={r.key}
                              type="button"
                              onClick={() => handleSendEmojiReply(r.emoji)}
                              title={r.label}
                              className="w-8 h-8 rounded-lg text-lg flex items-center justify-center hover:bg-slate-700/70 transition-all cursor-pointer"
                            >
                              {r.emoji}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Input Box */}
      <form onSubmit={handleSendMessage} className="flex gap-2 items-center">
        <input
          type="text"
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          placeholder={`Say something in ${pubName}...`}
          className="flex-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 focus:border-amber-500 focus:bg-white dark:focus:bg-slate-900 text-slate-900 dark:text-slate-100 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm font-medium outline-hidden transition-all placeholder:text-slate-400"
        />
        <button
          type="submit"
          disabled={!inputText.trim() || sending}
          className="px-4 py-2.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl shadow-xs transition-all flex items-center gap-1.5 shrink-0 cursor-pointer active:scale-95 min-h-[40px]"
        >
          <Send className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Send</span>
        </button>
      </form>
    </div>
  );
}

export default function PubHub({
  currentUser,
  users,
  pubs,
  logs,
  selectedPubId,
  onPubSelect,
  pinnedPubId,
  onPinPub,
  onPubCreated,
  onPubUpdated,
  onPubDeleted,
  onViewProfileRequested
}: PubHubProps) {
  const [newPubName, setNewPubName] = useState("");
  const [newPubIsPrivate, setNewPubIsPrivate] = useState(false);
  const [selectedInvitees, setSelectedInvitees] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showRoster, setShowRoster] = useState<Record<string, boolean>>({});
  const [allBeers, setAllBeers] = useState<BeerLog[]>([]);
  const [loadingBeers, setLoadingBeers] = useState(false);

  // Pub timeframe filter state. Defaults to whichever window actually has
  // check-ins (Week -> Month -> Year -> All) so quiet pubs don't land on an
  // empty "no check-ins this week" state; a manual pill click locks it until
  // the user switches pubs.
  const [superlativeTimeframe, setSuperlativeTimeframe] = useState<"7d" | "30d" | "year" | "all">("7d");
  const [superlativeTimeframeLocked, setSuperlativeTimeframeLocked] = useState(false);
  const lastAutoTimeframePubIdRef = useRef<string | null>(null);

  const selectSuperlativeTimeframe = (tf: "7d" | "30d" | "year" | "all") => {
    setSuperlativeTimeframe(tf);
    setSuperlativeTimeframeLocked(true);
  };

  const fetchAllBeers = async (retries = 2) => {
    setLoadingBeers(true);
    try {
      // Zero client Firestore reads: fetched from backend cached endpoint
      const res = await fetch("/api/leaderboard-beers");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setAllBeers(data);
          return;
        }
      }
      setAllBeers(logs || []);
    } catch (e) {
      if (retries > 0) {
        setTimeout(() => fetchAllBeers(retries - 1), 1000);
        return;
      }
      console.warn("Could not fetch all beers for PubHub, using live logs fallback:", e);
      setAllBeers(logs || []);
    } finally {
      setLoadingBeers(false);
    }
  };

  useEffect(() => {
    fetchAllBeers();
  }, [pubs]);

  // Combine server allBeers with any real-time live logs passed via prop
  const combinedLogs = useMemo(() => {
    const map = new Map<string, BeerLog>();
    if (allBeers && allBeers.length > 0) {
      allBeers.forEach(b => {
        if (b && b.id) map.set(b.id, b);
      });
    }
    if (logs && logs.length > 0) {
      logs.forEach(b => {
        if (b && b.id) map.set(b.id, b);
      });
    }
    const list = Array.from(map.values());
    list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return list;
  }, [allBeers, logs]);

  // Emblem state for creation
  const [newPubEmblemType, setNewPubEmblemType] = useState<"emoji" | "url">("emoji");
  const [newPubEmoji, setNewPubEmoji] = useState("🍺");
  const [newPubUrl, setNewPubUrl] = useState("");

  // Edit pub state
  const [editingPubId, setEditingPubId] = useState<string | null>(null);
  const [editPubName, setEditPubName] = useState("");
  const [editPubEmblemType, setEditPubEmblemType] = useState<"emoji" | "url">("emoji");
  const [editPubEmoji, setEditPubEmoji] = useState("🍺");
  const [editPubUrl, setEditPubUrl] = useState("");
  const [editPubIsPrivate, setEditPubIsPrivate] = useState(false);

  // Invite people state inside an existing pub
  const [invitingPubId, setInvitingPubId] = useState<string | null>(null);
  const [additionalInvitees, setAdditionalInvitees] = useState<string[]>([]);

  // Rally launch station state
  const [showBeaconModal, setShowBeaconModal] = useState(false);
  const [beaconBarName, setBeaconBarName] = useState("");
  const [beaconError, setBeaconError] = useState("");
  const [beaconInvitees, setBeaconInvitees] = useState<string[]>([]);
  const [rallySending, setRallySending] = useState(false);
  const [rallySentNotice, setRallySentNotice] = useState<string | null>(null);
  const [chatRefreshKey, setChatRefreshKey] = useState(0);

  // Banter & Chat is minimized to a collapsible strip (Widgets/Superlatives
  // are the primary tabs now). A one-shot fetch keeps a lightweight preview
  // of the latest message without running the full chat's polling loop
  // until the user actually expands it.
  const [chatExpanded, setChatExpanded] = useState(false);
  const [latestPubMessage, setLatestPubMessage] = useState<PubChatMessage | null>(null);

  // Customizable Awards-tab widgets state
  const [showWidgetModal, setShowWidgetModal] = useState(false);
  const [draftWidgets, setDraftWidgets] = useState<PubWidgetConfig[]>([]);
  const [newBeverageKeyword, setNewBeverageKeyword] = useState("");
  const [widgetSaving, setWidgetSaving] = useState(false);
  const [widgetError, setWidgetError] = useState("");

  const toggleBeaconInvitee = (username: string) => {
    setBeaconInvitees((prev) =>
      prev.includes(username) ? prev.filter((u) => u !== username) : [...prev, username]
    );
  };

  const handleTriggerRally = async (pubId: string, barName: string) => {
    const trimmedBar = barName.trim();
    if (rallySending || !trimmedBar) return;
    setRallySending(true);
    try {
      const pubName = activePub?.name || "the Pub";
      const rallyText = `🔥 THE BEACONS ARE LIT AT ${trimmedBar.toUpperCase()}! 🔥 @${currentUser} has lit the beacons at ${trimmedBar} for @${pubName}! Pints call for aid! Who will answer? 🍺⚔️🏃‍♂️💨`;
      const res = await fetch(`/api/pubs/${encodeURIComponent(pubId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: currentUser, username: currentUser, text: rallyText, targetUsernames: beaconInvitees })
      });
      if (res.ok) {
        setRallySentNotice(trimmedBar);
        setShowBeaconModal(false);
        setBeaconBarName("");
        setBeaconError("");
        setBeaconInvitees([]);
        setChatRefreshKey(prev => prev + 1);
        setChatExpanded(true);
        setTimeout(() => setRallySentNotice(null), 6000);
      }
    } catch (e) {
      console.error("Failed to trigger pub rally:", e);
    } finally {
      setRallySending(false);
    }
  };

  const userLower = useMemo(() => (currentUser || "").toLowerCase().trim(), [currentUser]);

  // Derived pub state
  const myPubs = useMemo(() => pubs.filter(p => p.members.some(m => m.toLowerCase().trim() === userLower)), [pubs, userLower]);
  const myInvites = useMemo(() => pubs.filter(p => p.invited.some(m => m.toLowerCase().trim() === userLower)), [pubs, userLower]);
  const otherPubs = useMemo(() => pubs.filter(p => !p.members.some(m => m.toLowerCase().trim() === userLower)), [pubs, userLower]);
  const otherUsers = useMemo(() => users.filter(u => u.username.toLowerCase().trim() !== userLower), [users, userLower]);

  // Default pub ID if no specific selection is active
  const defaultPubId = useMemo(() => {
    if (pinnedPubId && pubs.some(p => p.id === pinnedPubId)) {
      return pinnedPubId;
    }
    if (myPubs.length > 0) {
      return myPubs[0].id;
    }
    if (pubs.length > 0) {
      return pubs[0].id;
    }
    return "";
  }, [pinnedPubId, myPubs, pubs]);

  // Local selection override state
  const [localPubId, setLocalPubId] = useState<string | null>(null);
  
  // Mobile-first active tab state. Chat lives in its own collapsible strip
  // now, so the tabs are just Widgets (default, most prominent) and
  // Superlatives.
  const [activeTab, setActiveTab] = useState<"widgets" | "superlatives">("widgets");

  // Current week number for weekly rotating superlatives
  const currentWeekNum = useMemo(() => {
    const d = new Date();
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }, []);

  // Active Pub ID
  const activePubId = useMemo(() => {
    if (localPubId && pubs.some(p => p.id === localPubId)) {
      return localPubId;
    }
    if (selectedPubId && pubs.some(p => p.id === selectedPubId)) {
      return selectedPubId;
    }
    return defaultPubId;
  }, [localPubId, selectedPubId, pubs, defaultPubId]);

  const activePub = useMemo(() => {
    return pubs.find(p => p.id === activePubId);
  }, [pubs, activePubId]);

  useEffect(() => {
    if (!activePubId) {
      setLatestPubMessage(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/pubs/${encodeURIComponent(activePubId)}/messages`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: PubChatMessage[]) => {
        if (cancelled) return;
        setLatestPubMessage(Array.isArray(data) && data.length > 0 ? data[data.length - 1] : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activePubId, chatRefreshKey]);

  // Who can be rallied: current pub members plus the caller's own friends, so a
  // beacon can invite people out even if they haven't joined this Pub group yet.
  const rallyCandidates = useMemo(() => {
    if (!activePub) return [] as string[];
    const myFriends = users.find((u) => u.username === currentUser)?.friends || [];
    const combined = new Set([...activePub.members, ...myFriends]);
    combined.delete(currentUser);
    return Array.from(combined).sort((a, b) => a.localeCompare(b));
  }, [activePub, users, currentUser]);

  const handleSelectPub = (id: string) => {
    setLocalPubId(id);
    onPubSelect?.(id);
  };

  const isUrl = (str: string) => {
    if (!str) return false;
    return str.startsWith("http://") || str.startsWith("https://") || str.startsWith("/") || str.startsWith("data:image");
  };

  const startEditing = (pub: Pub) => {
    setEditingPubId(pub.id);
    setEditPubName(pub.name);
    setEditPubIsPrivate(!!pub.isPrivate);
    if (pub.emblem && isUrl(pub.emblem)) {
      setEditPubEmblemType("url");
      setEditPubUrl(pub.emblem);
      setEditPubEmoji("🍺");
    } else {
      setEditPubEmblemType("emoji");
      setEditPubEmoji(pub.emblem || "🍺");
      setEditPubUrl("");
    }
  };

  const handleUpdatePub = async (pubId: string) => {
    setError(null);
    setSuccess(null);
    if (!editPubName.trim()) {
      setError("Pub name cannot be empty.");
      return;
    }
    const emblem = editPubEmblemType === "emoji" ? editPubEmoji : editPubUrl.trim();
    setSubmitting(true);
    try {
      const currentPub = pubs.find(p => p.id === pubId);
      if (!currentPub) throw new Error("Pub not found.");

      const response = await fetch("/api/pubs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: pubId,
          name: editPubName.trim(),
          emblem,
          isPrivate: editPubIsPrivate,
          owner: currentPub.owner,
          currentUser
        })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || "Could not update pub details.");
      }
      const updatedPub: Pub = await response.json();
      onPubUpdated(updatedPub);
      setSuccess("Pub updated successfully!");
      setEditingPubId(null);
    } catch (err: any) {
      setError(err.message || "An error occurred.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreatePub = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!newPubName.trim()) {
      setError("Please enter a pub name.");
      return;
    }

    const emblem = newPubEmblemType === "emoji" ? newPubEmoji : newPubUrl.trim();
    setSubmitting(true);
    try {
      const response = await fetch("/api/pubs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name: newPubName.trim(),
          emblem,
          owner: currentUser,
          invited: selectedInvitees,
          isPrivate: newPubIsPrivate
        })
      });

      if (!response.ok) throw new Error("Failed to establish pub.");

      const newPub: Pub = await response.json();
      onPubCreated(newPub);
      setSuccess(`Pub "${newPub.name}" established successfully!`);
      setNewPubName("");
      setSelectedInvitees([]);
      setNewPubUrl("");
      setNewPubIsPrivate(false);
      setShowCreateModal(false);
    } catch (err: any) {
      setError(err.message || "An error occurred while establishing pub.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoinPub = async (pubId: string) => {
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/pubs/${pubId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: currentUser })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || "Could not join pub.");
      }
      const updatedPub: Pub = await response.json();
      onPubUpdated(updatedPub);
      setSuccess(`Joined "${updatedPub.name}"!`);
    } catch (err: any) {
      setError(err.message || "An error occurred.");
    }
  };

  const handleDeclinePubInvite = async (pubId: string) => {
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/pubs/${pubId}/decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: currentUser })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || "Could not decline invite.");
      }
      const updatedPub: Pub = await response.json();
      onPubUpdated(updatedPub);
      setSuccess(`Declined invite to "${updatedPub.name}".`);
    } catch (err: any) {
      setError(err.message || "An error occurred.");
    }
  };

  const handleLeavePub = async (pubId: string) => {
    if (!window.confirm("Are you sure you want to leave this pub?")) return;
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/pubs/${pubId}/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: currentUser })
      });

      if (!response.ok) throw new Error("Could not leave pub.");
      const updatedPub: Pub = await response.json();
      onPubUpdated(updatedPub);
      setSuccess("You left the pub.");
      if (localPubId === pubId) setLocalPubId(null);
    } catch (err: any) {
      setError(err.message || "An error occurred.");
    }
  };

  const handleDeletePub = async (pubId: string) => {
    if (!window.confirm("Are you sure you want to disband this pub? This action cannot be undone.")) return;
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/pubs/${pubId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: currentUser })
      });

      if (!response.ok) throw new Error("Could not disband pub.");
      onPubDeleted(pubId);
      setSuccess("Pub successfully disbanded.");
      if (localPubId === pubId) setLocalPubId(null);
    } catch (err: any) {
      setError(err.message || "An error occurred.");
    }
  };

  const handleSendInvitations = async (pubId: string) => {
    if (additionalInvitees.length === 0) return;
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/pubs/${pubId}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitees: additionalInvitees, sender: currentUser })
      });

      if (!response.ok) throw new Error("Could not send invitations.");
      const updatedPub: Pub = await response.json();
      onPubUpdated(updatedPub);
      setSuccess(`Invites sent successfully!`);
      setInvitingPubId(null);
      setAdditionalInvitees([]);
    } catch (err: any) {
      setError(err.message || "An error occurred.");
    }
  };

  const toggleInvitee = (username: string) => {
    setSelectedInvitees(prev => 
      prev.includes(username) ? prev.filter(u => u !== username) : [...prev, username]
    );
  };

  const toggleAdditionalInvitee = (username: string) => {
    setAdditionalInvitees(prev => 
      prev.includes(username) ? prev.filter(u => u !== username) : [...prev, username]
    );
  };

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // PUB PAGE FILTERED DATA COMPUTATION
  // ---------------------------------------------------------------------------
  const activeMembers = useMemo(() => {
    if (activePub) return activePub.members;
    return [];
  }, [activePub]);

  const activePubFilteredLogs = useMemo(() => {
    if (!activePub) return [];
    const members = activePub.members;
    return combinedLogs.filter(log => members.includes(log.user) && !isImposterLog(log));
  }, [activePub, combinedLogs]);

  // ---------------------------------------------------------------------------
  // CUSTOMIZABLE AWARDS-TAB GAUGE WIDGETS
  // ---------------------------------------------------------------------------
  const DEFAULT_PUB_WIDGETS: PubWidgetConfig[] = [
    { id: "default-guinness", type: "beverage-gauge", label: "Is it a Guinness?", keyword: "guinness" },
  ];

  const WIDGET_CATALOG: { type: PubWidgetConfig["type"]; name: string; blurb: string; icon: typeof Beer }[] = [
    { type: "beverage-gauge", name: "Beverage Gauge", blurb: "% of pints matching a beer or style you pick", icon: Beer },
    { type: "abv-gauge", name: "ABV-O-Meter", blurb: "Average booze strength of pints logged here", icon: Gauge },
    { type: "rating-gauge", name: "Rating-O-Meter", blurb: "Average star rating of pints logged here", icon: Star },
    { type: "goblin-mode", name: "Goblin Clock", blurb: "24hr radial clock of check-in times, glowing after midnight", icon: Moon },
    { type: "dart-matrix", name: "Dart Matrix", blurb: "8-week heatmap of Dart Combo 🎯 activity", icon: Target },
  ];

  const activeWidgets: PubWidgetConfig[] = activePub?.widgets ?? DEFAULT_PUB_WIDGETS;

  const widgetSubtitle = (widget: PubWidgetConfig): string => {
    const pubName = activePub?.name || "this Pub";
    if (widget.type === "beverage-gauge") return `"${widget.keyword}" vs other pints logged in ${pubName}`;
    if (widget.type === "abv-gauge") return `Average ABV of pints logged in ${pubName}`;
    if (widget.type === "rating-gauge") return `Average star rating of pints logged in ${pubName}`;
    if (widget.type === "goblin-mode") return `When pints get logged around the clock in ${pubName}`;
    return `Dart Combo 🎯 activity over the last 8 weeks in ${pubName}`;
  };

  // Local-hour helper (mirrors server-side getLocalHour) for client-side chart bucketing
  const getLocalHourClient = (isoString: string, timezone?: string): number => {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return 0;
    if (!timezone) return d.getHours();
    try {
      const hourPart = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false })
        .formatToParts(d).find((p) => p.type === "hour")?.value;
      return hourPart ? parseInt(hourPart, 10) % 24 : d.getHours();
    } catch {
      return d.getHours();
    }
  };

  const computeGoblinClockData = () => {
    const logs = activePubFilteredLogs;
    const hourCounts = new Array(24).fill(0);
    logs.forEach((l) => {
      hourCounts[getLocalHourClient(l.date, l.timezone)]++;
    });
    const total = logs.length;
    const goblinCount = hourCounts.slice(0, 5).reduce((s, c) => s + c, 0); // 12AM-4:59AM
    const goblinPercent = total > 0 ? Math.round((goblinCount / total) * 100) : 0;
    const maxCount = Math.max(1, ...hourCounts);
    const ratingText =
      goblinPercent < 10 ? "😇 Mostly responsible o'clock. Rare late-night mischief." :
      goblinPercent < 30 ? "🌙 Some goblin tendencies creeping in after dark." :
      "👺 Full goblin infestation. The witching hours are thriving.";
    return { hourCounts, total, goblinCount, goblinPercent, maxCount, ratingText };
  };

  const computeDartMatrixData = () => {
    const logs = activePubFilteredLogs;
    const numWeeks = 8;
    const totalDays = numWeeks * 7;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayBuckets: { date: Date; count: number }[] = [];
    for (let i = totalDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dayBuckets.push({ date: d, count: 0 });
    }
    logs.forEach((l) => {
      if (!l.hadCig) return;
      const d = new Date(l.date);
      d.setHours(0, 0, 0, 0);
      const bucket = dayBuckets.find((b) => b.date.getTime() === d.getTime());
      if (bucket) bucket.count++;
    });
    const totalDarts = logs.filter((l) => l.hadCig).length;
    const total = logs.length;
    const dartPercent = total > 0 ? Math.round((totalDarts / total) * 100) : 0;
    const maxCount = Math.max(1, ...dayBuckets.map((b) => b.count));
    const weeks: { date: Date; count: number }[][] = [];
    for (let w = 0; w < numWeeks; w++) weeks.push(dayBuckets.slice(w * 7, w * 7 + 7));
    const ratingText =
      totalDarts === 0 ? "😇 No darts logged. Clean pours all around." :
      dartPercent < 15 ? "🎯 The occasional cheeky dart with a pint." :
      dartPercent < 35 ? "🎯 Dart Combo is a lifestyle around here." :
      "🔥 Dart Combos are basically the house special.";
    return { weeks, totalDarts, total, dartPercent, maxCount, ratingText };
  };

  const computeWidgetData = (widget: PubWidgetConfig) => {
    const logs = activePubFilteredLogs;
    const total = logs.length;

    if (widget.type === "abv-gauge") {
      const withAbv = logs.filter((l) => typeof l.abv === "number" && l.abv > 0);
      const avgAbv = withAbv.length ? withAbv.reduce((s, l) => s + l.abv, 0) / withAbv.length : 0;
      const percent = Math.max(0, Math.min(100, Math.round((avgAbv / 12) * 100)));
      const strongCount = withAbv.filter((l) => l.abv >= 7).length;
      const ratingText =
        avgAbv < 4 ? "🍃 Light and breezy sipping around here." :
        avgAbv < 7 ? "⚖️ Solidly middle-of-the-road strength." :
        "🔥 Heavy hitters only. Hydrate accordingly.";
      return {
        percent,
        bigNumber: `${avgAbv.toFixed(1)}%`,
        legendA: { label: "Strong (7%+ ABV)", stat: `${strongCount} pints`, swatchClass: "bg-red-500/70 border-2 border-red-700" },
        legendB: { label: "Sessionable (<7% ABV)", stat: `${withAbv.length - strongCount} pints`, swatchClass: "bg-sky-400/60 border-2 border-sky-600" },
        ratingText,
      };
    }

    if (widget.type === "rating-gauge") {
      const rated = logs.filter((l) => typeof l.rating === "number" && l.rating > 0);
      const avgRating = rated.length ? rated.reduce((s, l) => s + l.rating, 0) / rated.length : 0;
      const percent = Math.max(0, Math.min(100, Math.round((avgRating / 5) * 100)));
      const bangers = rated.filter((l) => l.rating >= 4).length;
      const ratingText =
        avgRating < 2.5 ? "😬 Rough batch of pours lately." :
        avgRating < 4 ? "⚖️ Respectable average, nothing legendary." :
        "🌟 A murderers' row of excellent pints.";
      return {
        percent,
        bigNumber: `${avgRating.toFixed(1)}★`,
        legendA: { label: "4★+ Bangers", stat: `${bangers} pints`, swatchClass: "bg-amber-400/80 border-2 border-amber-600" },
        legendB: { label: "Meh (<4★)", stat: `${rated.length - bangers} pints`, swatchClass: "bg-slate-400/50 border-2 border-slate-600" },
        ratingText,
      };
    }

    // beverage-gauge (default)
    const kw = (widget.keyword || "").toLowerCase().trim();
    const matchCount = kw
      ? logs.filter((l) => l.beerName?.toLowerCase().includes(kw) || l.beerStyle?.toLowerCase().includes(kw)).length
      : 0;
    const percent = total > 0 ? Math.round((matchCount / total) * 100) : 0;
    const ratingText =
      percent < 25 ? `🚨 Rare pour. Time to find some ${widget.keyword}.` :
      percent < 75 ? `⚖️ Decent showing of ${widget.keyword} around here.` :
      `✨ ${widget.keyword} everywhere! Living the dream.`;
    return {
      percent,
      bigNumber: `${percent}%`,
      legendA: { label: widget.keyword || "Match", stat: `${matchCount} (${percent}%)`, swatchClass: "bg-[#FDFBF7] border-2 border-[#C5A059]" },
      legendB: { label: `Not ${widget.keyword || "a match"}`, stat: `${total - matchCount} (${total > 0 ? 100 - percent : 0}%)`, swatchClass: "bg-[#7E7770] border-2 border-[#645F5A]" },
      ratingText,
    };
  };

  const openWidgetModal = () => {
    setDraftWidgets(activeWidgets);
    setNewBeverageKeyword("");
    setWidgetError("");
    setShowWidgetModal(true);
  };

  const addCatalogWidget = (type: PubWidgetConfig["type"]) => {
    if (draftWidgets.length >= 6) {
      setWidgetError("A Pub can have at most 6 widgets.");
      return;
    }
    if (type === "beverage-gauge") {
      const kw = newBeverageKeyword.trim();
      if (!kw) {
        setWidgetError("Type a beer or style to add a Beverage Gauge.");
        return;
      }
      setDraftWidgets((prev) => [...prev, { id: `widget-${Date.now()}`, type, label: `Is it a ${kw}?`, keyword: kw }]);
      setNewBeverageKeyword("");
      setWidgetError("");
      return;
    }
    if (draftWidgets.some((w) => w.type === type)) {
      setWidgetError("You already have one of those.");
      return;
    }
    const name = WIDGET_CATALOG.find((c) => c.type === type)?.name || "Widget";
    setDraftWidgets((prev) => [...prev, { id: `widget-${Date.now()}`, type, label: name }]);
    setWidgetError("");
  };

  const removeDraftWidget = (id: string) => {
    setDraftWidgets((prev) => prev.filter((w) => w.id !== id));
  };

  const handleSaveWidgets = async () => {
    if (!activePub) return;
    setWidgetSaving(true);
    setWidgetError("");
    try {
      const response = await fetch(`/api/pubs/${activePub.id}/widgets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentUser, widgets: draftWidgets }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Could not save widgets.");
      }
      const updatedPub: Pub = await response.json();
      onPubUpdated(updatedPub);
      setShowWidgetModal(false);
    } catch (err: any) {
      setWidgetError(err.message || "An error occurred.");
    } finally {
      setWidgetSaving(false);
    }
  };

  // Leaderboard ranking
  const pubLeaderboard = useMemo(() => {
    const members = activeMembers;
    const counts: Record<string, number> = {};
    members.forEach(m => counts[m] = 0);

    activePubFilteredLogs.forEach(log => {
      if (counts[log.user] !== undefined) {
        counts[log.user] += 1;
      }
    });

    return members
      .map(member => ({
        username: member,
        pints: counts[member] || 0,
        profile: users.find(u => u.username === member)
      }))
      .sort((a, b) => b.pints - a.pints);
  }, [activeMembers, activePubFilteredLogs, users]);

  // Timeframe-filtered logs for pub superlatives
  const superlativeFilteredLogs = useMemo(() => {
    if (!activePubFilteredLogs) return [];
    if (superlativeTimeframe === "all") return activePubFilteredLogs;

    const now = Date.now();
    let days = 7;
    if (superlativeTimeframe === "30d") days = 30;
    if (superlativeTimeframe === "year") days = 365;

    const cutoff = now - days * 24 * 60 * 60 * 1000;
    return activePubFilteredLogs.filter((l) => {
      const t = new Date(l.date).getTime();
      return !isNaN(t) && t >= cutoff;
    });
  }, [activePubFilteredLogs, superlativeTimeframe]);

  // Auto-pick the narrowest timeframe that actually has check-ins (Week ->
  // Month -> Year -> All) whenever the active pub changes, so quiet pubs
  // don't default to an empty "no check-ins this week" state. Stops once the
  // user manually picks a pill, and re-arms on the next pub switch.
  useEffect(() => {
    if (!activePub) return;
    if (lastAutoTimeframePubIdRef.current !== activePub.id) {
      lastAutoTimeframePubIdRef.current = activePub.id;
      setSuperlativeTimeframeLocked(false);
    }
  }, [activePub?.id]);

  useEffect(() => {
    if (!activePub || superlativeTimeframeLocked) return;
    const now = Date.now();
    const countInWindow = (days: number | null) => {
      if (days === null) return activePubFilteredLogs.length;
      const cutoff = now - days * 24 * 60 * 60 * 1000;
      return activePubFilteredLogs.filter((l) => {
        const t = new Date(l.date).getTime();
        return !isNaN(t) && t >= cutoff;
      }).length;
    };
    if (countInWindow(7) > 0) setSuperlativeTimeframe("7d");
    else if (countInWindow(30) > 0) setSuperlativeTimeframe("30d");
    else if (countInWindow(365) > 0) setSuperlativeTimeframe("year");
    else setSuperlativeTimeframe("all");
  }, [activePub, activePubFilteredLogs, superlativeTimeframeLocked]);

  // Dynamic Superlatives Computation with Weekly Rotation
  const pubSuperlatives = useMemo(() => {
    const members = activeMembers;
    if (members.length === 0) return null;

    const memberStats = members.map(member => {
      const mLogs = superlativeFilteredLogs.filter(l => l.user === member);
      const activeDates = new Set<string>();
      let totalDarts = 0;
      let lateNightCount = 0;
      let earlyCount = 0;
      let maxAbv = 0;
      let maxAbvBeer = "";
      let ratedLogsCount = 0;
      let sumRating = 0;
      let guinnessCount = 0;
      let cheersReceived = 0;
      const uniqueBeersSet = new Set<string>();
      const beerCounts: Record<string, number> = {};
      let topBeerName = "";
      let topBeerCount = 0;

      mLogs.forEach(log => {
        if (log.beerName) {
          const bName = log.beerName.trim();
          if (bName) {
            uniqueBeersSet.add(bName.toLowerCase());
            // "House Draft" (never filled in a beer name) shouldn't be able to win
            // Most Loyal just for being the most common non-answer.
            if (!isUnspecifiedBeerName(bName)) {
              beerCounts[bName] = (beerCounts[bName] || 0) + 1;
              if (beerCounts[bName] > topBeerCount) {
                topBeerCount = beerCounts[bName];
                topBeerName = bName;
              }
            }
          }
        }
        try {
          const d = new Date(log.date);
          if (!isNaN(d.getTime())) {
            activeDates.add(d.toISOString().split("T")[0]);
            // Use the poster's own local hour (captured at check-in time), not
            // the viewer's - a friend's 11pm pint should count as late-night
            // even if you're looking at it the next morning from another zone.
            let hour = d.getHours();
            if (log.timezone) {
              try {
                const hourPart = new Intl.DateTimeFormat("en-US", { timeZone: log.timezone, hour: "numeric", hour12: false }).formatToParts(d).find((p) => p.type === "hour")?.value;
                if (hourPart) hour = parseInt(hourPart, 10) % 24;
              } catch (e) {}
            }
            if (hour >= 22 || hour < 5) lateNightCount++;
            if (hour >= 10 && hour < 15) earlyCount++;
          }
        } catch (e) {}

        if (log.hadCig) totalDarts++;
        if (log.abv && log.abv > maxAbv) {
          maxAbv = log.abv;
          maxAbvBeer = log.beerName;
        }
        if (log.rating && log.rating > 0) {
          ratedLogsCount++;
          sumRating += log.rating;
        }
        if (
          log.beerName?.toLowerCase().includes("guinness") ||
          log.beerName?.toLowerCase().includes("stout") ||
          log.beerStyle?.toLowerCase().includes("stout")
        ) {
          guinnessCount++;
        }
        if (log.cheersCount) cheersReceived += log.cheersCount;
        if (log.cheersUsers) cheersReceived += log.cheersUsers.length;
      });

      const totalDaysInPeriod = superlativeTimeframe === "7d" ? 7 : (superlativeTimeframe === "30d" ? 30 : (superlativeTimeframe === "year" ? 365 : 30));
      const soberDays = Math.max(0, totalDaysInPeriod - activeDates.size);

      return {
        username: member,
        totalPints: mLogs.length,
        soberDays,
        activeDaysCount: activeDates.size,
        totalDarts,
        lateNightCount,
        earlyCount,
        maxAbv,
        maxAbvBeer,
        guinnessCount,
        cheersReceived,
        uniqueBeersCount: uniqueBeersSet.size,
        topBeerCount,
        topBeerName,
        avgRating: ratedLogsCount > 0 ? parseFloat((sumRating / ratedLogsCount).toFixed(1)) : 0
      };
    });

    const candidates = [
      {
        id: "landlord",
        title: "Stool Squatter 👑",
        tagline: "Claimed squatter's rights on Bar Stool #1",
        winner: [...memberStats].filter((m) => m.totalPints > 0).sort((a, b) => b.totalPints - a.totalPints)[0],
        getStatText: (w: typeof memberStats[0]) => `Poured ${w.totalPints} pints. Mail routed to the bar.`,
        getScore: (w: typeof memberStats[0]) => (w ? 100 + w.totalPints : 0),
        cardClass: "bg-amber-500/10 dark:bg-amber-500/15 border-amber-500/30",
        titleClass: "text-amber-900 dark:text-amber-300",
        badgeClass: "text-slate-800 dark:text-slate-200",
        IconComponent: Crown,
        iconClass: "text-amber-600 dark:text-amber-400",
        noStatText: "No pours logged yet",
      },
      {
        id: "nocturnal",
        title: "Goblin Mode 👺",
        tagline: "Prefers pub light to daylight",
        winner: [...memberStats].filter((m) => m.lateNightCount > 0).sort((a, b) => b.lateNightCount - a.lateNightCount)[0],
        getStatText: (w: typeof memberStats[0]) => `${w.lateNightCount} check-ins past 11 PM. Night shift, pub edition.`,
        getScore: (w: typeof memberStats[0]) => (w ? 95 + w.lateNightCount * 4 : 0),
        cardClass: "bg-purple-500/10 dark:bg-purple-950/30 border-purple-500/30",
        titleClass: "text-purple-900 dark:text-purple-300",
        badgeClass: "text-purple-800 dark:text-purple-200",
        IconComponent: Moon,
        iconClass: "text-purple-600 dark:text-purple-400",
        noStatText: "No late night logs",
      },
      {
        id: "boldpour",
        title: "Bold Pour Award ⚡",
        tagline: "Isn't afraid of a heavy-hitting craft beer",
        winner: [...memberStats].filter((m) => m.maxAbv > 0).sort((a, b) => b.maxAbv - a.maxAbv)[0],
        getStatText: (w: typeof memberStats[0]) => `${w.maxAbv}% ABV (${w.maxAbvBeer}). Bold choice!`,
        getScore: (w: typeof memberStats[0]) => (w ? 90 + w.maxAbv * 2 : 0),
        cardClass: "bg-rose-500/10 dark:bg-rose-950/30 border-rose-500/30",
        titleClass: "text-rose-900 dark:text-rose-300",
        badgeClass: "text-rose-800 dark:text-rose-200",
        IconComponent: Zap,
        iconClass: "text-rose-500",
        noStatText: "No high ABV logs",
      },
      {
        id: "stoutsiren",
        title: "Liquid Velvet Siren ☘️",
        tagline: "Blood type is currently 98% Guinness foam",
        winner: [...memberStats].filter((m) => m.guinnessCount > 0).sort((a, b) => b.guinnessCount - a.guinnessCount)[0],
        getStatText: (w: typeof memberStats[0]) => `${w.guinnessCount} creamy stouts. Moustache permanently stained.`,
        getScore: (w: typeof memberStats[0]) => (w ? 85 + w.guinnessCount * 3 : 0),
        cardClass: "bg-slate-900 dark:bg-slate-950 border-slate-700 text-slate-100",
        titleClass: "text-amber-400",
        badgeClass: "text-slate-300",
        IconComponent: Beer,
        iconClass: "text-amber-400",
        noStatText: "No stout logs",
      },
      {
        id: "zenmaster",
        title: "Zen Master 🧘",
        tagline: "Knows exactly when to take it easy",
        winner: [...memberStats].filter((m) => m.soberDays > 0).sort((a, b) => b.soberDays - a.soberDays)[0],
        getStatText: (w: typeof memberStats[0]) => `${w.soberDays} sober days this period. Balance achieved.`,
        getScore: (w: typeof memberStats[0]) => (w ? 80 + w.soberDays * 3 : 0),
        cardClass: "bg-emerald-500/10 dark:bg-emerald-950/30 border-emerald-500/30",
        titleClass: "text-emerald-900 dark:text-emerald-300",
        badgeClass: "text-emerald-800 dark:text-emerald-200",
        IconComponent: Coffee,
        iconClass: "text-emerald-600 dark:text-emerald-400",
        noStatText: "No sober days logged",
      },
      {
        id: "hypebeast",
        title: "Clinking Monarch 🥂",
        tagline: "Distributing cheers like candy at Christmas",
        winner: [...memberStats].filter((m) => m.cheersReceived > 0).sort((a, b) => b.cheersReceived - a.cheersReceived)[0],
        getStatText: (w: typeof memberStats[0]) => `${w.cheersReceived} cheers collected. Unofficial pub mayor.`,
        getScore: (w: typeof memberStats[0]) => (w ? 78 + w.cheersReceived * 2 : 0),
        cardClass: "bg-sky-500/10 dark:bg-sky-950/30 border-sky-500/30",
        titleClass: "text-sky-900 dark:text-sky-300",
        badgeClass: "text-sky-800 dark:text-sky-200",
        IconComponent: Trophy,
        iconClass: "text-sky-600 dark:text-sky-400",
        noStatText: "No cheers received",
      },
      {
        id: "roulette",
        title: "Tastebud Roulette 🧭",
        tagline: "Refuses to order the same beer twice",
        winner: [...memberStats].filter((m) => m.uniqueBeersCount > 0).sort((a, b) => b.uniqueBeersCount - a.uniqueBeersCount)[0],
        getStatText: (w: typeof memberStats[0]) => `${w.uniqueBeersCount} wild brew varieties logged.`,
        getScore: (w: typeof memberStats[0]) => (w ? 75 + w.uniqueBeersCount * 2 : 0),
        cardClass: "bg-indigo-500/10 dark:bg-indigo-950/30 border-indigo-500/30",
        titleClass: "text-indigo-900 dark:text-indigo-300",
        badgeClass: "text-indigo-800 dark:text-indigo-200",
        IconComponent: Sparkles,
        iconClass: "text-indigo-600 dark:text-indigo-400",
        noStatText: "No unique beers logged",
      },
      {
        id: "ramsay",
        title: "Gordon Ramsay of Drafts 🥸",
        tagline: "Gave 2 stars because foam wasn't symmetrical",
        winner: [...memberStats].filter((m) => m.avgRating > 0 && m.totalPints >= 1).sort((a, b) => a.avgRating - b.avgRating)[0],
        getStatText: (w: typeof memberStats[0]) => `Brutal ${w.avgRating} / 5.0 avg rating. Tough critic!`,
        getScore: (w: typeof memberStats[0]) => (w ? 72 + (5 - w.avgRating) * 5 : 0),
        cardClass: "bg-amber-500/10 dark:bg-amber-950/30 border-amber-500/30",
        titleClass: "text-amber-900 dark:text-amber-300",
        badgeClass: "text-amber-800 dark:text-amber-200",
        IconComponent: Star,
        iconClass: "fill-amber-400 text-amber-400",
        noStatText: "No ratings logged",
      },
      {
        id: "loyalist",
        title: "Monogamous Drinker 🔒",
        tagline: "Has never turned to page 2 of the beer menu",
        winner: [...memberStats].filter((m) => m.topBeerCount > 1).sort((a, b) => b.topBeerCount - a.topBeerCount)[0],
        getStatText: (w: typeof memberStats[0]) => `${w.topBeerCount} check-ins for '${w.topBeerName}'. Pure loyalty.`,
        getScore: (w: typeof memberStats[0]) => (w ? 70 + w.topBeerCount * 3 : 0),
        cardClass: "bg-pink-500/10 dark:bg-pink-950/30 border-pink-500/30",
        titleClass: "text-pink-900 dark:text-pink-300",
        badgeClass: "text-pink-800 dark:text-pink-200",
        IconComponent: Crown,
        iconClass: "text-pink-600 dark:text-pink-400",
        noStatText: "No repeated beers logged",
      },
      {
        id: "daytime",
        title: "Daylight Pioneer 🌅",
        tagline: "It's 12:01 PM somewhere in the tavern",
        winner: [...memberStats].filter((m) => m.earlyCount > 0).sort((a, b) => b.earlyCount - a.earlyCount)[0],
        getStatText: (w: typeof memberStats[0]) => `${w.earlyCount} afternoon daylight pints poured.`,
        getScore: (w: typeof memberStats[0]) => (w ? 68 + w.earlyCount * 3 : 0),
        cardClass: "bg-yellow-500/10 dark:bg-yellow-950/30 border-yellow-500/30",
        titleClass: "text-yellow-900 dark:text-yellow-300",
        badgeClass: "text-yellow-800 dark:text-yellow-200",
        IconComponent: Sparkles,
        iconClass: "text-yellow-600 dark:text-yellow-400",
        noStatText: "No early afternoon logs",
      },
      {
        id: "generous",
        title: "Easiest To Please 🌟",
        tagline: "Gave 5 stars to lukewarm lager out of pure love",
        winner: [...memberStats].filter((m) => m.avgRating > 0).sort((a, b) => b.avgRating - a.avgRating)[0],
        getStatText: (w: typeof memberStats[0]) => `Glowing ${w.avgRating} / 5.0 rating average! Loves every drop.`,
        getScore: (w: typeof memberStats[0]) => (w ? 65 + w.avgRating * 4 : 0),
        cardClass: "bg-orange-500/10 dark:bg-orange-950/30 border-orange-500/30",
        titleClass: "text-orange-900 dark:text-orange-300",
        badgeClass: "text-orange-800 dark:text-orange-200",
        IconComponent: Star,
        iconClass: "fill-orange-400 text-orange-400",
        noStatText: "No ratings logged",
      },
      {
        id: "marathon",
        title: "Clockwork Regular 🛡️",
        tagline: "Showing up to the pub with impressive consistency",
        winner: [...memberStats].filter((m) => m.activeDaysCount > 0).sort((a, b) => b.activeDaysCount - a.activeDaysCount)[0],
        getStatText: (w: typeof memberStats[0]) => `Checked in on ${w.activeDaysCount} distinct days this period!`,
        getScore: (w: typeof memberStats[0]) => (w ? 60 + w.activeDaysCount * 4 : 0),
        cardClass: "bg-teal-500/10 dark:bg-teal-950/30 border-teal-500/30",
        titleClass: "text-teal-900 dark:text-teal-300",
        badgeClass: "text-teal-800 dark:text-teal-200",
        IconComponent: Shield,
        iconClass: "text-teal-600 dark:text-teal-400",
        noStatText: "No active days logged",
      },
    ];

    // Weekly Rotation Logic:
    // Offset candidate order by currentWeekNum * 3
    const offset = (currentWeekNum * 3) % candidates.length;
    const rotatedPool = [];
    for (let i = 0; i < candidates.length; i++) {
      rotatedPool.push(candidates[(offset + i) % candidates.length]);
    }

    // Evaluate candidates with scored winners
    const evaluated = rotatedPool.map((cand) => ({
      ...cand,
      score: cand.winner ? cand.getScore(cand.winner) : 0,
    }));

    // Pick top 4 active from rotated pool, or pad with default items from rotated pool
    const activeCandidates = evaluated.filter((c) => c.winner && c.score > 0);
    const top4 = [...activeCandidates.slice(0, 4)];
    if (top4.length < 4) {
      const usedIds = new Set(top4.map((c) => c.id));
      for (const item of evaluated) {
        if (top4.length >= 4) break;
        if (!usedIds.has(item.id)) {
          top4.push(item);
          usedIds.add(item.id);
        }
      }
    }

    return {
      top4,
      totalPeriodLogs: superlativeFilteredLogs.length,
      currentWeekNum
    };
  }, [activeMembers, superlativeFilteredLogs, superlativeTimeframe, currentWeekNum]);

  // Graph 1: "A Pint in Time" Cumulative Timeline
  const pubGraphData = useMemo(() => {
    const members = activeMembers;
    if (members.length === 0 || activePubFilteredLogs.length === 0) return [];

    const sortedLogs = [...activePubFilteredLogs].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    
    const dateMap: Record<string, BeerLog[]> = {};
    sortedLogs.forEach((log) => {
      const dStr = new Date(log.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      if (!dateMap[dStr]) dateMap[dStr] = [];
      dateMap[dStr].push(log);
    });

    const runningUserTotals: Record<string, number> = {};
    members.forEach(m => runningUserTotals[m] = 0);

    let runningTotal = 0;
    return Object.entries(dateMap).map(([dateLabel, dayLogs]) => {
      const dayUserCounts: Record<string, number> = {};
      dayLogs.forEach(l => {
        dayUserCounts[l.user] = (dayUserCounts[l.user] || 0) + 1;
        runningTotal += 1;
      });

      const baseValues: Record<string, number> = {};
      members.forEach(m => {
        runningUserTotals[m] += dayUserCounts[m] || 0;
        baseValues[m] = runningUserTotals[m];
      });

      const valGroups: Record<number, string[]> = {};
      members.forEach(m => {
        const v = baseValues[m];
        if (!valGroups[v]) valGroups[v] = [];
        valGroups[v].push(m);
      });

      const pointItem: any = { date: dateLabel, Total: runningTotal };

      members.forEach(m => {
        const rawVal = baseValues[m];
        const grp = valGroups[rawVal];
        if (grp && grp.length > 1 && rawVal > 0) {
          const idx = grp.indexOf(m);
          const offset = (idx - (grp.length - 1) / 2) * 0.08;
          pointItem[m] = rawVal + offset;
        } else {
          pointItem[m] = rawVal;
        }
      });

      return pointItem;
    });
  }, [activeMembers, activePubFilteredLogs]);

  // Graph 2: Guinness & Stout Breakdown
  const guinnessBreakdown = useMemo(() => {
    const members = activeMembers;
    if (members.length === 0 || !activePubFilteredLogs) return { memberData: [], totalGuinness: 0, totalPints: 0, percentage: 0 };

    let totalGuinness = 0;
    const totalPints = activePubFilteredLogs.length;

    const memberData = members.map(member => {
      const mLogs = activePubFilteredLogs.filter(l => l.user === member);
      const guinnessCount = mLogs.filter(l => l.beerName?.toLowerCase().includes("guinness") || l.beerName?.toLowerCase().includes("stout")).length;
      const otherCount = mLogs.length - guinnessCount;
      totalGuinness += guinnessCount;

      return {
        user: member,
        "Guinness & Stout": guinnessCount,
        "Other Craft": otherCount,
        total: mLogs.length
      };
    }).filter(m => m.total > 0).sort((a, b) => b["Guinness & Stout"] - a["Guinness & Stout"]);

    const percentage = totalPints > 0 ? Math.round((totalGuinness / totalPints) * 100) : 0;

    return { memberData, totalGuinness, totalPints, percentage };
  }, [activeMembers, activePubFilteredLogs]);

  const getRankBadge = (rank: number) => {
    if (rank === 1) return <span className="text-xs bg-amber-500/20 border border-amber-500/50 text-amber-400 font-black px-2.5 py-1 rounded-lg">#1 🥇</span>;
    if (rank === 2) return <span className="text-xs bg-slate-300/20 border border-slate-300/50 text-slate-300 font-black px-2.5 py-1 rounded-lg">#2 🥈</span>;
    if (rank === 3) return <span className="text-xs bg-amber-700/20 border border-amber-700/50 text-amber-600 font-black px-2.5 py-1 rounded-lg">#3 🥉</span>;
    return <span className="text-xs bg-slate-800 text-slate-400 font-bold px-2 py-0.5 rounded-lg">#{rank}</span>;
  };

  const isOwner = activePub ? activePub.owner === currentUser : false;
  const isInviting = activePub ? invitingPubId === activePub.id : false;

  // ===========================================================================
  // RENDER UNIFIED PUB PAGE VIEW
  // ===========================================================================
  return (
    <div className="space-y-3 animate-in fade-in duration-200">
      {/* Light the Beacons - the headline action of this page: rally friends to a pub */}
      {activePub ? (
        <button
          type="button"
          onClick={() => {
            setShowBeaconModal(true);
            setBeaconError("");
            setBeaconInvitees((activePub.members || []).filter((m) => m !== currentUser));
          }}
          disabled={rallySending}
          className="w-full flex items-center gap-3 px-4 py-4 bg-gradient-to-r from-amber-500 via-orange-500 to-red-600 rounded-2xl shadow-lg hover:brightness-110 active:scale-[0.99] transition-all cursor-pointer text-left"
        >
          <div className="w-10 h-10 rounded-full bg-slate-950/15 flex items-center justify-center shrink-0">
            <Flame className="w-5 h-5 text-slate-950 fill-slate-950/30 animate-pulse" />
          </div>
          <span className="min-w-0 flex-1">
            <span className="block text-slate-950 font-black text-sm sm:text-base leading-tight">
              {rallySending ? "Lighting the beacons..." : "Light the Beacons! 🔥"}
            </span>
            <span className="block text-slate-950/70 font-bold text-[11px] sm:text-xs leading-tight truncate">
              Invite friends to {activePub.name} - pints call for aid!
            </span>
          </span>
          <ChevronRight className="w-5 h-5 text-slate-950/60 shrink-0" />
        </button>
      ) : (
        <div className="w-full flex items-center gap-3 px-4 py-4 bg-slate-100 dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-700 rounded-2xl text-slate-400">
          <Flame className="w-5 h-5 shrink-0" />
          <span className="text-xs font-bold">Pick or create a Pub below to start rallying friends.</span>
        </div>
      )}

      {/* Beacon Rally Modal - who, where, and go */}
      {showBeaconModal && activePub && (
        <div className="fixed inset-0 z-[110] bg-slate-950/80 backdrop-blur-xs flex items-start sm:items-center justify-center overflow-y-auto p-4 py-6">
          <div className="bg-slate-900 border-2 border-orange-500/60 rounded-2xl p-5 max-w-md w-full shadow-2xl space-y-4 relative animate-in fade-in zoom-in-95 max-h-[85dvh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-orange-500/20 border border-orange-500/50 rounded-xl text-orange-400">
                  <Flame className="w-6 h-6 text-orange-500 fill-orange-500/30 animate-pulse" />
                </div>
                <div>
                  <h3 className="text-base font-black text-white flex items-center gap-1.5">
                    Light the Beacons! 🔥
                  </h3>
                  <p className="text-xs text-slate-300">
                    Rally your friends to <span className="font-extrabold text-amber-400">{activePub.name}</span>!
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => { setShowBeaconModal(false); setBeaconError(""); }}
                className="text-slate-400 hover:text-white p-1 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider">
                Bar / Pub Name <span className="text-orange-400">*</span>
              </label>
              <input
                type="text"
                value={beaconBarName}
                onChange={(e) => {
                  setBeaconBarName(e.target.value);
                  if (beaconError) setBeaconError("");
                }}
                placeholder="e.g. The Crown & Anchor, O'Malley's, The Red Lion..."
                className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-sm font-semibold text-white placeholder-slate-500 focus:outline-hidden focus:ring-2 focus:ring-orange-500 focus:border-orange-500 transition-all"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider">
                Who's Invited? {beaconInvitees.length > 0 && `(${beaconInvitees.length})`}
              </label>
              {rallyCandidates.length === 0 ? (
                <p className="text-xs text-slate-400">Add some friends first, then come rally them!</p>
              ) : (
                <div className="max-h-40 overflow-y-auto grid grid-cols-2 gap-1.5 custom-scrollbar pr-1">
                  {rallyCandidates.map((name) => {
                    const selected = beaconInvitees.includes(name);
                    const isMember = activePub.members.some((m) => m.toLowerCase() === name.toLowerCase());
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => toggleBeaconInvitee(name)}
                        className={`p-2 rounded-lg border text-left text-[11px] font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                          selected
                            ? "bg-orange-500/20 border-orange-500 text-orange-200"
                            : "bg-slate-950 border-slate-700 text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        <UserAvatar username={name} users={users} className="w-4 h-4 text-[9px] shrink-0" />
                        <span className="truncate flex-1">{name}</span>
                        {!isMember && (
                          <span className="text-[8px] uppercase font-black text-slate-500 shrink-0">Friend</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {beaconError && (
              <p className="text-xs text-red-400 font-bold">{beaconError}</p>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => { setShowBeaconModal(false); setBeaconError(""); }}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs rounded-xl transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!beaconBarName.trim()) {
                    setBeaconError("Please enter the bar or pub name before lighting the beacons!");
                    return;
                  }
                  if (beaconInvitees.length === 0) {
                    setBeaconError("Pick at least one friend to invite!");
                    return;
                  }
                  handleTriggerRally(activePub.id, beaconBarName);
                }}
                disabled={rallySending}
                className="px-4 py-2 bg-gradient-to-r from-amber-500 via-orange-500 to-red-600 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl shadow-md hover:brightness-110 active:scale-95 transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
              >
                <Flame className="w-4 h-4 fill-slate-950/40" />
                <span>{rallySending ? "Lighting..." : "Light Beacons! 🔥"}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pending Pub invites - surfaced up front with Accept/Decline, same pattern as
          a friend request, instead of just quietly sitting in the pub switcher below
          waiting for someone to notice the dashed envelope card and hunt for "Join". */}
      {myInvites.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-900/50 rounded-2xl p-3 space-y-2">
          <p className="text-[10px] font-extrabold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            ✉️ Pub Invite{myInvites.length === 1 ? "" : "s"} ({myInvites.length})
          </p>
          <div className="space-y-1.5">
            {myInvites.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2.5 p-2 bg-emerald-50/60 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-900/40 rounded-xl"
              >
                <div
                  className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer"
                  onClick={() => handleSelectPub(p.id)}
                >
                  <PubEmblem emblem={p.emblem} sizeClass="w-8 h-8 text-base shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-extrabold text-slate-800 dark:text-slate-100 truncate">{p.name}</p>
                    <p className="text-[10px] text-slate-400 truncate">Host: @{p.owner}</p>
                  </div>
                </div>
                <button
                  onClick={() => handleJoinPub(p.id)}
                  title="Accept"
                  className="p-2 bg-emerald-500 hover:bg-emerald-400 text-white rounded-xl transition-all cursor-pointer shrink-0"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleDeclinePubInvite(p.id)}
                  title="Decline"
                  className="p-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-xl transition-all cursor-pointer shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pub switcher - horizontal cards instead of a dropdown, so you can actually see
          what you're picking between instead of reading option text one at a time */}
      <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar pb-0.5 -mx-0.5 px-0.5">
        {myPubs.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => handleSelectPub(p.id)}
            className={`shrink-0 w-[76px] flex flex-col items-center gap-1 p-2 rounded-2xl border-2 transition-all cursor-pointer ${
              p.id === activePubId
                ? "bg-amber-500/10 border-amber-500 shadow-md"
                : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-amber-300"
            }`}
          >
            <div className="relative">
              <div className="w-9 h-9 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex items-center justify-center">
                <PubEmblem emblem={p.emblem} sizeClass="w-5 h-5 text-base" />
              </div>
              {pinnedPubId === p.id && (
                <Pin className="w-3 h-3 text-amber-500 fill-amber-500 absolute -top-1 -right-1" />
              )}
              <span className="absolute -bottom-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-slate-800 dark:bg-slate-700 border border-white dark:border-slate-900 text-[8px] font-black text-white flex items-center justify-center leading-none">
                {p.members.length}
              </span>
            </div>
            <span className="text-[10px] font-extrabold text-slate-800 dark:text-slate-100 truncate w-full text-center leading-tight">
              {p.name}
            </span>
          </button>
        ))}

        {myInvites.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => handleSelectPub(p.id)}
            className={`shrink-0 w-[76px] flex flex-col items-center gap-1 p-2 rounded-2xl border-2 border-dashed transition-all cursor-pointer ${
              p.id === activePubId
                ? "bg-emerald-500/10 border-emerald-500 shadow-md"
                : "bg-white dark:bg-slate-900 border-emerald-300 dark:border-emerald-800 hover:border-emerald-500"
            }`}
          >
            <div className="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 flex items-center justify-center text-sm">
              ✉️
            </div>
            <span className="text-[10px] font-extrabold text-emerald-700 dark:text-emerald-400 truncate w-full text-center leading-tight">
              {p.name}
            </span>
          </button>
        ))}

        <button
          type="button"
          onClick={() => setShowCreateModal(true)}
          className="shrink-0 w-[76px] flex flex-col items-center justify-center gap-1 p-2 rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-700 text-slate-400 hover:text-amber-500 hover:border-amber-400 transition-all cursor-pointer min-h-[68px]"
        >
          <Plus className="w-5 h-5 stroke-[3px]" />
          <span className="text-[10px] font-extrabold">New Pub</span>
        </button>
      </div>

      {/* Zone: The Bar - who's here, the roster, and the chat corner */}
      <div className="flex items-center gap-2 px-0.5 pt-1">
        <span className="text-base">🍺</span>
        <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-600 dark:text-amber-500">The Bar</h2>
        <div className="flex-1 h-px bg-gradient-to-r from-amber-500/40 via-amber-500/10 to-transparent" />
      </div>

      {/* Active pub identity + compact actions */}
      <div className="bg-white dark:bg-slate-900 border border-amber-200/70 dark:border-amber-900/40 rounded-2xl p-3 sm:p-3.5 shadow-2xs space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg shrink-0">
              {activePub ? <PubEmblem emblem={activePub.emblem} sizeClass="w-7 h-7 text-lg" /> : <span className="shrink-0 text-lg">🍻</span>}
            </div>
            <div className="min-w-0">
              <h1 className="text-sm sm:text-base font-black text-slate-900 dark:text-white leading-tight flex items-center gap-1.5 min-w-0">
                <span className="truncate">{activePub ? activePub.name : "No Pub Selected"}</span>
                {activePub?.isPrivate && (
                  <Lock className="w-3 h-3 text-slate-400 shrink-0" title="Private - invite only" />
                )}
              </h1>
              <p className="text-[10px] sm:text-[11px] text-slate-500 dark:text-slate-400 font-medium truncate">
                Host: @{activePub?.owner || "System"} • <span className="font-bold text-amber-500">{activePubFilteredLogs.length} Pints</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {activePub && !activePub.members.includes(currentUser) ? (
              myInvites.some((p) => p.id === activePub.id) ? (
                <>
                  <button
                    onClick={() => handleJoinPub(activePub.id)}
                    title="Accept invite"
                    className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-white font-black text-[11px] uppercase tracking-wider rounded-xl transition-all cursor-pointer shadow-xs flex items-center gap-1 shrink-0"
                  >
                    <Check className="w-3.5 h-3.5" /> Accept
                  </button>
                  <button
                    onClick={() => handleDeclinePubInvite(activePub.id)}
                    title="Decline invite"
                    className="p-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 rounded-xl transition-all cursor-pointer w-[32px] h-[32px] flex items-center justify-center shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </>
              ) : activePub.isPrivate ? (
                <span
                  title="This Pub is private - you need an invite from the owner to join."
                  className="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 font-black text-[11px] uppercase tracking-wider rounded-xl flex items-center gap-1 shrink-0 cursor-not-allowed"
                >
                  <Lock className="w-3.5 h-3.5" /> Invite Only
                </span>
              ) : (
                <button
                  onClick={() => handleJoinPub(activePub.id)}
                  className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-[11px] uppercase tracking-wider rounded-xl transition-all cursor-pointer shadow-xs flex items-center gap-1 shrink-0"
                >
                  <UserPlus className="w-3.5 h-3.5" /> Join
                </button>
              )
            ) : (
              <>
                {onPinPub && activePub && (
                  <button
                    type="button"
                    id="pin-pub-hub-button"
                    onClick={() => onPinPub(activePubId)}
                    title={pinnedPubId === activePubId ? "Unpin this view" : "Pin as default view across app"}
                    className={`p-1.5 rounded-xl border transition-all cursor-pointer w-[32px] h-[32px] flex items-center justify-center ${
                      pinnedPubId === activePubId
                        ? "bg-amber-500 text-slate-950 border-amber-500"
                        : "bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                    }`}
                  >
                    <Pin className={`w-3.5 h-3.5 ${pinnedPubId === activePubId ? "fill-slate-950" : ""}`} />
                  </button>
                )}
                <button
                  onClick={() => setShowRoster(prev => ({ ...prev, [activePubId]: !prev[activePubId] }))}
                  title="Roster"
                  className="px-2.5 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-bold rounded-xl transition-all cursor-pointer flex items-center gap-1 h-[32px]"
                >
                  <Users className="w-3.5 h-3.5 text-amber-500" />
                  {activeMembers.length}
                </button>
                {activePub && isOwner && (
                  <>
                    <button
                      onClick={() => setInvitingPubId(invitingPubId === activePub.id ? null : activePub.id)}
                      title="Invite to roster"
                      className="p-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-xl transition-all cursor-pointer w-[32px] h-[32px] flex items-center justify-center"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => startEditing(activePub)}
                      className="p-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-600 dark:text-slate-300 rounded-xl transition-all cursor-pointer w-[32px] h-[32px] flex items-center justify-center"
                      title="Edit Pub"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
                {activePub && !isOwner && activePub.members.includes(currentUser) && (
                  <button
                    onClick={() => handleLeavePub(activePub.id)}
                    className="p-1.5 text-red-500 hover:bg-red-500/10 rounded-xl transition-all cursor-pointer w-[32px] h-[32px] flex items-center justify-center"
                    title="Leave Pub"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {otherPubs.length > 0 && (
          <details className="text-[11px]">
            <summary className="text-slate-400 font-bold cursor-pointer select-none">
              🧭 Explore {otherPubs.length} other Pub{otherPubs.length === 1 ? "" : "s"}
            </summary>
            <div className="flex items-center gap-1.5 overflow-x-auto custom-scrollbar pt-2 pb-0.5">
              {otherPubs.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleSelectPub(p.id)}
                  className="shrink-0 px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-full text-slate-600 dark:text-slate-300 font-bold hover:border-amber-400 transition-all cursor-pointer flex items-center gap-1"
                >
                  {p.isPrivate && <Lock className="w-2.5 h-2.5 text-slate-400 shrink-0" />}
                  {p.name} <span className="text-slate-400">({p.members.length})</span>
                </button>
              ))}
            </div>
          </details>
        )}

        {/* Expandable Roster & Invites Drawer */}
        <AnimatePresence>
          {showRoster[activePubId] && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden pt-2.5 border-t border-slate-100 dark:border-slate-800 space-y-2.5"
            >
              <div className="flex flex-wrap gap-1.5">
                {activeMembers.map(member => (
                  <div
                    key={member}
                    onClick={() => onViewProfileRequested?.(member)}
                    className="inline-flex items-center gap-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 px-2.5 py-1 rounded-full text-[11px] font-bold text-slate-800 dark:text-slate-200 cursor-pointer hover:border-amber-400 transition-all"
                  >
                    <UserAvatar username={member} users={users} className="w-4 h-4 text-[9px]" />
                    <span>@{member}</span>
                    {activePub && member === activePub.owner && <Shield className="w-3 h-3 text-amber-500 fill-amber-500" title="Host" />}
                  </div>
                ))}
              </div>

              {activePub && isInviting && (
                <div className="p-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl space-y-2">
                  <p className="text-xs font-extrabold text-slate-800 dark:text-slate-200">Invite Members to {activePub.name}:</p>
                  <div className="max-h-32 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1.5 custom-scrollbar">
                    {otherUsers
                      .filter(u => !activePub.members.includes(u.username) && !activePub.invited.includes(u.username))
                      .map(u => {
                        const selected = additionalInvitees.includes(u.username);
                        return (
                          <button
                            key={u.username}
                            type="button"
                            onClick={() => toggleAdditionalInvitee(u.username)}
                            className={`p-2 rounded-xl border text-left text-xs font-bold flex items-center gap-2 transition-all cursor-pointer ${
                              selected
                                ? "bg-amber-50 dark:bg-amber-500/20 border-amber-400 text-amber-900 dark:text-amber-200"
                                : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
                            }`}
                          >
                            <UserAvatar username={u.username} users={users} className="w-4 h-4 text-[10px]" />
                            <span className="truncate">{u.realName || u.username}</span>
                          </button>
                        );
                      })}
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => { setInvitingPubId(null); setAdditionalInvitees([]); }}
                      className="px-3 py-1.5 bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-bold rounded-lg"
                    >
                      Cancel
                    </button>
                    {additionalInvitees.length > 0 && (
                      <button
                        onClick={() => handleSendInvitations(activePub.id)}
                        className="px-4 py-1.5 bg-amber-500 text-slate-950 text-xs font-black rounded-lg flex items-center gap-1"
                      >
                        <Send className="w-3 h-3" /> Send ({additionalInvitees.length})
                      </button>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {rallySentNotice && (
        <div className="p-3 bg-gradient-to-r from-amber-500 via-orange-500 to-red-600 text-slate-950 rounded-xl font-extrabold text-xs flex items-center justify-center gap-2 shadow-lg animate-bounce border border-amber-300">
          <Flame className="w-4 h-4 fill-slate-950/40" />
          <span>🔥 THE BEACONS ARE LIT AT {rallySentNotice.toUpperCase()}! Broadcast sent to chat: "Pints call for aid!" ⚔️🍺</span>
        </div>
      )}

      {/* Banter & Chat - minimized to a collapsible strip. Beacon calls land
          here as regular messages, so lighting a beacon auto-expands it. */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-amber-200/70 dark:border-amber-900/40 shadow-xs overflow-hidden">
        <button
          type="button"
          onClick={() => setChatExpanded((v) => !v)}
          className="w-full flex items-center justify-between gap-2 px-4 py-3 cursor-pointer text-left"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <MessageSquare className="w-4 h-4 text-amber-500 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-extrabold text-slate-800 dark:text-slate-100">Banter & Chat</p>
              {latestPubMessage ? (
                latestPubMessage.text?.includes("BEACONS ARE LIT") ? (
                  <p className="text-[10px] font-bold text-orange-500 truncate max-w-[220px] sm:max-w-xs">
                    🔥 @{latestPubMessage.user} lit the beacons!
                  </p>
                ) : (
                  <p className="text-[10px] text-slate-400 truncate max-w-[220px] sm:max-w-xs">
                    {latestPubMessage.user}: {latestPubMessage.text}
                  </p>
                )
              ) : (
                <p className="text-[10px] text-slate-400">No messages yet — tap to say something</p>
              )}
            </div>
          </div>
          <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${chatExpanded ? "rotate-180" : ""}`} />
        </button>
        {chatExpanded && (
          <div className="px-4 pb-4 -mt-1 border-t border-slate-100 dark:border-slate-800 pt-3">
            <PubChatSection
              pubId={activePub?.id || ""}
              pubName={activePub?.name || "Pub"}
              pubOwner={activePub?.owner || "System"}
              currentUser={currentUser}
              users={users}
              onViewProfileRequested={onViewProfileRequested}
              messageRefreshKey={chatRefreshKey}
            />
          </div>
        )}
      </div>

      {/* Zone: On Tap / Trophy Wall - the stats board and the honors case, one
          tab switcher between them since they're both "what's happening here" */}
      <div className="flex items-center gap-2 px-0.5 pt-1">
        <span className="text-base">🍻</span>
        <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-600 dark:text-amber-500">On Tap</h2>
        <div className="flex-1 h-px bg-gradient-to-r from-amber-500/40 via-amber-500/10 to-transparent" />
      </div>

      <div className="flex items-center gap-1.5 p-1.5 bg-amber-50 dark:bg-slate-900/90 border border-amber-200/60 dark:border-amber-900/40 rounded-2xl shadow-2xs">
        <button
          type="button"
          onClick={() => setActiveTab("widgets")}
          className={`flex-1 py-2 px-3 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 transition-all cursor-pointer whitespace-nowrap min-h-[38px] ${
            activeTab === "widgets"
              ? "bg-amber-500 text-slate-950 shadow-xs"
              : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
          }`}
        >
          <Gauge className="w-3.5 h-3.5" />
          <span>On Tap</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("superlatives")}
          className={`flex-1 py-2 px-3 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 transition-all cursor-pointer whitespace-nowrap min-h-[38px] ${
            activeTab === "superlatives"
              ? "bg-amber-500 text-slate-950 shadow-xs"
              : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
          }`}
        >
          <Award className="w-3.5 h-3.5" />
          <span>Trophy Wall</span>
        </button>
      </div>

      {/* Messages */}
      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="font-semibold">{error}</span>
        </div>
      )}
      {success && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400 text-xs flex items-center gap-2">
          <Sparkles className="w-4 h-4 shrink-0 text-amber-500" />
          <span className="font-semibold">{success}</span>
        </div>
      )}

      {/* TROPHY WALL / SUPERLATIVES TAB */}
      {activeTab === "superlatives" && pubSuperlatives && (
        <div className="bg-gradient-to-br from-amber-50 to-white dark:from-amber-950/20 dark:to-slate-900 rounded-2xl border border-amber-200/70 dark:border-amber-900/40 shadow-xs p-4 sm:p-5 space-y-3.5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-amber-100 dark:border-amber-900/30 pb-3 gap-2.5">
            <div>
              <h3 className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-slate-100 tracking-tight flex items-center gap-1.5">
                <Award className="w-4 h-4 text-amber-500" />
                Trophy Wall — Pub Honor Roll
              </h3>
              <p className="text-[10px] sm:text-[11px] text-slate-400 mt-0.5">
                Comedic & rotating weekly honors calculated for pub members
              </p>
            </div>

            {/* Timeframe Selector Pills */}
            <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800/80 p-1 rounded-xl border border-slate-200/60 dark:border-slate-700/60 shrink-0 self-start sm:self-auto">
              <button
                type="button"
                onClick={() => selectSuperlativeTimeframe("7d")}
                className={`px-2.5 py-1 text-[10px] font-extrabold rounded-lg transition-all cursor-pointer ${
                  superlativeTimeframe === "7d"
                    ? "bg-amber-500 text-slate-950 shadow-xs"
                    : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                }`}
              >
                Week
              </button>
              <button
                type="button"
                onClick={() => selectSuperlativeTimeframe("30d")}
                className={`px-2.5 py-1 text-[10px] font-extrabold rounded-lg transition-all cursor-pointer ${
                  superlativeTimeframe === "30d"
                    ? "bg-amber-500 text-slate-950 shadow-xs"
                    : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                }`}
              >
                Month
              </button>
              <button
                type="button"
                onClick={() => selectSuperlativeTimeframe("year")}
                className={`px-2.5 py-1 text-[10px] font-extrabold rounded-lg transition-all cursor-pointer ${
                  superlativeTimeframe === "year"
                    ? "bg-amber-500 text-slate-950 shadow-xs"
                    : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                }`}
              >
                Year
              </button>
              <button
                type="button"
                onClick={() => selectSuperlativeTimeframe("all")}
                className={`px-2.5 py-1 text-[10px] font-extrabold rounded-lg transition-all cursor-pointer ${
                  superlativeTimeframe === "all"
                    ? "bg-amber-500 text-slate-950 shadow-xs"
                    : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                }`}
              >
                All
              </button>
            </div>
          </div>

          {pubSuperlatives.totalPeriodLogs === 0 ? (
            <div className="py-8 px-4 text-center bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-dashed border-slate-200 dark:border-slate-700/60 space-y-1">
              <p className="text-xs font-bold text-slate-600 dark:text-slate-300">
                No pub check-ins logged in{" "}
                {superlativeTimeframe === "7d"
                  ? "the past 7 days"
                  : superlativeTimeframe === "30d"
                  ? "the past 30 days"
                  : superlativeTimeframe === "year"
                  ? "this past year"
                  : "all time"}
              </p>
              <p className="text-[11px] text-slate-400">
                Switch timeframes above or log a pint to kick off superlatives! 🍻
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {pubSuperlatives.top4.map((item) => {
                const IconComp = item.IconComponent;
                return (
                  <div
                    key={item.id}
                    className={`border rounded-xl p-3.5 space-y-1.5 transition-all shadow-2xs ${item.cardClass}`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <div className={`flex items-center gap-1.5 ${item.titleClass}`}>
                        <IconComp className={`w-4 h-4 shrink-0 ${item.iconClass}`} />
                        <span className="text-xs font-black uppercase tracking-wider truncate">{item.title}</span>
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 italic leading-tight">
                      "{item.tagline}"
                    </p>
                    {item.winner ? (
                      <div className="pt-1 border-t border-slate-200/40 dark:border-slate-700/40">
                        <p className="font-extrabold text-xs sm:text-sm text-slate-900 dark:text-slate-100 truncate">
                          @{item.winner.username}
                        </p>
                        <p className={`text-[11px] font-bold ${item.badgeClass} leading-snug mt-0.5`}>
                          {item.getStatText(item.winner)}
                        </p>
                      </div>
                    ) : (
                      <p className="text-[10px] opacity-60 italic pt-1">{item.noStatText}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ON TAP - GAUGE WIDGETS (customizable), framed like a chalkboard board */}
      {activeTab === "widgets" && (
        <div className="space-y-3 p-3 sm:p-4 rounded-3xl bg-gradient-to-b from-emerald-50 to-transparent dark:from-emerald-950/25 dark:to-transparent border border-emerald-200/60 dark:border-emerald-900/30">
          {activeWidgets.map((widget) => {
            const catalogEntry = WIDGET_CATALOG.find((c) => c.type === widget.type);
            const HeaderIcon = catalogEntry?.icon || Beer;
            const cardHeader = (
              <div className="border-b border-slate-100 dark:border-slate-800 pb-3 flex justify-between items-center">
                <div>
                  <h3 className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                    <HeaderIcon className="w-4 h-4 text-amber-500" />
                    {widget.label}
                  </h3>
                  <p className="text-[10px] sm:text-[11px] text-slate-400 mt-0.5">{widgetSubtitle(widget)}</p>
                </div>
              </div>
            );

            // ---- Goblin Clock: 24hr radial spoke chart ----
            if (widget.type === "goblin-mode") {
              const gd = computeGoblinClockData();
              const cx = 100, cy = 100, rInner = 32, rOuterMax = 88;
              return (
                <div key={widget.id} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs p-4 sm:p-5 space-y-4">
                  {cardHeader}
                  <div className="flex flex-col items-center justify-center py-2">
                    {gd.total === 0 ? (
                      <div className="w-full h-40 flex items-center justify-center text-slate-400 italic text-xs">No logs within filtered period</div>
                    ) : (
                      <div className="w-full flex flex-col items-center">
                        <div className="w-full max-w-[220px] aspect-square relative flex items-center justify-center">
                          <svg className="w-full h-full overflow-visible" viewBox="0 0 200 200">
                            <circle cx={cx} cy={cy} r={rInner} fill="none" stroke="currentColor" className="text-slate-200 dark:text-slate-700" strokeWidth="1" />
                            <circle cx={cx} cy={cy} r={rOuterMax} fill="none" stroke="currentColor" className="text-slate-100 dark:text-slate-800" strokeWidth="1" strokeDasharray="1 4" />
                            {gd.hourCounts.map((count, h) => {
                              const angle = (h / 24) * 360 - 90; // hour 0 at top, clockwise
                              const rad = (angle * Math.PI) / 180;
                              const len = rInner + (count / gd.maxCount) * (rOuterMax - rInner);
                              const x1 = cx + rInner * Math.cos(rad);
                              const y1 = cy + rInner * Math.sin(rad);
                              const x2 = cx + len * Math.cos(rad);
                              const y2 = cy + len * Math.sin(rad);
                              const isGoblinHour = h < 5;
                              return (
                                <line
                                  key={h}
                                  x1={x1} y1={y1} x2={x2} y2={y2}
                                  stroke={isGoblinHour ? "#a855f7" : "#f59e0b"}
                                  strokeWidth={count > 0 ? 4 : 1.5}
                                  strokeLinecap="round"
                                  opacity={count > 0 ? (isGoblinHour ? 0.95 : 0.8) : 0.25}
                                />
                              );
                            })}
                            <text x={cx} y={cy - 4} textAnchor="middle" className="text-[22px] font-black font-mono fill-violet-500">{gd.goblinPercent}%</text>
                            <text x={cx} y={cy + 12} textAnchor="middle" className="text-[8px] font-extrabold uppercase tracking-widest fill-slate-400">Goblin</text>
                            <text x={cx} y="14" textAnchor="middle" className="text-[8px] font-extrabold fill-slate-400 uppercase">12am</text>
                            <text x={cx} y="193" textAnchor="middle" className="text-[8px] font-extrabold fill-slate-400 uppercase">12pm</text>
                          </svg>
                        </div>

                        <div className="w-full max-w-sm mt-2 p-3 rounded-xl border bg-violet-500/5 border-violet-500/20 text-center shadow-xs">
                          <p className="text-xs font-bold text-slate-700 dark:text-slate-300 leading-relaxed">{gd.ratingText}</p>
                        </div>

                        <div className="w-full mt-3 flex flex-col gap-2 max-w-sm mx-auto">
                          <div className="flex items-center justify-between p-2.5 rounded-xl bg-violet-500/5 dark:bg-violet-500/10 border border-violet-500/20 shadow-2xs">
                            <div className="flex items-center gap-2.5">
                              <span className="w-3.5 h-3.5 rounded-md shrink-0 bg-violet-500" />
                              <span className="font-extrabold text-xs text-slate-800 dark:text-slate-200">Goblin Hours (12–5AM)</span>
                            </div>
                            <span className="font-mono text-xs font-black text-violet-600 dark:text-violet-400">{gd.goblinCount} ({gd.goblinPercent}%)</span>
                          </div>
                          <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 shadow-2xs">
                            <div className="flex items-center gap-2.5">
                              <span className="w-3.5 h-3.5 rounded-md shrink-0 bg-amber-500" />
                              <span className="font-extrabold text-xs text-slate-600 dark:text-slate-400">Daylight Hours</span>
                            </div>
                            <span className="font-mono text-xs font-bold text-slate-500 dark:text-slate-400">{gd.total - gd.goblinCount} ({100 - gd.goblinPercent}%)</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            }

            // ---- Dart Matrix: 8-week contribution-style heatmap ----
            if (widget.type === "dart-matrix") {
              const dd = computeDartMatrixData();
              const intensityClass = (count: number) => {
                if (count === 0) return "bg-slate-100 dark:bg-slate-800";
                const ratio = count / dd.maxCount;
                if (ratio > 0.75) return "bg-amber-600";
                if (ratio > 0.5) return "bg-amber-500";
                if (ratio > 0.25) return "bg-amber-400/80";
                return "bg-amber-300/60";
              };
              return (
                <div key={widget.id} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs p-4 sm:p-5 space-y-4">
                  {cardHeader}
                  <div className="flex flex-col items-center justify-center py-2">
                    {dd.total === 0 ? (
                      <div className="w-full h-40 flex items-center justify-center text-slate-400 italic text-xs">No logs within filtered period</div>
                    ) : (
                      <div className="w-full flex flex-col items-center">
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-2xl font-black font-mono text-amber-600 dark:text-amber-400">{dd.dartPercent}%</span>
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">of pints were Dart Combos 🎯</span>
                        </div>

                        <div className="flex gap-1 justify-center mt-4 overflow-x-auto max-w-full px-1">
                          {dd.weeks.map((week, wi) => (
                            <div key={wi} className="flex flex-col gap-1">
                              {week.map((day, di) => (
                                <div
                                  key={di}
                                  title={`${day.date.toDateString()}: ${day.count} Dart Combo${day.count === 1 ? "" : "s"}`}
                                  className={`w-3.5 h-3.5 rounded-sm ${intensityClass(day.count)}`}
                                />
                              ))}
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center gap-1.5 mt-2">
                          <span className="text-[9px] font-bold text-slate-400">Less</span>
                          <span className="w-2.5 h-2.5 rounded-sm bg-slate-100 dark:bg-slate-800" />
                          <span className="w-2.5 h-2.5 rounded-sm bg-amber-300/60" />
                          <span className="w-2.5 h-2.5 rounded-sm bg-amber-400/80" />
                          <span className="w-2.5 h-2.5 rounded-sm bg-amber-500" />
                          <span className="w-2.5 h-2.5 rounded-sm bg-amber-600" />
                          <span className="text-[9px] font-bold text-slate-400">More</span>
                        </div>

                        <div className="w-full max-w-sm mt-3 p-3 rounded-xl border bg-amber-500/5 border-amber-500/20 text-center shadow-xs">
                          <p className="text-xs font-bold text-slate-700 dark:text-slate-300 leading-relaxed">{dd.ratingText}</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            }

            // ---- Semicircle gauge widgets: beverage-gauge / abv-gauge / rating-gauge ----
            const data = computeWidgetData(widget);
            const angleDegrees = 180 - (data.percent / 100) * 180;
            const angleRad = (angleDegrees * Math.PI) / 180;
            const cx = 100, cy = 100, needleLen = 58;
            const nx = cx + needleLen * Math.cos(angleRad);
            const ny = cy - needleLen * Math.sin(angleRad);
            let ratingBg = "bg-amber-500/5", ratingBorder = "border-amber-500/20";
            if (data.percent < 25) { ratingBg = "bg-rose-500/5"; ratingBorder = "border-rose-500/20"; }
            else if (data.percent >= 75) { ratingBg = "bg-emerald-500/5"; ratingBorder = "border-emerald-500/20"; }
            const gTrack = `pubTrackGrad-${widget.id}`;
            const gGlow = `pubGlow-${widget.id}`;
            const gauge = getGaugeTheme(widget.type, data.percent);

            return (
              <div key={widget.id} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs p-4 sm:p-5 space-y-4">
                {cardHeader}

                <div className="flex flex-col items-center justify-center py-2">
                  {activePubFilteredLogs.length === 0 ? (
                    <div className="w-full h-40 flex items-center justify-center text-slate-400 italic text-xs">No logs within filtered period</div>
                  ) : (
                    <div className="w-full flex flex-col items-center">
                      {/* Gauge Widget */}
                      <div className="w-full max-w-[240px] aspect-[1.8/1] relative flex items-center justify-center">
                        <svg className="w-full h-full overflow-visible" viewBox="0 0 200 120">
                          <defs>
                            <linearGradient id={gTrack} x1="0%" y1="0%" x2="100%" y2="0%">
                              <stop offset="0%" stopColor={gauge.stops[0]} />
                              <stop offset="50%" stopColor={gauge.stops[1]} />
                              <stop offset="100%" stopColor={gauge.stops[2]} />
                            </linearGradient>
                            <filter id={gGlow} x="-60%" y="-60%" width="220%" height="220%">
                              <feGaussianBlur stdDeviation="3.2" result="blur" />
                              <feMerge>
                                <feMergeNode in="blur" />
                                <feMergeNode in="SourceGraphic" />
                              </feMerge>
                            </filter>
                          </defs>

                          {/* Background track */}
                          <path d="M 30,100 A 70,70 0 0,1 170,100" fill="none" stroke="currentColor" className="text-slate-100 dark:text-slate-800" strokeWidth="14" strokeLinecap="round" />
                          {/* Full-scale colored gradient (what "good" looks like at a glance) */}
                          <path d="M 30,100 A 70,70 0 0,1 170,100" fill="none" stroke={`url(#${gTrack})`} strokeWidth="11" strokeLinecap="round" opacity="0.9" filter={`url(#${gGlow})`} />

                          {/* Tick marks for an instrument-panel feel */}
                          {Array.from({ length: 9 }).map((_, i) => {
                            const tAngle = (i / 8) * 180;
                            const tRad = (tAngle * Math.PI) / 180;
                            const rOuter = 84, rInner = i % 2 === 0 ? 74 : 78;
                            const x1 = cx - rOuter * Math.cos(tRad), y1 = cy - rOuter * Math.sin(tRad);
                            const x2 = cx - rInner * Math.cos(tRad), y2 = cy - rInner * Math.sin(tRad);
                            return (
                              <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" className="text-slate-300 dark:text-slate-600" strokeWidth={i % 2 === 0 ? 2 : 1} strokeLinecap="round" />
                            );
                          })}

                          {/* Needle, glowing in the current zone's color */}
                          <g filter={`url(#${gGlow})`}>
                            <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={gauge.zoneColor} strokeWidth="3.5" strokeLinecap="round" />
                            <circle cx={cx} cy={cy} r="9" fill={gauge.zoneColor} />
                            <circle cx={cx} cy={cy} r="9" fill="none" stroke="#0b0f19" strokeWidth="1.5" />
                            <circle cx={cx} cy={cy} r="3" fill="#0b0f19" />
                          </g>

                          <text x="21" y="118" textAnchor="middle" className="text-[9px] font-extrabold fill-slate-400 uppercase">0%</text>
                          <text x="179" y="118" textAnchor="middle" className="text-[9px] font-extrabold fill-slate-400 uppercase">100%</text>
                        </svg>

                        {/* Big number readout - a colored chip rather than plain floating text */}
                        <div
                          className="absolute -top-1 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full font-black font-mono text-lg tracking-tight text-white shadow-lg"
                          style={{ backgroundColor: gauge.zoneColor, boxShadow: `0 0 14px ${gauge.zoneColor}80` }}
                        >
                          {data.bigNumber}
                        </div>
                      </div>

                      {/* Rating review banner */}
                      <div className={`w-full max-w-sm mt-2 p-3 rounded-xl border ${ratingBg} ${ratingBorder} text-center shadow-xs`}>
                        <p className="text-xs font-bold text-slate-700 dark:text-slate-300 leading-relaxed">{data.ratingText}</p>
                      </div>

                      {/* Legend / Details */}
                      <div className="w-full mt-3 flex flex-col gap-2 max-w-sm mx-auto">
                        <div className="flex items-center justify-between p-2.5 rounded-xl bg-amber-500/5 dark:bg-amber-500/10 border border-amber-500/20 shadow-2xs">
                          <div className="flex items-center gap-2.5">
                            <span className={`w-3.5 h-3.5 rounded-md shrink-0 ${data.legendA.swatchClass}`} />
                            <span className="font-extrabold text-xs text-slate-800 dark:text-slate-200 capitalize">{data.legendA.label}</span>
                          </div>
                          <span className="font-mono text-xs font-black text-amber-600 dark:text-amber-400">{data.legendA.stat}</span>
                        </div>

                        <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 shadow-2xs">
                          <div className="flex items-center gap-2.5">
                            <span className={`w-3.5 h-3.5 rounded-md shrink-0 ${data.legendB.swatchClass}`} />
                            <span className="font-extrabold text-xs text-slate-600 dark:text-slate-400 capitalize">{data.legendB.label}</span>
                          </div>
                          <span className="font-mono text-xs font-bold text-slate-500 dark:text-slate-400">{data.legendB.stat}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          <button
            type="button"
            onClick={openWidgetModal}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 font-bold text-xs hover:border-amber-400 hover:text-amber-600 dark:hover:text-amber-400 transition-colors cursor-pointer"
          >
            <Settings2 className="w-3.5 h-3.5" />
            Customize Widgets
          </button>
        </div>
      )}
      {/* Modal to Establish Pub */}
      <AnimatePresence>
        {showCreateModal && (
          <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-[110] flex items-start sm:items-center justify-center overflow-y-auto p-3 sm:p-4 py-6 animate-in fade-in duration-200">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md shadow-2xl flex flex-col overflow-hidden max-h-[92dvh]"
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-4 shrink-0">
                <h3 className="font-extrabold text-slate-100 text-sm sm:text-base flex items-center gap-2">
                  <Plus className="w-5 h-5 text-amber-500" />
                  Establish a Pub
                </h3>
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="p-1.5 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Modal Content */}
              <div className="overflow-y-auto p-5 space-y-4 custom-scrollbar flex-1 min-h-0">
                <form onSubmit={handleCreatePub} className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
                      Pub Name
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. The Drunken Dragon, Rusty Anchor"
                      value={newPubName}
                      onChange={(e) => setNewPubName(e.target.value)}
                      className="w-full px-3.5 py-2 text-sm bg-slate-950 border border-slate-800 rounded-xl focus:outline-none focus:border-amber-500 text-slate-100 placeholder-slate-500 font-semibold"
                      maxLength={35}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
                      Pub Emblem
                    </label>
                    <div className="flex gap-2 mb-2">
                      <button
                        type="button"
                        onClick={() => setNewPubEmblemType("emoji")}
                        className={`flex-1 py-1.5 px-2.5 text-[10px] font-black uppercase tracking-wider rounded-xl border flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                          newPubEmblemType === "emoji"
                            ? "bg-amber-500/20 border-amber-500 text-amber-400 font-extrabold"
                            : "bg-slate-950 border-slate-800 text-slate-500"
                        }`}
                      >
                        <Smile className="w-3.5 h-3.5" /> Emoji
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewPubEmblemType("url")}
                        className={`flex-1 py-1.5 px-2.5 text-[10px] font-black uppercase tracking-wider rounded-xl border flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                          newPubEmblemType === "url"
                            ? "bg-amber-500/20 border-amber-500 text-amber-400 font-extrabold"
                            : "bg-slate-950 border-slate-800 text-slate-500"
                        }`}
                      >
                        <Image className="w-3.5 h-3.5" /> Picture URL
                      </button>
                    </div>

                    {newPubEmblemType === "emoji" ? (
                      <div className="space-y-2">
                        <div className="grid grid-cols-8 sm:grid-cols-9 gap-1 p-1.5 bg-slate-950 border border-slate-800 rounded-xl max-h-32 overflow-y-auto custom-scrollbar">
                          {[
                            "🍺", "🍻", "🥂", "🍷", "🥃", "🍹", "🥤", "🍾", "🍕", "🍔", "🍟", "🌮", "🌯", "🥨", "🍖", "🥩", "🍗", "🌭", "🧀", "🍿", "🍳", "🥓", "🍩", "🍪", "🔥", "❤️", "🎉", "✨", "🌟", "👑", "🏰", "🎪", "🎯", "🎲", "🎰", "🎮", "🎸", "🥁", "🐉", "🦁", "🐺", "🐻", "🦅", "🦉", "🦖", "🦄", "🍀", "⚓", "🏴‍☠️", "🏴", "🚀", "🛸", "👾", "🤖", "👹", "💀", "💩"
                          ].map((em) => (
                            <button
                              key={em}
                              type="button"
                              onClick={() => setNewPubEmoji(em)}
                              className={`p-1 text-[13px] sm:text-base rounded hover:bg-slate-800 transition-all text-center flex items-center justify-center select-none cursor-pointer ${
                                newPubEmoji === em ? "bg-amber-500/20 scale-110 border border-amber-500/30" : ""
                              }`}
                            >
                              {em}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div>
                        <input
                          type="text"
                          placeholder="https://images.unsplash.com/photo-..."
                          value={newPubUrl}
                          onChange={(e) => setNewPubUrl(e.target.value)}
                          className="w-full px-3.5 py-2 text-sm bg-slate-950 border border-slate-800 rounded-xl focus:outline-none focus:border-amber-500 text-slate-100 placeholder-slate-500 font-semibold"
                        />
                        <p className="text-[9px] text-slate-400 mt-1">Provide a direct web image path/link to set as your custom pub emblem.</p>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
                      Who Can Join
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setNewPubIsPrivate(false)}
                        className={`flex-1 py-1.5 px-2.5 text-[10px] font-black uppercase tracking-wider rounded-xl border flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                          !newPubIsPrivate
                            ? "bg-amber-500/20 border-amber-500 text-amber-400 font-extrabold"
                            : "bg-slate-950 border-slate-800 text-slate-500"
                        }`}
                      >
                        <Globe className="w-3.5 h-3.5" /> Public
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewPubIsPrivate(true)}
                        className={`flex-1 py-1.5 px-2.5 text-[10px] font-black uppercase tracking-wider rounded-xl border flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                          newPubIsPrivate
                            ? "bg-amber-500/20 border-amber-500 text-amber-400 font-extrabold"
                            : "bg-slate-950 border-slate-800 text-slate-500"
                        }`}
                      >
                        <Lock className="w-3.5 h-3.5" /> Private
                      </button>
                    </div>
                    <p className="text-[9px] text-slate-400 mt-1">
                      {newPubIsPrivate
                        ? "Private - only people you invite can join."
                        : "Public - anyone can find and join this Pub."}
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
                      Invite Members (Optional)
                    </label>
                    <div className="border border-slate-800/80 rounded-xl p-1.5 bg-slate-950 max-h-28 overflow-y-auto grid grid-cols-1 gap-1">
                      {otherUsers.map((u) => {
                        const isSelected = selectedInvitees.includes(u.username);
                        return (
                          <button
                            key={u.username}
                            type="button"
                            onClick={() => toggleInvitee(u.username)}
                            className={`p-1.5 rounded-lg border text-left text-[11px] font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                              isSelected
                                ? "bg-amber-500/15 border-amber-500 text-amber-400 font-extrabold"
                                : "bg-slate-900 border-slate-800/60 text-slate-400 hover:text-slate-200"
                            }`}
                          >
                            <UserAvatar username={u.username} users={users} className="w-5 h-5 text-xs" />
                            <span className="truncate">{u.realName || u.username}</span>
                          </button>
                        );
                      })}
                      {otherUsers.length === 0 && (
                        <p className="text-center text-[10px] text-slate-500 py-4 font-semibold">No other pub companions registered on BeerReel yet.</p>
                      )}
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full py-2.5 bg-amber-500 hover:bg-amber-600 active:scale-[0.98] text-slate-950 font-black text-xs sm:text-sm uppercase tracking-wider rounded-xl shadow-lg hover:shadow-amber-500/10 transition-all flex items-center justify-center gap-1 cursor-pointer mt-2"
                  >
                    {submitting ? "Establishing Pub..." : "Establish Pub 🍻"}
                  </button>
                </form>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Modal to Edit Pub Details - name, emblem, and privacy all live here now,
          grouped into clearly separated cards with a live preview up top; inviting
          members still has its own dedicated panel. */}
      <AnimatePresence>
        {editingPubId && (
          <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-[110] flex items-start sm:items-center justify-center overflow-y-auto p-3 sm:p-4 py-6 animate-in fade-in duration-200">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md shadow-2xl flex flex-col overflow-hidden max-h-[92dvh]"
            >
              <div className="flex items-center justify-between bg-gradient-to-br from-amber-500/15 to-transparent border-b border-slate-800/80 px-5 py-4 shrink-0">
                <h3 className="font-extrabold text-slate-100 text-sm sm:text-base flex items-center gap-2">
                  <Edit2 className="w-5 h-5 text-amber-500" />
                  Edit Pub
                </h3>
                <button
                  type="button"
                  onClick={() => setEditingPubId(null)}
                  className="p-1.5 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="overflow-y-auto p-5 space-y-4 custom-scrollbar flex-1 min-h-0">
                {/* Live preview - reflects name/emblem/privacy as they're edited */}
                <div className="flex items-center gap-3 bg-gradient-to-br from-amber-500/10 to-slate-950/40 border border-amber-500/20 rounded-2xl p-3.5">
                  <div className="w-14 h-14 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-center text-2xl overflow-hidden shrink-0">
                    {editPubEmblemType === "url" && editPubUrl.trim() ? (
                      <img
                        key={editPubUrl}
                        src={editPubUrl.trim()}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                        onError={(e) => { e.currentTarget.style.display = "none"; }}
                      />
                    ) : (
                      <span>{editPubEmblemType === "emoji" ? editPubEmoji : "🍺"}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[9px] font-black uppercase tracking-wider text-amber-500/80">Preview</p>
                    <p className="font-extrabold text-slate-100 text-sm truncate">{editPubName.trim() || "Unnamed Pub"}</p>
                    <p className="text-[10px] text-slate-400 font-semibold flex items-center gap-1 mt-0.5">
                      {editPubIsPrivate ? (
                        <><Lock className="w-3 h-3" /> Invite only</>
                      ) : (
                        <><Globe className="w-3 h-3" /> Public</>
                      )}
                    </p>
                  </div>
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleUpdatePub(editingPubId);
                  }}
                  className="space-y-3.5"
                >
                  <div className="bg-slate-950/40 border border-slate-800/60 rounded-2xl p-3.5">
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                      Pub Name
                    </label>
                    <input
                      type="text"
                      value={editPubName}
                      onChange={(e) => setEditPubName(e.target.value)}
                      className="w-full px-3.5 py-2 text-sm bg-slate-950 border border-slate-800 rounded-xl focus:outline-none focus:border-amber-500 text-slate-100 placeholder-slate-500 font-semibold"
                      maxLength={35}
                    />
                  </div>

                  <div className="bg-slate-950/40 border border-slate-800/60 rounded-2xl p-3.5">
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                      Pub Emblem
                    </label>
                    <div className="flex gap-2 mb-2">
                      <button
                        type="button"
                        onClick={() => setEditPubEmblemType("emoji")}
                        className={`flex-1 py-1.5 px-2.5 text-[10px] font-black uppercase tracking-wider rounded-xl border flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                          editPubEmblemType === "emoji"
                            ? "bg-amber-500/20 border-amber-500 text-amber-400 font-extrabold"
                            : "bg-slate-950 border-slate-800 text-slate-500"
                        }`}
                      >
                        <Smile className="w-3.5 h-3.5" /> Emoji
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditPubEmblemType("url")}
                        className={`flex-1 py-1.5 px-2.5 text-[10px] font-black uppercase tracking-wider rounded-xl border flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                          editPubEmblemType === "url"
                            ? "bg-amber-500/20 border-amber-500 text-amber-400 font-extrabold"
                            : "bg-slate-950 border-slate-800 text-slate-500"
                        }`}
                      >
                        <Image className="w-3.5 h-3.5" /> Picture URL
                      </button>
                    </div>

                    {editPubEmblemType === "emoji" ? (
                      <div className="grid grid-cols-8 sm:grid-cols-9 gap-1 p-1.5 bg-slate-950 border border-slate-800 rounded-xl max-h-32 overflow-y-auto custom-scrollbar">
                        {[
                          "🍺", "🍻", "🥂", "🍷", "🥃", "🍹", "🥤", "🍾", "🍕", "🍔", "🍟", "🌮", "🌯", "🥨", "🍖", "🥩", "🍗", "🌭", "🧀", "🍿", "🍳", "🥓", "🍩", "🍪", "🔥", "❤️", "🎉", "✨", "🌟", "👑", "🏰", "🎪", "🎯", "🎲", "🎰", "🎮", "🎸", "🥁", "🐉", "🦁", "🐺", "🐻", "🦅", "🦉", "🦖", "🦄", "🍀", "⚓", "🏴‍☠️", "🏴", "🚀", "🛸", "👾", "🤖", "👹", "💀", "💩"
                        ].map((em) => (
                          <button
                            key={em}
                            type="button"
                            onClick={() => setEditPubEmoji(em)}
                            className={`p-1 text-[13px] sm:text-base rounded hover:bg-slate-800 transition-all text-center flex items-center justify-center select-none cursor-pointer ${
                              editPubEmoji === em ? "bg-amber-500/20 scale-110 border border-amber-500/30" : ""
                            }`}
                          >
                            {em}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div>
                        <input
                          type="text"
                          placeholder="https://images.unsplash.com/photo-..."
                          value={editPubUrl}
                          onChange={(e) => setEditPubUrl(e.target.value)}
                          className="w-full px-3.5 py-2 text-sm bg-slate-950 border border-slate-800 rounded-xl focus:outline-none focus:border-amber-500 text-slate-100 placeholder-slate-500 font-semibold"
                        />
                        <p className="text-[9px] text-slate-400 mt-1">Provide a direct web image path/link to set as your custom pub emblem.</p>
                      </div>
                    )}
                  </div>

                  <div className="bg-slate-950/40 border border-slate-800/60 rounded-2xl p-3.5">
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                      Who Can Join
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setEditPubIsPrivate(false)}
                        className={`flex-1 py-1.5 px-2.5 text-[10px] font-black uppercase tracking-wider rounded-xl border flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                          !editPubIsPrivate
                            ? "bg-amber-500/20 border-amber-500 text-amber-400 font-extrabold"
                            : "bg-slate-950 border-slate-800 text-slate-500"
                        }`}
                      >
                        <Globe className="w-3.5 h-3.5" /> Public
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditPubIsPrivate(true)}
                        className={`flex-1 py-1.5 px-2.5 text-[10px] font-black uppercase tracking-wider rounded-xl border flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                          editPubIsPrivate
                            ? "bg-amber-500/20 border-amber-500 text-amber-400 font-extrabold"
                            : "bg-slate-950 border-slate-800 text-slate-500"
                        }`}
                      >
                        <Lock className="w-3.5 h-3.5" /> Private
                      </button>
                    </div>
                    <p className="text-[9px] text-slate-400 mt-1.5">
                      {editPubIsPrivate
                        ? "Private - only people you invite can join."
                        : "Public - anyone can find and join this Pub."}
                    </p>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full py-2.5 bg-amber-500 hover:bg-amber-600 active:scale-[0.98] text-slate-950 font-black text-xs sm:text-sm uppercase tracking-wider rounded-xl shadow-lg hover:shadow-amber-500/10 transition-all flex items-center justify-center gap-1 cursor-pointer mt-2"
                  >
                    {submitting ? "Saving..." : "Save Changes"}
                  </button>
                </form>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Customize Widgets Modal */}
      <AnimatePresence>
        {showWidgetModal && (
          <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-[110] flex items-start sm:items-center justify-center overflow-y-auto p-3 sm:p-4 py-6 animate-in fade-in duration-200">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md shadow-2xl flex flex-col overflow-hidden max-h-[92dvh]"
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-4 shrink-0">
                <h3 className="font-extrabold text-slate-100 text-sm sm:text-base flex items-center gap-2">
                  <Settings2 className="w-5 h-5 text-amber-500" />
                  Customize Widgets
                </h3>
                <button type="button" onClick={() => setShowWidgetModal(false)} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 cursor-pointer">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
                {/* Active widgets */}
                <div>
                  <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500 mb-2">
                    Your Widgets ({draftWidgets.length}/6)
                  </p>
                  {draftWidgets.length === 0 ? (
                    <p className="text-xs text-slate-500 italic p-3 rounded-xl border border-dashed border-slate-700 text-center">
                      No widgets yet — add one below.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {draftWidgets.map((w) => {
                        const catalogEntry = WIDGET_CATALOG.find((c) => c.type === w.type);
                        const Icon = catalogEntry?.icon || Beer;
                        return (
                          <div key={w.id} className="flex items-center gap-2.5 p-2.5 rounded-xl bg-slate-800/60 border border-slate-700/60">
                            <Icon className="w-4 h-4 text-amber-500 shrink-0" />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-bold text-slate-100 truncate">{w.label}</p>
                              <p className="text-[10px] text-slate-500">{catalogEntry?.name}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeDraftWidget(w.id)}
                              className="p-1.5 rounded-lg hover:bg-rose-500/10 text-slate-400 hover:text-rose-400 cursor-pointer shrink-0"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Add a widget */}
                <div>
                  <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500 mb-2">Add a Widget</p>
                  <div className="space-y-2">
                    {/* Beverage Gauge - needs a keyword */}
                    <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/60 space-y-2">
                      <div className="flex items-center gap-2">
                        <Beer className="w-4 h-4 text-amber-500 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-slate-100">Beverage Gauge</p>
                          <p className="text-[10px] text-slate-500">% of pints matching a beer or style you pick</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={newBeverageKeyword}
                          onChange={(e) => setNewBeverageKeyword(e.target.value)}
                          placeholder="e.g. IPA, Guinness, Sour"
                          maxLength={30}
                          className="flex-1 min-w-0 px-3 py-2 text-xs rounded-lg bg-slate-900 border border-slate-700 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-amber-500"
                        />
                        <button
                          type="button"
                          onClick={() => addCatalogWidget("beverage-gauge")}
                          className="px-3 py-2 rounded-lg bg-amber-500 text-slate-950 text-xs font-extrabold hover:brightness-110 cursor-pointer shrink-0"
                        >
                          Add
                        </button>
                      </div>
                    </div>

                    {/* Fixed-config widgets */}
                    {WIDGET_CATALOG.filter((c) => c.type !== "beverage-gauge").map((c) => {
                      const Icon = c.icon;
                      const alreadyAdded = draftWidgets.some((w) => w.type === c.type);
                      return (
                        <div key={c.type} className="flex items-center gap-2.5 p-3 rounded-xl bg-slate-800/40 border border-slate-700/60">
                          <Icon className="w-4 h-4 text-amber-500 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-bold text-slate-100">{c.name}</p>
                            <p className="text-[10px] text-slate-500">{c.blurb}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => addCatalogWidget(c.type)}
                            disabled={alreadyAdded}
                            className="px-3 py-2 rounded-lg bg-amber-500 text-slate-950 text-xs font-extrabold hover:brightness-110 cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {alreadyAdded ? "Added" : "Add"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {widgetError && (
                  <div className="p-2.5 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-xs font-semibold flex items-center gap-2">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {widgetError}
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="flex items-center gap-2.5 border-t border-slate-800/80 px-5 py-4 shrink-0">
                <button
                  type="button"
                  onClick={() => setShowWidgetModal(false)}
                  className="flex-1 py-2.5 rounded-xl bg-slate-800 text-slate-300 text-xs font-extrabold hover:bg-slate-700 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveWidgets}
                  disabled={widgetSaving}
                  className="flex-1 py-2.5 rounded-xl bg-amber-500 text-slate-950 text-xs font-extrabold hover:brightness-110 cursor-pointer disabled:opacity-60"
                >
                  {widgetSaving ? "Saving..." : "Save Widgets"}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
