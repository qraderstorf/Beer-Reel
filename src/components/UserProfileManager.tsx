import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Check, Calendar, Sparkles, X, Smile, Trash2, Trophy, Flame, Award, Shield, Heart, ZoomIn, ZoomOut, Pencil, ArrowLeft, Ban, Flag } from "lucide-react";
import { UserProfile, BeerLog, ContentReport, isSeymoreBeers } from "../types";
import { getMostDrankBeerForUser, compressImage, useRetryImage, convertHeicIfNeeded } from "../utils";
import UserAvatar from "./UserAvatar";
import FriendsHub from "./FriendsHub";
import WeeklyRecap from "./WeeklyRecap";

interface UserProfileManagerProps {
  users: UserProfile[];
  currentUser: string;
  logs: BeerLog[];
  onCurrentUserChanged: (username: string) => void;
  onProfileAddedOrUpdated: (profile: UserProfile) => void;
  onProfileDeleted: (username: string) => void;
  onSelfAccountDeleted: (password: string) => Promise<{ success: boolean; error?: string }>;
  isOpen: boolean;
  onClose: () => void;
  viewingUsername?: string | null;
  clientUseFirestore: boolean;
  onViewProfileRequested?: (username: string) => void;
  onBackToMyProfile?: () => void;
}

const COMMON_EMOJIS = ["🍻", "🍺", "☕", "🍋", "🍊", "🍷", "🍹", "🥂", "🥃", "🍔", "🍕", "😎", "👾", "🦊", "🐼", "🦁", "👑"];

const REPORT_REASONS = [
  "Spam",
  "Harassment or bullying",
  "Fake account / impersonation",
  "Inappropriate or offensive content",
  "Underage user",
  "Other",
];

function getLocalDateString(dateInput: Date | string | number, timeZone: string): string {
  const d = new Date(dateInput);
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(d);
    const year = parts.find(p => p.type === 'year')?.value;
    const month = parts.find(p => p.type === 'month')?.value;
    const day = parts.find(p => p.type === 'day')?.value;
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch (e) {
    console.error("Error formatting date for timezone:", timeZone, e);
  }
  const localDate = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return localDate.toISOString().split('T')[0];
}

function getDayDifference(dateStr1: string, dateStr2: string): number {
  const d1 = new Date(dateStr1 + "T12:00:00");
  const d2 = new Date(dateStr2 + "T12:00:00");
  const diffTime = d2.getTime() - d1.getTime();
  return Math.round(diffTime / (1000 * 60 * 60 * 24));
}

function StatChip({ label, value, emoji, colorClass, title }: { label: string; value: string | number; emoji: string; colorClass: string; title?: string }) {
  const isWordy = typeof value === "string" && value.length > 4;
  return (
    <div className={`rounded-xl p-2.5 flex flex-col items-center justify-center text-center border ${colorClass}`} title={title}>
      <span className="text-[8px] font-bold uppercase tracking-wider opacity-70">{label}</span>
      <span className={`font-black mt-0.5 flex items-center gap-1 ${isWordy ? "text-[11px] flex-col gap-0" : "text-base"}`}>
        <span className={isWordy ? "text-base" : ""}>{emoji}</span>
        <span className="leading-tight">{value}</span>
      </span>
    </div>
  );
}

