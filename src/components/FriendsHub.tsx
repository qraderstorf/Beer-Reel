import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { UserPlus, UserCheck, UserMinus, Users, Search, X, Check, Clock } from "lucide-react";
import { UserProfile } from "../types";
import UserAvatar from "./UserAvatar";

interface FriendsHubProps {
  currentUser: string;
  users: UserProfile[];
  onProfileAddedOrUpdated: (profile: UserProfile) => void;
  onViewProfileRequested?: (username: string) => void;
  onClose?: () => void;
  isOnboarding?: boolean;
}

type FriendsTab = "requests" | "find" | "friends";

export default function FriendsHub({
  currentUser,
  users,
  onProfileAddedOrUpdated,
  onViewProfileRequested,
  onClose,
  isOnboarding = false,
}: FriendsHubProps) {
  const me = useMemo(() => users.find((u) => u.username === currentUser), [users, currentUser]);
  const myFriends = me?.friends || [];
  const myIncomingRequests = me?.friendRequests || [];

  const [tab, setTab] = useState<FriendsTab>(isOnboarding ? "find" : myIncomingRequests.length > 0 ? "requests" : "find");
  const [search, setSearch] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Everyone I've already sent an outgoing request to (derived: anyone whose friendRequests list contains me)
  const myOutgoingRequests = useMemo(
    () =>
      users
        .filter((u) => (u.friendRequests || []).some((r) => r.toLowerCase() === currentUser.toLowerCase()))
        .map((u) => u.username),
    [users, currentUser]
  );

  // Anyone eligible to show up in Find at all (not already a friend/pending/blocked).
  const candidatePool = useMemo(() => {
    const friendsLower = myFriends.map((f) => f.toLowerCase());
    const outgoingLower = myOutgoingRequests.map((f) => f.toLowerCase());
    const myBlockedLower = (me?.blockedUsers || []).map((f) => f.toLowerCase());
    return users.filter(
      (u) =>
        u.username.toLowerCase() !== currentUser.toLowerCase() &&
        !friendsLower.includes(u.username.toLowerCase()) &&
        !outgoingLower.includes(u.username.toLowerCase()) &&
        !myBlockedLower.includes(u.username.toLowerCase()) &&
        !(u.blockedUsers || []).some((b) => b.toLowerCase() === currentUser.toLowerCase())
    );
  }, [users, currentUser, myFriends, myOutgoingRequests, me]);

  const isSearching = search.trim().length > 0;

  // Without a search query, Find used to list literally every other user in the app -
  // fine with a handful of accounts, but it turns into an unmanaged public directory
  // (full name + avatar of every signed-up user, visible to anyone signed in) as the
  // app grows. Instead: no query shows a small, bounded "people you may know" list
  // (mutual-friends-first), and a query searches the full pool but still caps results.
  const MAX_SUGGESTIONS = 12;
  const MAX_SEARCH_RESULTS = 50;

  const discoverable = useMemo(() => {
    if (isSearching) {
      const q = search.trim().toLowerCase();
      return candidatePool
        .filter((u) => u.username.toLowerCase().includes(q) || (u.realName || "").toLowerCase().includes(q))
        .sort((a, b) => {
          const aPrefix = a.username.toLowerCase().startsWith(q) ? 0 : 1;
          const bPrefix = b.username.toLowerCase().startsWith(q) ? 0 : 1;
          if (aPrefix !== bPrefix) return aPrefix - bPrefix;
          return a.username.localeCompare(b.username);
        })
        .slice(0, MAX_SEARCH_RESULTS);
    }

    const myFriendsLower = new Set(myFriends.map((f) => f.toLowerCase()));
    const mutualCount = (u: UserProfile) =>
      (u.friends || []).filter((f) => myFriendsLower.has(f.toLowerCase())).length;

    return [...candidatePool]
      .sort((a, b) => {
        const mutualDiff = mutualCount(b) - mutualCount(a);
        if (mutualDiff !== 0) return mutualDiff;
        // No mutuals to go on (e.g. a brand new account) - surface newest members
        // first so there's still something useful here instead of an empty list.
        return (b.joinedDate || "").localeCompare(a.joinedDate || "");
      })
      .slice(0, MAX_SUGGESTIONS);
  }, [candidatePool, isSearching, search, myFriends]);

  const runAction = async (key: string, fn: () => Promise<void>) => {
    setPendingAction(key);
    setError(null);
    try {
      await fn();
    } catch (err: any) {
      setError(err.message || "Something went wrong.");
    } finally {
      setPendingAction(null);
    }
  };

  const applyResult = (data: { users?: UserProfile[] }) => {
    (data.users || []).forEach((u) => onProfileAddedOrUpdated(u));
  };

  const sendRequest = (to: string) =>
    runAction(`send-${to}`, async () => {
      const res = await fetch("/api/friends/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: currentUser, to }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not send friend request.");
      applyResult(data);
    });

  const acceptRequest = (requester: string) =>
    runAction(`accept-${requester}`, async () => {
      const res = await fetch("/api/friends/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: currentUser, requester }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not accept friend request.");
      applyResult(data);
    });

  const declineRequest = (requester: string) =>
    runAction(`decline-${requester}`, async () => {
      const res = await fetch("/api/friends/decline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: currentUser, requester }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not decline friend request.");
      applyResult(data);
    });

  const cancelRequest = (target: string) =>
    runAction(`cancel-${target}`, async () => {
      const res = await fetch("/api/friends/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: currentUser, target }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not cancel friend request.");
      applyResult(data);
    });

  const [confirmRemoveTarget, setConfirmRemoveTarget] = useState<string | null>(null);

  const removeFriend = (friend: string) =>
    runAction(`remove-${friend}`, async () => {
      const res = await fetch("/api/friends/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: currentUser, friend }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not remove friend.");
      applyResult(data);
    });

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xs overflow-hidden">
      {/* Header */}
      <div className="p-3.5 sm:p-4 border-b border-slate-100 dark:border-slate-800 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm sm:text-base font-black text-slate-900 dark:text-white flex items-center gap-1.5">
            <Users className="w-4 h-4 text-amber-500" />
            {isOnboarding ? "Add Your Friends 🍻" : "Friends"}
          </h2>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            {isOnboarding
              ? "Find people you know so their pints show up for you."
              : `${myFriends.length} friend${myFriends.length === 1 ? "" : "s"}`}
          </p>
        </div>
        {onClose && !isOnboarding && (
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-xl transition-all cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {error && (
        <div className="mx-3.5 sm:mx-4 mt-3 p-2.5 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 text-xs font-semibold">
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1.5 p-2.5 sm:p-3">
        <button
          type="button"
          onClick={() => setTab("requests")}
          className={`flex-1 py-2 px-2 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 transition-all cursor-pointer relative ${
            tab === "requests"
              ? "bg-amber-500 text-slate-950 shadow-xs"
              : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          <span>Requests</span>
          {myIncomingRequests.length > 0 && (
            <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-rose-500 text-white text-[9px] font-black rounded-full flex items-center justify-center">
              {myIncomingRequests.length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setTab("find")}
          className={`flex-1 py-2 px-2 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            tab === "find"
              ? "bg-amber-500 text-slate-950 shadow-xs"
              : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
          }`}
        >
          <Search className="w-3.5 h-3.5" />
          <span>Find</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("friends")}
          className={`flex-1 py-2 px-2 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
            tab === "friends"
              ? "bg-amber-500 text-slate-950 shadow-xs"
              : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
          }`}
        >
          <UserCheck className="w-3.5 h-3.5" />
          <span>My Friends</span>
        </button>
      </div>

      <div className="px-3.5 sm:px-4 pb-3.5 sm:pb-4">
        {/* REQUESTS TAB */}
        {tab === "requests" && (
          <div className="space-y-4">
            <div className="space-y-2">
              {(myIncomingRequests.length > 0 || myOutgoingRequests.length === 0) && (
                <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 px-0.5">
                  Received
                </p>
              )}
              {myIncomingRequests.length === 0 ? (
                <EmptyState emoji="📭" text="No pending friend requests." />
              ) : (
                myIncomingRequests.map((reqUsername) => {
                  const reqUser = users.find((u) => u.username.toLowerCase() === reqUsername.toLowerCase());
                  return (
                    <div
                      key={reqUsername}
                      className="flex items-center gap-2.5 p-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl"
                    >
                      <div
                        className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer"
                        onClick={() => onViewProfileRequested?.(reqUsername)}
                      >
                        <UserAvatar username={reqUsername} users={users} className="w-9 h-9 text-lg" />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-extrabold text-slate-800 dark:text-slate-100 truncate">
                            {reqUser?.realName || reqUsername}
                          </p>
                          <p className="text-[10px] text-slate-400 truncate">@{reqUsername} wants to be friends</p>
                        </div>
                      </div>
                      <button
                        onClick={() => acceptRequest(reqUsername)}
                        disabled={pendingAction === `accept-${reqUsername}`}
                        className="p-2 bg-emerald-500 hover:bg-emerald-400 text-white rounded-xl transition-all cursor-pointer disabled:opacity-50 shrink-0"
                        title="Accept"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => declineRequest(reqUsername)}
                        disabled={pendingAction === `decline-${reqUsername}`}
                        className="p-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-xl transition-all cursor-pointer disabled:opacity-50 shrink-0"
                        title="Decline"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            {myOutgoingRequests.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 px-0.5">
                  Sent
                </p>
                {myOutgoingRequests.map((toUsername) => {
                  const toUser = users.find((u) => u.username.toLowerCase() === toUsername.toLowerCase());
                  return (
                    <div
                      key={toUsername}
                      className="flex items-center gap-2.5 p-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl"
                    >
                      <div
                        className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer"
                        onClick={() => onViewProfileRequested?.(toUsername)}
                      >
                        <UserAvatar username={toUsername} users={users} className="w-9 h-9 text-lg" />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-extrabold text-slate-800 dark:text-slate-100 truncate">
                            {toUser?.realName || toUsername}
                          </p>
                          <p className="text-[10px] text-slate-400 truncate">Request pending...</p>
                        </div>
                      </div>
                      <button
                        onClick={() => cancelRequest(toUsername)}
                        disabled={pendingAction === `cancel-${toUsername}`}
                        className="p-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-xl transition-all cursor-pointer disabled:opacity-50 shrink-0"
                        title="Cancel request"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* FIND TAB */}
        {tab === "find" && (
          <div className="space-y-2.5">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search everyone by name or username..."
                className="w-full pl-9 pr-3 py-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-semibold text-slate-800 dark:text-slate-100 focus:outline-hidden focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all placeholder:text-slate-400"
              />
            </div>

            {!isSearching && discoverable.length > 0 && (
              <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 px-0.5">
                People you may know
              </p>
            )}

            <div className="space-y-1.5 max-h-[420px] overflow-y-auto custom-scrollbar">
              {discoverable.length === 0 ? (
                <EmptyState
                  emoji={isSearching ? "🔍" : "🎉"}
                  text={isSearching ? "No one matches that search." : "You've added everyone we could suggest - search by name or username to find someone specific."}
                />
              ) : (
                discoverable.map((u) => (
                  <div
                    key={u.username}
                    className="flex items-center gap-2.5 p-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl"
                  >
                    <div
                      className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer"
                      onClick={() => onViewProfileRequested?.(u.username)}
                    >
                      <UserAvatar username={u.username} users={users} className="w-9 h-9 text-lg" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-extrabold text-slate-800 dark:text-slate-100 truncate">
                          {u.realName || u.username}
                        </p>
                        <p className="text-[10px] text-slate-400 truncate">@{u.username}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => sendRequest(u.username)}
                      disabled={pendingAction === `send-${u.username}`}
                      className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-extrabold text-[11px] rounded-xl transition-all cursor-pointer disabled:opacity-50 flex items-center gap-1 shrink-0"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                      Add
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* MY FRIENDS TAB */}
        {tab === "friends" && (
          <div className="space-y-1.5">
            {myFriends.length === 0 ? (
              <EmptyState emoji="👋" text="No friends added yet. Head to Find to add some!" />
            ) : (
              [...myFriends].sort((a, b) => a.localeCompare(b)).map((friendUsername) => {
                const friendUser = users.find((u) => u.username.toLowerCase() === friendUsername.toLowerCase());
                return (
                  <div
                    key={friendUsername}
                    className="flex items-center gap-2.5 p-2.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl"
                  >
                    <div
                      className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer"
                      onClick={() => onViewProfileRequested?.(friendUsername)}
                    >
                      <UserAvatar username={friendUsername} users={users} className="w-9 h-9 text-lg" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-extrabold text-slate-800 dark:text-slate-100 truncate">
                          {friendUser?.realName || friendUsername}
                        </p>
                        <p className="text-[10px] text-slate-400 truncate">@{friendUsername}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setConfirmRemoveTarget(friendUsername)}
                      disabled={pendingAction === `remove-${friendUsername}`}
                      className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-500/10 rounded-xl transition-all cursor-pointer disabled:opacity-50 shrink-0"
                      title="Remove friend"
                    >
                      <UserMinus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {isOnboarding && onClose && (
        <div className="p-3.5 sm:p-4 border-t border-slate-100 dark:border-slate-800">
          <button
            onClick={onClose}
            className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl transition-all cursor-pointer"
          >
            {myFriends.length > 0 ? "Continue to BeerReel 🍻" : "Skip for now"}
          </button>
        </div>
      )}

      <AnimatePresence>
        {confirmRemoveTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] bg-black/50 flex items-center justify-center p-4"
            onClick={() => setConfirmRemoveTarget(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xl p-5 w-full max-w-xs space-y-4"
            >
              <div className="space-y-1">
                <h3 className="text-sm font-black text-slate-900 dark:text-white">Remove friend?</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  You'll stop seeing @{confirmRemoveTarget}'s pints in your feed unless you re-add them.
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  onClick={() => setConfirmRemoveTarget(null)}
                  className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 font-bold rounded-xl text-xs transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    const target = confirmRemoveTarget;
                    setConfirmRemoveTarget(null);
                    if (target) removeFriend(target);
                  }}
                  className="flex-1 py-2.5 bg-red-500 hover:bg-red-600 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer"
                >
                  Remove
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function EmptyState({ emoji, text }: { emoji: string; text: string }) {
  return (
    <div className="py-8 px-4 text-center bg-slate-50 dark:bg-slate-800/40 rounded-xl border border-dashed border-slate-200 dark:border-slate-700/60 space-y-1.5">
      <p className="text-2xl">{emoji}</p>
      <p className="text-xs font-bold text-slate-500 dark:text-slate-400">{text}</p>
    </div>
  );
}