export default function UserProfileManager({
  users,
  currentUser,
  logs,
  onCurrentUserChanged,
  onProfileAddedOrUpdated,
  onProfileDeleted,
  onSelfAccountDeleted,
  isOpen,
  onClose,
  viewingUsername,
  clientUseFirestore,
  onViewProfileRequested,
  onBackToMyProfile
}: UserProfileManagerProps) {
  const [showWeeklyRecap, setShowWeeklyRecap] = useState(false);

  // My Profile Edit States
  const [myRealName, setMyRealName] = useState("");
  const [myEmail, setMyEmail] = useState("");
  const [myAvatar, setMyAvatar] = useState("🍻");
  const [myBio, setMyBio] = useState("");
  const [myCurrentPassword, setMyCurrentPassword] = useState("");
  const [myNewPassword, setMyNewPassword] = useState("");
  const [regeneratingRecoveryCode, setRegeneratingRecoveryCode] = useState(false);
  const [recoveryCodeError, setRecoveryCodeError] = useState<string | null>(null);
  const [newRecoveryCode, setNewRecoveryCode] = useState<string | null>(null);
  const [myPhotoUrl, setMyPhotoUrl] = useState<string | null>(null);
  const myPhotoPreview = useRetryImage(myPhotoUrl);
  const [myError, setMyError] = useState<string | null>(null);
  const [mySuccess, setMySuccess] = useState(false);
  const [isUpdatingMyProfile, setIsUpdatingMyProfile] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [prevOpen, setPrevOpen] = useState(false);
  const [loadedUsername, setLoadedUsername] = useState<string | null>(null);

  // Dynamic user stats from separate data path
  const [profileStats, setProfileStats] = useState<{
    totalPints: number;
    avgRating: string;
    favoriteStyle: string;
    totalCheers: number;
    theUsualBeerName: string;
    theUsualCount: number;
    goldenHourLabel: string;
    goldenHourEmoji: string;
    firstPourCount: number;
    longestDryStreak: number;
    currentDryStreak: number;
  } | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  // Photo Cropper States
  const [croppingImageSrc, setCroppingImageSrc] = useState<string | null>(null);
  const [cropZoom, setCropZoom] = useState<number>(1);
  const [cropPan, setCropPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDraggingCrop, setIsDraggingCrop] = useState<boolean>(false);
  const dragStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [editorImgSize, setEditorImgSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const cropImgRef = useRef<HTMLImageElement | null>(null);

  // Mouse & Touch events for profile photo cropping
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingCrop(true);
    dragStart.current = { x: e.clientX - cropPan.x, y: e.clientY - cropPan.y };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDraggingCrop) return;
    setCropPan({
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y
    });
  };

  const handleMouseUpOrLeave = () => {
    setIsDraggingCrop(false);
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 1) {
      setIsDraggingCrop(true);
      const touch = e.touches[0];
      dragStart.current = { x: touch.clientX - cropPan.x, y: touch.clientY - cropPan.y };
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isDraggingCrop) return;
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      setCropPan({
        x: touch.clientX - dragStart.current.x,
        y: touch.clientY - dragStart.current.y
      });
    }
  };

  const handleApplyCrop = () => {
    if (!cropImgRef.current) return;
    const imgElement = cropImgRef.current;
    
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, 256, 256);
      
      // S maps from the 160px screen crop zone to 256px high-res canvas output
      const S = 256 / 160;
      
      const drawW = editorImgSize.width * cropZoom * S;
      const drawH = editorImgSize.height * cropZoom * S;
      
      const drawX = 128 + (cropPan.x * S) - (drawW / 2);
      const drawY = 128 + (cropPan.y * S) - (drawH / 2);
      
      ctx.drawImage(imgElement, drawX, drawY, drawW, drawH);
      
      try {
        const croppedBase64 = canvas.toDataURL("image/jpeg", 0.85);
        setMyPhotoUrl(croppedBase64);
        setCroppingImageSrc(null);
      } catch (err) {
        console.error("Canvas crop extraction failed:", err);
      }
    }
  };

  // Deletion confirm state
  const [deleteConfirmUser, setDeleteConfirmUser] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState("");

  // Self-service "delete my account" state
  const [showSelfDeleteForm, setShowSelfDeleteForm] = useState(false);
  const [selfDeletePassword, setSelfDeletePassword] = useState("");
  const [selfDeleteConfirmText, setSelfDeleteConfirmText] = useState("");
  const [selfDeleteError, setSelfDeleteError] = useState<string | null>(null);
  const [isDeletingSelf, setIsDeletingSelf] = useState(false);

  const handleSelfDeleteSubmit = async () => {
    setSelfDeleteError(null);
    setIsDeletingSelf(true);
    const result = await onSelfAccountDeleted(selfDeletePassword);
    setIsDeletingSelf(false);
    if (!result.success) {
      setSelfDeleteError(result.error || "Failed to delete your account.");
    }
    // On success the app logs the user out and unmounts this modal, so
    // there's no local state left to clean up here.
  };

  // Determine if we are in "Viewer Capacity" for another user
  const isViewOnly = !!viewingUsername && viewingUsername.toLowerCase() !== currentUser.toLowerCase();

  // Find the user we are currently displaying (either the viewed user or the active user)
  const displayedUsername = isViewOnly ? viewingUsername! : currentUser;
  const targetUser = users.find((u) => u.username.toLowerCase() === displayedUsername.toLowerCase()) || {
    username: displayedUsername,
    avatar: "🍻",
    favoriteStyle: "IPA",
    joinedDate: new Date().toISOString().split("T")[0],
    bio: "Pub member.",
    realName: displayedUsername
  };

  // Block / Unblock the currently-viewed user
  const [isBlockActionPending, setIsBlockActionPending] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);

  // Report the currently-viewed user
  const [showReportForm, setShowReportForm] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reportNote, setReportNote] = useState("");
  const [reportError, setReportError] = useState<string | null>(null);
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);
  const [reportSubmitted, setReportSubmitted] = useState(false);

  const myProfile = users.find((u) => u.username === currentUser);
  const isTargetBlocked = (myProfile?.blockedUsers || []).some(
    (b) => b.toLowerCase() === targetUser.username.toLowerCase()
  );

  const handleToggleBlock = async () => {
    setIsBlockActionPending(true);
    setBlockError(null);
    try {
      const endpoint = isTargetBlocked ? "unblock" : "block";
      const res = await fetch(`/api/users/${encodeURIComponent(currentUser)}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUsername: targetUser.username, currentUser }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not update block status.");
      (data.users || []).forEach((u: UserProfile) => onProfileAddedOrUpdated(u));
    } catch (err: any) {
      setBlockError(err.message || "Something went wrong.");
    } finally {
      setIsBlockActionPending(false);
    }
  };

  const handleSubmitReport = async () => {
    if (!reportReason) {
      setReportError("Please select a reason.");
      return;
    }
    setIsSubmittingReport(true);
    setReportError(null);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reporterUsername: currentUser,
          targetType: "user",
          targetId: targetUser.username,
          targetUsername: targetUser.username,
          reason: reportReason,
          note: reportNote.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not submit report.");
      setReportSubmitted(true);
      setTimeout(() => {
        setShowReportForm(false);
        setReportSubmitted(false);
        setReportReason("");
        setReportNote("");
      }, 1800);
    } catch (err: any) {
      setReportError(err.message || "Something went wrong.");
    } finally {
      setIsSubmittingReport(false);
    }
  };

  // Reset block/report UI state whenever the viewed profile changes
  useEffect(() => {
    setShowReportForm(false);
    setReportReason("");
    setReportNote("");
    setReportError(null);
    setReportSubmitted(false);
    setBlockError(null);
  }, [viewingUsername]);

  // Sync profile data when current user changes or modal opens
  useEffect(() => {
    if (isOpen && (loadedUsername !== currentUser || !prevOpen)) {
      const profile = users.find((u) => u.username === currentUser);
      if (profile) {
        setMyAvatar(profile.avatar || "🍻");
        setMyBio(profile.bio || "");
        setMyCurrentPassword("");
        setMyNewPassword("");
        setNewRecoveryCode(null);
        setRecoveryCodeError(null);
        setMyRealName(profile.realName || "");
        setMyEmail(profile.email || "");
        setMyPhotoUrl(profile.photoUrl || null);
        setLoadedUsername(currentUser);
        setIsEditing(false);
      }
    }
    if (isOpen && !prevOpen) {
      setShowSelfDeleteForm(false);
      setSelfDeletePassword("");
      setSelfDeleteConfirmText("");
      setSelfDeleteError(null);
    }
    setPrevOpen(isOpen);
  }, [currentUser, users, isOpen, prevOpen, loadedUsername]);

  // HEIC (the iPhone camera default) doesn't decode via <img> on non-WebKit browsers,
  // so it needs converting to JPEG before it can be shown in the crop preview at all.
  const loadFileForCropping = async (file: File) => {
    const converted = await convertHeicIfNeeded(file);
    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) {
        setCroppingImageSrc(event.target.result as string);
      }
    };
    reader.readAsDataURL(converted);
  };

  // Handle Edit Profile submission
  const handleEditMyProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUpdatingMyProfile(true);
    setMyError(null);
    setMySuccess(false);

    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: currentUser,
          favoriteStyle: "Other",
          avatar: myAvatar,
          bio: myBio.trim(),
          currentPassword: myCurrentPassword,
          password: myNewPassword.trim() || undefined,
          realName: myRealName.trim() || undefined,
          email: myEmail.trim() || undefined,
          // Always send an explicit value (never omit the key) - this form always knows
          // the intended final photo state, including "the user just cleared it," which
          // an omitted key can't distinguish from "don't touch this field."
          photoUrl: myPhotoUrl || ""
        }),
      });

      const savedProfile = await response.json();
      if (!response.ok) {
        throw new Error(savedProfile.error || "Failed to update profile.");
      }

      onProfileAddedOrUpdated(savedProfile);
      setMyCurrentPassword("");
      setMyNewPassword("");
      setMySuccess(true);
      setTimeout(() => {
        setMySuccess(false);
        setIsEditing(false);
      }, 1500);
    } catch (err: any) {
      setMyError(err.message || "An error occurred while saving profile changes.");
    } finally {
      setIsUpdatingMyProfile(false);
    }
  };

  // Regenerates the self-service password-recovery code (also covers accounts created
  // before this feature existed and so have never had one). Requires the current
  // password as proof of identity, same as any other account change on this screen.
  const handleRegenerateRecoveryCode = async () => {
    if (!myCurrentPassword) {
      setRecoveryCodeError("Enter your current password above first, then regenerate.");
      return;
    }
    setRegeneratingRecoveryCode(true);
    setRecoveryCodeError(null);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(currentUser)}/recovery-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: myCurrentPassword }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to generate a recovery code.");
      }
      setNewRecoveryCode(data.recoveryCode);
    } catch (err: any) {
      setRecoveryCodeError(err.message || "Failed to generate a recovery code.");
    } finally {
      setRegeneratingRecoveryCode(false);
    }
  };

  // Load and calculate Profile Statistics on-demand when the profile modal opens
  useEffect(() => {
    if (!isOpen || !displayedUsername) {
      setProfileStats(null);
      return;
    }

    let isMounted = true;

    const fetchStats = async () => {
      setLoadingStats(true);
      setStatsError(null);
      try {
        const response = await fetch(`/api/users/${encodeURIComponent(displayedUsername)}/stats`);
        if (!response.ok) {
          throw new Error("Failed to fetch user stats from server");
        }
        const data = await response.json();
        if (isMounted) {
          setProfileStats({
            totalPints: data.totalPints,
            avgRating: data.avgRating,
            favoriteStyle: data.favoriteStyle,
            totalCheers: data.totalCheers,
            theUsualBeerName: data.theUsualBeerName || "",
            theUsualCount: data.theUsualCount || 0,
            goldenHourLabel: data.goldenHourLabel || "TBD",
            goldenHourEmoji: data.goldenHourEmoji || "🕐",
            firstPourCount: data.firstPourCount || 0,
            longestDryStreak: data.longestDryStreak || 0,
            currentDryStreak: data.currentDryStreak || 0
          });
        }
      } catch (err: any) {
        console.error("Failed to load profile stats:", err);
        if (isMounted) {
          setStatsError(err.message || "Could not load stats.");
        }
      } finally {
        if (isMounted) {
          setLoadingStats(false);
        }
      }
    };

    fetchStats();

    return () => {
      isMounted = false;
    };
  }, [isOpen, displayedUsername, clientUseFirestore]);

  // Admin-only: load open content/user reports when the modal opens
  const [reports, setReports] = useState<ContentReport[]>([]);
  const [loadingReports, setLoadingReports] = useState(false);
  const [resolvingReportId, setResolvingReportId] = useState<string | null>(null);
  const isAdmin = isSeymoreBeers(currentUser);

  useEffect(() => {
    if (!isOpen || isViewOnly || !isAdmin) return;
    let isMounted = true;
    (async () => {
      setLoadingReports(true);
      try {
        const res = await fetch(`/api/reports?currentUser=${encodeURIComponent(currentUser)}`);
        if (res.ok) {
          const data = await res.json();
          if (isMounted) setReports(data);
        }
      } catch (err) {
        console.error("Failed to load reports:", err);
      } finally {
        if (isMounted) setLoadingReports(false);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [isOpen, isViewOnly, isAdmin, currentUser]);

  const handleResolveReport = async (reportId: string) => {
    setResolvingReportId(reportId);
    try {
      const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentUser }),
      });
      if (res.ok) {
        setReports((prev) => prev.map((r) => (r.id === reportId ? { ...r, status: "resolved" } : r)));
      }
    } catch (err) {
      console.error("Failed to resolve report:", err);
    } finally {
      setResolvingReportId(null);
    }
  };

  if (!isOpen) return null;

  const showEditForm = !isViewOnly && isEditing;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 15 }}
        className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col"
      >
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-150 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2 min-w-0">
            {isViewOnly ? (
              <button
                onClick={onBackToMyProfile}
                title="Back to my profile"
                className="p-1 -ml-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600 transition-all focus:outline-none cursor-pointer shrink-0"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            ) : (
              <Trophy className="w-4 h-4 text-amber-500 animate-pulse shrink-0" />
            )}
            <h2 className="text-md font-bold text-slate-800 tracking-tight truncate">
              {isViewOnly ? `${targetUser.realName || targetUser.username}'s Profile` : "My Profile & Career Stats"}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600 transition-all focus:outline-none cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Content */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {/* Active Admin Mode Display */}
          {isSeymoreBeers(currentUser) && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-emerald-800 text-[11px] font-bold">
              🔓 <span className="font-extrabold text-emerald-950">Admin Mode Activated:</span> You are browsing as <span className="italic">Seymore Beers</span>. You can delete any pint check-ins or user profiles across the app.
            </div>
          )}

          {!showEditForm ? (
            /* VIEW PROFILE (EITHER OTHER USER OR SELF) */
            <div className="space-y-6">
              <div className="flex items-center gap-4 pb-5 border-b border-slate-100">
                <UserAvatar username={targetUser.username} users={users} className="w-16 h-16 sm:w-20 sm:h-20 text-2xl sm:text-3xl border-2 border-amber-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-black text-slate-800 tracking-tight truncate">
                      {targetUser.realName || targetUser.username}
                    </h3>
                    {!isViewOnly && (
                      <button
                        onClick={() => setIsEditing(true)}
                        title="Edit Profile"
                        className="p-1.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg transition-all shadow-sm cursor-pointer shrink-0"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <span className="text-xs text-slate-400 font-bold block">@{targetUser.username}</span>
                  <p className="text-xs text-slate-500 italic font-medium leading-snug mt-1.5 line-clamp-2">
                    "{targetUser.bio || "No bio added yet."}"
                  </p>
                  <div className="flex items-center gap-1 text-[9px] text-slate-400 font-bold uppercase tracking-wider mt-1.5">
                    <Calendar className="w-3 h-3 text-slate-300" />
                    <span>Joined {targetUser.joinedDate}</span>
                  </div>
                </div>
              </div>

              {/* Block / Report actions - only shown when looking at someone else's profile */}
              {isViewOnly && (
                <div className="space-y-2 -mt-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleToggleBlock}
                      disabled={isBlockActionPending}
                      className={`flex items-center gap-1.5 text-[11px] font-bold rounded-lg px-2.5 py-1.5 transition-colors cursor-pointer disabled:opacity-50 ${
                        isTargetBlocked
                          ? "text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                          : "text-slate-500 hover:text-red-600 hover:bg-red-50"
                      }`}
                    >
                      <Ban className="w-3.5 h-3.5" />
                      {isBlockActionPending ? "..." : isTargetBlocked ? "Unblock" : "Block"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowReportForm((v) => !v)}
                      className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg px-2.5 py-1.5 transition-colors cursor-pointer"
                    >
                      <Flag className="w-3.5 h-3.5" />
                      Report
                    </button>
                  </div>
                  {blockError && <p className="text-red-600 text-[11px] font-semibold">{blockError}</p>}
                  {isTargetBlocked && (
                    <p className="text-[11px] text-slate-400 font-medium">
                      You've blocked @{targetUser.username}. Their pints and comments are hidden from you.
                    </p>
                  )}

                  {showReportForm && (
                    <div className="p-3.5 bg-red-50 border border-red-200 rounded-xl text-xs space-y-2.5">
                      {reportSubmitted ? (
                        <p className="text-emerald-700 font-bold flex items-center gap-1.5">
                          <Check className="w-4 h-4" /> Report submitted. Thanks for flagging this.
                        </p>
                      ) : (
                        <>
                          <p className="text-red-700 font-bold">Report @{targetUser.username}</p>
                          <div className="space-y-1">
                            <label htmlFor="report-reason-select" className="text-[9px] text-red-500 font-bold uppercase block">
                              Reason
                            </label>
                            <select
                              id="report-reason-select"
                              value={reportReason}
                              onChange={(e) => setReportReason(e.target.value)}
                              className="w-full px-2.5 py-1.5 border border-red-200 rounded bg-white text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-red-500"
                            >
                              <option value="">Select a reason...</option>
                              {REPORT_REASONS.map((r) => (
                                <option key={r} value={r}>{r}</option>
                              ))}
                            </select>
                          </div>
                          <div className="space-y-1">
                            <label htmlFor="report-note-input" className="text-[9px] text-red-500 font-bold uppercase block">
                              Additional details (optional)
                            </label>
                            <input
                              id="report-note-input"
                              type="text"
                              placeholder="Anything else we should know?"
                              value={reportNote}
                              onChange={(e) => setReportNote(e.target.value)}
                              className="w-full px-2.5 py-1.5 border border-red-200 rounded bg-white text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-red-500"
                            />
                          </div>
                          {reportError && <p className="text-red-700 font-semibold text-[11px]">{reportError}</p>}
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              disabled={isSubmittingReport}
                              onClick={handleSubmitReport}
                              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white font-bold rounded cursor-pointer transition-colors text-[11px] shrink-0"
                            >
                              {isSubmittingReport ? "Submitting..." : "Submit Report"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setShowReportForm(false)}
                              className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded cursor-pointer transition-colors text-[11px] shrink-0"
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Weekly Recap trigger */}
              <button
                onClick={() => setShowWeeklyRecap(true)}
                className="w-full flex items-center justify-between gap-2 px-4 py-3 bg-gradient-to-r from-amber-400 to-orange-500 hover:from-amber-500 hover:to-orange-600 text-slate-950 rounded-2xl shadow-md transition-all cursor-pointer"
              >
                <span className="text-sm font-black flex items-center gap-2">
                  🎉 {isViewOnly ? `${targetUser.realName || targetUser.username}'s Week` : "Your Week"}
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">See Recap →</span>
              </button>

              {/* Stats Section */}
              <div className="space-y-2.5">
                <span className="block text-xs font-bold uppercase tracking-wider text-slate-400">
                  {isViewOnly ? "Career Stats" : "My Career Stats"}
                </span>
                {loadingStats || !profileStats ? (
                  <div className="space-y-2.5">
                    <div className="grid grid-cols-2 gap-2.5">
                      {[1, 2].map((idx) => (
                        <div key={idx} className="bg-slate-100 rounded-2xl h-20 animate-pulse" />
                      ))}
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {[1, 2, 3, 4, 5, 6].map((idx) => (
                        <div key={idx} className="bg-slate-100 rounded-xl h-16 animate-pulse" />
                      ))}
                    </div>
                  </div>
                ) : statsError ? (
                  <div className="text-xs text-red-500 font-semibold p-2 bg-red-50 rounded-lg">
                    ⚠️ {statsError}
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {/* Hero stats */}
                    <div className="grid grid-cols-2 gap-2.5">
                      <div className="bg-gradient-to-br from-amber-400 to-orange-500 rounded-2xl p-3.5 text-slate-950 shadow-md">
                        <span className="text-[9px] font-black uppercase tracking-wider text-slate-950/60">Total Pints</span>
                        <div className="text-2xl sm:text-3xl font-black mt-0.5">🍺 {profileStats.totalPints}</div>
                      </div>
                      <div className="bg-gradient-to-br from-amber-300 to-yellow-500 rounded-2xl p-3.5 text-slate-950 shadow-md">
                        <span className="text-[9px] font-black uppercase tracking-wider text-slate-950/60">Avg Rating</span>
                        <div className="text-2xl sm:text-3xl font-black mt-0.5">⭐ {profileStats.avgRating}</div>
                      </div>
                    </div>

                    {/* Secondary stats */}
                    <div className="grid grid-cols-3 gap-2">
                      <StatChip
                        label="Beer/Day"
                        emoji="🍺"
                        colorClass="bg-amber-50 border-amber-100 text-amber-700"
                        value={(() => {
                          if (!profileStats || !profileStats.totalPints) return "0.0";
                          const joinedStr = targetUser.joinedDate || new Date().toISOString();
                          const joinedTime = new Date(joinedStr).getTime();
                          const diffMs = Date.now() - joinedTime;
                          const diffDays = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
                          return (profileStats.totalPints / diffDays).toFixed(1);
                        })()}
                      />
                      <StatChip
                        label="First Pours"
                        emoji="🌅"
                        colorClass="bg-red-50 border-red-100 text-red-600"
                        value={profileStats.firstPourCount}
                      />
                      <StatChip
                        label="The Usual"
                        emoji="🔁"
                        colorClass="bg-orange-50 border-orange-100 text-orange-700"
                        value={profileStats.theUsualCount > 0 ? `${profileStats.theUsualCount}×` : "—"}
                        title={profileStats.theUsualBeerName ? `Your usual: ${profileStats.theUsualBeerName}` : undefined}
                      />
                      <StatChip
                        label="Golden Hour"
                        emoji={profileStats.goldenHourEmoji}
                        colorClass="bg-emerald-50 border-emerald-100 text-emerald-700"
                        value={profileStats.goldenHourLabel}
                      />
                      <StatChip
                        label="Longest Dry"
                        emoji="🏛️"
                        colorClass="bg-sky-50 border-sky-100 text-sky-700"
                        value={`${profileStats.longestDryStreak}d`}
                        title="My Body Is A Temple - your longest streak on record"
                      />
                      <StatChip
                        label="Current Dry"
                        emoji="🧘"
                        colorClass="bg-cyan-50 border-cyan-100 text-cyan-700"
                        value={`${profileStats.currentDryStreak}d`}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Friends management */}
              {!isViewOnly && (
                <div className="pt-2">
                  <FriendsHub
                    currentUser={currentUser}
                    users={users}
                    onProfileAddedOrUpdated={onProfileAddedOrUpdated}
                    onViewProfileRequested={onViewProfileRequested}
                  />
                </div>
              )}

              {/* Self-service account deletion */}
              {!isViewOnly && (
                <div className="space-y-2 pt-2">
                  <span className="block text-xs font-bold uppercase tracking-wider text-slate-400">
                    Danger Zone
                  </span>
                  {!showSelfDeleteForm ? (
                    <button
                      type="button"
                      onClick={() => setShowSelfDeleteForm(true)}
                      className="flex items-center gap-1.5 text-[11px] font-bold text-red-500 hover:text-red-600 hover:bg-red-50 rounded-lg px-2.5 py-1.5 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete My Account
                    </button>
                  ) : (
                    <div className="p-3.5 bg-red-50 border border-red-200 rounded-xl text-xs space-y-3">
                      <div>
                        <p className="text-red-700 font-bold">⚠️ Delete your account permanently?</p>
                        <p className="text-red-600 text-[11px] font-normal leading-relaxed mt-1">
                          This deletes your profile and every pint you've logged. You'll be removed from
                          any friends lists. This cannot be undone.
                        </p>
                      </div>

                      <div className="space-y-1">
                        <label htmlFor="self-delete-password" className="text-[9px] text-red-500 font-bold uppercase block">
                          Enter your password
                        </label>
                        <input
                          id="self-delete-password"
                          type="password"
                          placeholder="Your account password"
                          value={selfDeletePassword}
                          onChange={(e) => setSelfDeletePassword(e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-red-200 rounded bg-white text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-red-500"
                        />
                      </div>

                      <div className="space-y-1">
                        <label htmlFor="self-delete-confirm" className="text-[9px] text-red-500 font-bold uppercase block">
                          Type <span className="underline font-extrabold">DELETE</span> to confirm
                        </label>
                        <input
                          id="self-delete-confirm"
                          type="text"
                          placeholder="DELETE"
                          value={selfDeleteConfirmText}
                          onChange={(e) => setSelfDeleteConfirmText(e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-red-200 rounded bg-white text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-red-500"
                        />
                      </div>

                      {selfDeleteError && (
                        <p className="text-red-700 font-semibold text-[11px]">{selfDeleteError}</p>
                      )}

                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          disabled={selfDeleteConfirmText !== "DELETE" || !selfDeletePassword || isDeletingSelf}
                          onClick={handleSelfDeleteSubmit}
                          className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white font-bold rounded cursor-pointer transition-colors text-[11px] shrink-0"
                        >
                          {isDeletingSelf ? "Deleting..." : "Permanently Delete"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowSelfDeleteForm(false);
                            setSelfDeletePassword("");
                            setSelfDeleteConfirmText("");
                            setSelfDeleteError(null);
                          }}
                          className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded cursor-pointer transition-colors text-[11px] shrink-0"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Admin-only: full user directory with delete capability */}
              {!isViewOnly && isSeymoreBeers(currentUser) && (
                <div className="space-y-3 pt-2">
                  <span className="block text-xs font-bold uppercase tracking-wider text-slate-400">
                    🔓 Admin: All Users ({users.length})
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {users.map((user) => (
                      <div
                        key={user.username}
                        className="p-2.5 rounded-xl border border-slate-200 bg-white flex flex-col gap-2"
                      >
                        <div className="flex items-center gap-2.5">
                          <UserAvatar username={user.username} users={users} className="w-8 h-8 border border-slate-200" />
                          <div className="min-w-0 flex-1">
                            <span className="font-extrabold text-slate-800 text-xs truncate block">
                              {user.realName || user.username}
                            </span>
                            <span className="text-[10px] text-slate-400 font-semibold truncate block">@{user.username}</span>
                          </div>
                          {users.length > 1 && (
                            <button
                              type="button"
                              onClick={() => {
                                setDeleteConfirmUser(user.username);
                                setConfirmInput("");
                              }}
                              className="text-slate-400 hover:text-red-600 hover:bg-red-50 p-1.5 rounded-md transition-colors focus:outline-none shrink-0"
                              title={`Delete ${user.username}'s profile`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>

                        {/* Safe Double-Confirmation Area */}
                        {deleteConfirmUser === user.username && (
                          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs space-y-2">
                            <p className="text-red-700 font-bold">⚠️ Confirm Deletion</p>
                            <p className="text-red-600 text-[11px] font-normal leading-relaxed">
                              This deletes this profile and all their logged pints permanently.
                            </p>
                            <div className="space-y-1">
                              <label className="text-[9px] text-red-500 font-bold uppercase block">
                                Type <span className="underline font-extrabold">{user.username}</span> to confirm:
                              </label>
                              <div className="flex gap-1.5">
                                <input
                                  type="text"
                                  placeholder={`Type ${user.username}`}
                                  value={confirmInput}
                                  onChange={(e) => setConfirmInput(e.target.value)}
                                  className="w-full px-2 py-1 border border-red-200 rounded bg-white text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-red-500"
                                />
                                <button
                                  type="button"
                                  disabled={confirmInput !== user.username}
                                  onClick={async () => {
                                    await onProfileDeleted(user.username);
                                    setDeleteConfirmUser(null);
                                    setConfirmInput("");
                                  }}
                                  className="px-2.5 py-1 bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white font-bold rounded cursor-pointer transition-colors text-[11px] shrink-0"
                                >
                                  Delete
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDeleteConfirmUser(null);
                                    setConfirmInput("");
                                  }}
                                  className="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold rounded cursor-pointer transition-colors text-[11px] shrink-0"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Admin-only: user & content reports queue */}
              {!isViewOnly && isAdmin && (
                <div className="space-y-3 pt-2">
                  <span className="block text-xs font-bold uppercase tracking-wider text-slate-400">
                    🔓 Admin: Reports ({reports.filter((r) => r.status === "open").length} open)
                  </span>
                  {loadingReports ? (
                    <div className="text-xs text-slate-400 font-semibold">Loading reports...</div>
                  ) : reports.length === 0 ? (
                    <div className="text-xs text-slate-400 font-medium p-3 bg-slate-50 rounded-lg">
                      No reports yet.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {reports.map((report) => (
                        <div
                          key={report.id}
                          className={`p-2.5 rounded-xl border text-xs space-y-1.5 ${
                            report.status === "open"
                              ? "border-red-200 bg-red-50"
                              : "border-slate-200 bg-slate-50 opacity-60"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <span className="font-extrabold text-slate-800 block truncate">
                                {report.targetType === "user" ? "User" : report.targetType === "post" ? "Post" : "Comment"}: @{report.targetUsername || report.targetId}
                              </span>
                              <span className="text-[10px] text-slate-500 font-semibold block">
                                Reported by @{report.reporterUsername} &middot; {new Date(report.date).toLocaleString()}
                              </span>
                            </div>
                            {report.status === "open" && (
                              <button
                                type="button"
                                disabled={resolvingReportId === report.id}
                                onClick={() => handleResolveReport(report.id)}
                                className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white font-bold rounded cursor-pointer transition-colors text-[10px] shrink-0"
                              >
                                {resolvingReportId === report.id ? "..." : "Mark Resolved"}
                              </button>
                            )}
                          </div>
                          <p className="text-slate-700 font-semibold">{report.reason}</p>
                          {report.note && <p className="text-slate-500 italic">"{report.note}"</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            /* EDIT OWN ACTIVE PROFILE */
            <div className="space-y-6">
              <div className="bg-amber-50/30 border border-amber-200/50 rounded-2xl p-5 space-y-5">
                <div className="flex items-center justify-between border-b border-amber-200/40 pb-2">
                  <span className="text-[10px] font-extrabold text-amber-800 uppercase tracking-wider block">
                    Edit Pub Profile
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsEditing(false)}
                    className="text-[10px] text-slate-500 hover:text-slate-800 font-bold uppercase tracking-wider hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    Cancel / Back
                  </button>
                </div>

                <form onSubmit={handleEditMyProfileSubmit} className="space-y-4">
                  {/* Photo Upload Zone */}
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                      My Profile Photo (Optional - Replaces Emoji)
                    </label>
                    <div className="space-y-2">
                      <div
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                            loadFileForCropping(e.dataTransfer.files[0]);
                          }
                        }}
                        onClick={() => document.getElementById("profile-photo-input")?.click()}
                        className="border-2 border-dashed border-slate-200 hover:border-amber-500 rounded-xl p-4 text-center cursor-pointer transition-all bg-white hover:bg-amber-50/10 flex flex-col items-center justify-center gap-1.5 shadow-sm"
                      >
                        {myPhotoUrl && !myPhotoPreview.failed ? (
                          <div className="relative w-16 h-16 group">
                            <img
                              key={myPhotoPreview.retryKey}
                              src={myPhotoPreview.src}
                              alt="Profile"
                              className="w-16 h-16 rounded-full object-cover border border-amber-500 shadow-sm"
                              referrerPolicy="no-referrer"
                              onError={myPhotoPreview.onError}
                            />
                            <div className="absolute inset-0 bg-black/45 rounded-full opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                              <span className="text-[9px] text-white font-bold uppercase">Change</span>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-400">
                              <Smile className="w-5 h-5 text-slate-400" />
                            </div>
                            <p className="text-[11px] text-slate-500 font-medium">
                              <span className="text-amber-600 font-bold">Drag & drop</span> or click to upload
                            </p>
                            <p className="text-[9px] text-slate-400">PNG, JPG up to 5MB</p>
                          </>
                        )}
                      </div>
                      <input
                        id="profile-photo-input"
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files && e.target.files[0]) {
                            loadFileForCropping(e.target.files[0]);
                          }
                        }}
                      />
                      {myPhotoUrl && (
                        <button
                          type="button"
                          onClick={() => setMyPhotoUrl(null)}
                          className="text-[10px] text-red-500 hover:text-red-600 font-bold uppercase tracking-wider block hover:underline"
                        >
                          Remove Photo
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Emoji Picker */}
                  {!myPhotoUrl && (
                    <div>
                      <span className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">My Profile Avatar Emoji</span>
                      <div className="flex flex-wrap gap-2 bg-white border border-slate-200/60 rounded-xl p-3 shadow-inner">
                        {COMMON_EMOJIS.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => setMyAvatar(emoji)}
                            className={`text-xl w-9 h-9 flex items-center justify-center rounded-md border transition-all hover:bg-amber-50 cursor-pointer ${
                              myAvatar === emoji
                                ? "border-amber-500 bg-amber-50 ring-2 ring-amber-500/20"
                                : "border-slate-100 bg-slate-50/35"
                            }`}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Real Name */}
                    <div>
                      <label htmlFor="my-real-name-input" className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                        My Real Name
                      </label>
                      <input
                        id="my-real-name-input"
                        type="text"
                        required
                        placeholder="John Doe"
                        value={myRealName}
                        onChange={(e) => setMyRealName(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-200 bg-white rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 text-slate-800 transition-all"
                      />
                    </div>

                    {/* Email */}
                    <div>
                      <label htmlFor="my-email-input" className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                        Email Address
                      </label>
                      <input
                        id="my-email-input"
                        type="email"
                        placeholder="quin@beerreel.com"
                        value={myEmail}
                        onChange={(e) => setMyEmail(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-200 bg-white rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 text-slate-800 transition-all"
                      />
                    </div>

                    {/* Bio */}
                    <div>
                      <label htmlFor="my-bio-input" className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                        My Bio
                      </label>
                      <input
                        id="my-bio-input"
                        type="text"
                        placeholder="IPA expert..."
                        value={myBio}
                        onChange={(e) => setMyBio(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-200 bg-white rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 text-slate-800 transition-all"
                      />
                    </div>

                    {/* Current password - required to confirm it's really you before saving anything */}
                    <div>
                      <label htmlFor="my-current-password-input" className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                        Current Password
                      </label>
                      <input
                        id="my-current-password-input"
                        type="password"
                        placeholder="Required to save changes"
                        autoComplete="current-password"
                        required
                        value={myCurrentPassword}
                        onChange={(e) => setMyCurrentPassword(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-200 bg-white rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 text-slate-800 transition-all"
                      />
                    </div>

                    {/* New password - optional, leave blank to keep the current one */}
                    <div>
                      <label htmlFor="my-new-password-input" className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                        New Password
                      </label>
                      <input
                        id="my-new-password-input"
                        type="password"
                        placeholder="Leave blank to keep current password"
                        autoComplete="new-password"
                        value={myNewPassword}
                        onChange={(e) => setMyNewPassword(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-200 bg-white rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 text-slate-800 transition-all"
                      />
                    </div>

                    {/* Recovery code - the self-service password-recovery mechanism (no email
                        infra exists to send a reset link through). Regenerating requires the
                        current password field above and immediately invalidates any older code. */}
                    <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/60 space-y-2">
                      <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Recovery Code</p>
                      <p className="text-[11px] text-slate-500 leading-relaxed font-medium">
                        Used to reset your password if you forget it. Enter your current password above, then generate one - it's shown only once.
                      </p>
                      {newRecoveryCode ? (
                        <div className="flex items-center justify-between gap-2 bg-white border-2 border-dashed border-amber-400 rounded-lg px-3 py-2">
                          <span className="font-mono text-sm font-extrabold tracking-wider text-slate-800 select-all">
                            {newRecoveryCode}
                          </span>
                          <span className="text-[9px] font-bold text-amber-600 uppercase shrink-0">Save this now</span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={handleRegenerateRecoveryCode}
                          disabled={regeneratingRecoveryCode}
                          className="text-xs font-bold text-amber-600 hover:text-amber-700 hover:underline disabled:opacity-50"
                        >
                          {regeneratingRecoveryCode ? "Generating..." : "Generate a new recovery code"}
                        </button>
                      )}
                      {recoveryCodeError && (
                        <p className="text-red-600 text-[11px] font-semibold">{recoveryCodeError}</p>
                      )}
                    </div>
                  </div>

                  {myError && (
                    <div className="text-red-600 text-xs font-semibold">{myError}</div>
                  )}
                  {mySuccess && (
                    <div className="text-green-600 text-xs font-semibold flex items-center gap-1.5">
                      <Check className="w-4 h-4" /> Profile updated successfully!
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={isUpdatingMyProfile}
                    className="w-full bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold py-2 px-4 rounded-lg disabled:opacity-50 transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-sm"
                  >
                    <Check className="w-4 h-4" />
                    {isUpdatingMyProfile ? "Saving Changes..." : "Save My Profile Changes"}
                  </button>
                </form>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-150 bg-slate-50/50 flex items-center justify-between">
          <a
            href="/privacy.html"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-slate-400 hover:text-amber-600 font-semibold hover:underline"
          >
            Privacy Policy
          </a>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold rounded-lg transition-all shadow-sm focus:outline-none cursor-pointer"
          >
            Done
          </button>
        </div>
      </motion.div>

      {/* Cropping Modal Overlay */}
      <AnimatePresence>
        {croppingImageSrc && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[60] flex flex-col items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl p-6 max-w-sm w-full space-y-4"
            >
              <div className="text-center space-y-1">
                <h3 className="text-sm font-extrabold text-slate-800 dark:text-slate-100 tracking-tight">
                  Crop Your Profile Photo ✂️
                </h3>
                <p className="text-[10px] text-slate-400 font-semibold leading-normal">
                  Drag the photo to pan, use the slider to zoom.
                </p>
              </div>

              {/* Cropping box */}
              <div className="flex justify-center">
                <div
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUpOrLeave}
                  onMouseLeave={handleMouseUpOrLeave}
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleMouseUpOrLeave}
                  className="w-[280px] h-[280px] relative overflow-hidden bg-slate-950 rounded-xl select-none cursor-grab active:cursor-grabbing border border-slate-700 shadow-inner"
                >
                  <img
                    ref={cropImgRef}
                    src={croppingImageSrc}
                    alt="Crop target"
                    className="absolute pointer-events-none max-w-none origin-center"
                    style={{
                      width: editorImgSize.width,
                      height: editorImgSize.height,
                      left: "50%",
                      top: "50%",
                      transform: `translate(calc(-50% + ${cropPan.x}px), calc(-50% + ${cropPan.y}px)) scale(${cropZoom})`,
                    }}
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      const aspect = img.naturalWidth / img.naturalHeight;
                      let dWidth = 280;
                      let dHeight = 280;
                      if (aspect > 1) {
                        dHeight = 280;
                        dWidth = 280 * aspect;
                      } else {
                        dWidth = 280;
                        dHeight = 280 / aspect;
                      }
                      setEditorImgSize({ width: dWidth, height: dHeight });
                      setCropPan({ x: 0, y: 0 });
                      setCropZoom(1);
                    }}
                  />
                  {/* Circle Mask Overlay */}
                  <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 280 280">
                    <defs>
                      <mask id="crop-mask">
                        <rect width="280" height="280" fill="white" />
                        <circle cx="140" cy="140" r="80" fill="black" />
                      </mask>
                    </defs>
                    <rect width="280" height="280" fill="black" fillOpacity="0.65" mask="url(#crop-mask)" />
                    <circle cx="140" cy="140" r="80" stroke="#f59e0b" strokeWidth="2.5" fill="none" strokeDasharray="5 3" />
                  </svg>
                </div>
              </div>

              {/* Slider zoom */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[10px] font-bold text-slate-400 dark:text-slate-500">
                  <div className="flex items-center gap-1">
                    <ZoomOut className="w-3.5 h-3.5" />
                    <span>Zoom Out</span>
                  </div>
                  <span className="text-[10px] font-extrabold text-amber-500 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 rounded">
                    {Math.round(cropZoom * 100)}%
                  </span>
                  <div className="flex items-center gap-1">
                    <span>Zoom In</span>
                    <ZoomIn className="w-3.5 h-3.5" />
                  </div>
                </div>
                <input
                  type="range"
                  min="0.25"
                  max="3"
                  step="0.02"
                  value={cropZoom}
                  onChange={(e) => setCropZoom(parseFloat(e.target.value))}
                  className="w-full accent-amber-500 h-1.5 bg-slate-200 dark:bg-slate-800 rounded-lg appearance-none cursor-pointer"
                />
              </div>

              {/* Actions */}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setCroppingImageSrc(null)}
                  className="py-2 px-4 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold text-xs rounded-xl transition-all cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleApplyCrop}
                  className="py-2 px-4 bg-amber-500 hover:bg-amber-600 text-white font-bold text-xs rounded-xl transition-all cursor-pointer shadow-sm shadow-amber-500/10"
                >
                  Apply Crop 🍻
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {showWeeklyRecap && (
        <WeeklyRecap
          username={displayedUsername}
          isOwnRecap={!isViewOnly}
          onClose={() => setShowWeeklyRecap(false)}
        />
      )}
    </div>
  );
}
