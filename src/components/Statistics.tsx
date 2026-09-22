import React, { useState, useMemo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Beer,
  Star,
  Percent,
  TrendingUp,
  Calendar,
  Users,
  ArrowUpDown,
  Search,
  Filter,
  Flame,
  ChevronDown,
  Pin,
  Trophy,
  Crown,
  Zap,
  Coffee
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell
} from "recharts";
import { BeerLog, UserProfile, TimeFilter, Pub } from "../types";
import { getMostDrankBeerForUser, isImposterLog } from "../utils";
import UserAvatar from "./UserAvatar";

interface StatisticsProps {
  logs?: BeerLog[];
  users: UserProfile[];
  pubs: Pub[];
  selectedPubId: string;
  onPubSelect: (pubId: string) => void;
  pinnedPubId?: string;
  onPinPub?: (pubId: string) => void;
  currentUser: string;
  onViewProfileRequested?: (username: string) => void;
  clientUseFirestore: boolean;
}

type SortKey = "date" | "user" | "beerName" | "abv" | "rating";
type SortOrder = "asc" | "desc";

const COLORS = [
  "#d97706", // Amber / Gold
  "#2563eb", // Royal Sapphire Blue
  "#059669", // Emerald Green
  "#e11d48", // Crimson Red
  "#7c3aed", // Deep Violet
  "#0284c7", // Sky Blue
  "#ea580c", // Burnt Orange
  "#6366f1", // Indigo
  "#0d9488", // Teal
  "#d946ef"  // Fuchsia
];

interface CacheEntry {
  beers: BeerLog[];
  pubMemberStats?: Record<string, { totalPints: number; avgRating: number; avgAbv: number }>;
  timestamp: number;
  latestLogId: string;
}

const leaderboardCache: Record<string, CacheEntry> = {};

export default function Statistics({
  logs = [],
  users,
  pubs,
  selectedPubId,
  onPubSelect,
  pinnedPubId,
  onPinPub,
  currentUser,
  onViewProfileRequested,
  clientUseFirestore
}: StatisticsProps) {
  // Defaults to whichever window actually has check-ins (This Week -> This
  // Month -> All Time), same idea as the Pub Hub Superlatives fix, so a
  // quiet week doesn't just render a blank Ledger. A manual pill click locks
  // it in place; switching pubs re-arms the auto-pick.
  const [rangeFilter, setRangeFilter] = useState<"all_time" | "this_month" | "last_week" | "this_week">("this_week");
  const [rangeFilterLocked, setRangeFilterLocked] = useState(false);
  const lastAutoRangePubIdRef = useRef<string | undefined>(undefined);
  const [barLayout, setBarLayout] = useState<"stacked" | "grouped">("stacked");

  const selectRangeFilter = (filter: "all_time" | "this_month" | "last_week" | "this_week") => {
    setRangeFilter(filter);
    setRangeFilterLocked(true);
  };

  useEffect(() => {
    if (lastAutoRangePubIdRef.current !== selectedPubId) {
      lastAutoRangePubIdRef.current = selectedPubId;
      setRangeFilterLocked(false);
    }
  }, [selectedPubId]);

  const [leaderboardBeers, setLeaderboardBeers] = useState<BeerLog[]>([]);
  const [pubMemberStats, setPubMemberStats] = useState<Record<string, { totalPints: number; avgRating: number; avgAbv: number }>>({});
  const [loading, setLoading] = useState(false);
  const [isDataTruncated, setIsDataTruncated] = useState(false);

  // Absolute minimum start date (unrestricted)
  const absoluteMinDate = useMemo(() => new Date(0), []);

  // Fetch leaderboard beers only on mount, filter, or pub selection change, with no timer or background polling
  useEffect(() => {
    let isMounted = true;
    const fetchLeaderboardBeers = async () => {
      setLoading(true);
      try {
        const cacheKey = `${rangeFilter}_${clientUseFirestore}_${selectedPubId}`;
        const latestLogId = logs.length > 0 ? logs[0].id : "";
        const cached = leaderboardCache[cacheKey];

        // Cache is valid if it exists, is less than 5 minutes old, and the latest feed log matches
        if (cached && (Date.now() - cached.timestamp < 5 * 60 * 1000) && cached.latestLogId === latestLogId) {
          console.log(`[Cache] Using cached leaderboard beers and aggregation stats for ${rangeFilter} / ${selectedPubId}`);
          if (isMounted) {
            setLeaderboardBeers(cached.beers);
            setPubMemberStats(cached.pubMemberStats || {});
            setLoading(false);
          }
          return;
        }

        const now = new Date();
        let startDate = new Date(absoluteMinDate);
        let endDate = new Date(now);

        const dayOfWeek = now.getDay();
        const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const mondayThisWeek = new Date(now);
        mondayThisWeek.setDate(now.getDate() - daysSinceMonday);
        mondayThisWeek.setHours(0, 0, 0, 0);

        if (rangeFilter === "this_week") {
          startDate = mondayThisWeek;
          const sundayThisWeek = new Date(mondayThisWeek);
          sundayThisWeek.setDate(mondayThisWeek.getDate() + 6);
          sundayThisWeek.setHours(23, 59, 59, 999);
          endDate = sundayThisWeek;
        } else if (rangeFilter === "last_week") {
          const mondayLastWeek = new Date(mondayThisWeek);
          mondayLastWeek.setDate(mondayThisWeek.getDate() - 7);
          startDate = mondayLastWeek;
          
          const sundayLastWeek = new Date(mondayLastWeek);
          sundayLastWeek.setDate(mondayLastWeek.getDate() + 6);
          sundayLastWeek.setHours(23, 59, 59, 999);
          endDate = sundayLastWeek;
        } else if (rangeFilter === "this_month") {
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        } else if (rangeFilter === "all_time") {
          startDate = new Date(absoluteMinDate);
          endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
        }

        if (rangeFilter === "this_month" || rangeFilter === "all_time") {
          const todayEnd = new Date(now);
          todayEnd.setHours(23, 59, 59, 999);
          if (endDate > todayEnd) {
            endDate = todayEnd;
          }
        }

        if (startDate < absoluteMinDate) {
          startDate = new Date(absoluteMinDate);
        }

        const startDateStr = startDate.toISOString();
        const endDateStr = endDate.toISOString();

        let fetchedBeers: BeerLog[] = [];
        let statsMap: Record<string, { totalPints: number; avgRating: number; avgAbv: number }> = {};

        let memberIds: string[] = [];
        let isScopedFilter = false;

        if (selectedPubId && selectedPubId !== "global" && selectedPubId !== "all") {
          const activePub = pubs ? pubs.find(p => p.id === selectedPubId) : null;
          if (activePub) {
            memberIds = activePub.members;
            isScopedFilter = true;
          }
        }

        let fetchedFromApi = false;
        try {
          const res = await fetch(`/api/leaderboard-beers?startDate=${encodeURIComponent(startDateStr)}&endDate=${encodeURIComponent(endDateStr)}`);
          if (res.ok) {
            fetchedBeers = await res.json();
            fetchedFromApi = true;
          }
        } catch (apiErr) {
          console.warn("[Cache] Failed to fetch leaderboard beers from server cache, will use fallback query:", apiErr);
        }

        let hitLimit = false;

        // Defensive fallback to direct Firestore query ONLY if the high-performance API failed
        if (!fetchedFromApi && clientUseFirestore) {
          try {
            const { db } = await import("../firebase");
            const { collection, query, where, getDocs, limit } = await import("firebase/firestore");
            if (db) {
              if (isScopedFilter && memberIds.length > 0) {
                const chunks = [];
                for (let i = 0; i < memberIds.length; i += 30) {
                  chunks.push(memberIds.slice(i, i + 30));
                }
                const promises = chunks.map(async (chunk) => {
                  const q = query(
                    collection(db, "beers"),
                    where("user", "in", chunk),
                    where("date", ">=", startDateStr),
                    where("date", "<=", endDateStr),
                    limit(500)
                  );
                  const snap = await getDocs(q);
                  if (snap.docs.length >= 500) hitLimit = true;
                  const chunkBeers: BeerLog[] = [];
                  snap.forEach((doc) => {
                    chunkBeers.push(doc.data() as BeerLog);
                  });
                  return chunkBeers;
                });
                const results = await Promise.all(promises);
                fetchedBeers = results.flat();
              } else {
                const q = query(
                  collection(db, "beers"),
                  where("date", ">=", startDateStr),
                  where("date", "<=", endDateStr),
                  limit(500)
                );
                const snap = await getDocs(q);
                if (snap.docs.length >= 500) hitLimit = true;
                snap.forEach((doc) => {
                  fetchedBeers.push(doc.data() as BeerLog);
                });
              }
            }
          } catch (fsErr) {
            console.warn("[Statistics] Firestore query failed or unavailable, using cached beers fallback:", fsErr);
          }
        }

        // Always merge any live logs from props that fall within date range to ensure instant update in The Ledger
        if (logs && logs.length > 0) {
          const start = new Date(startDateStr).getTime();
          const end = new Date(endDateStr).getTime();
          const seenIds = new Set(fetchedBeers.map((b) => b.id));
          logs.forEach((l) => {
            if (l && l.id && !seenIds.has(l.id)) {
              const t = new Date(l.date).getTime();
              if (t >= start && t <= end) {
                fetchedBeers.push(l);
                seenIds.add(l.id);
              }
            }
          });
        }

        if (hitLimit) {
          console.warn("[Statistics] Query reached dataset limit of 500 logs. Displaying warning badge in UI.");
        }
        setIsDataTruncated(hitLimit);

        // Filter out imposter logs (logs with 3 or more imposter/dislike votes) from beer statistics
        fetchedBeers = fetchedBeers.filter((b) => !isImposterLog(b));

        // Compute high-precision aggregation metrics for each member client-side from the already-fetched beers!
        // This completely eliminates any direct Firestore aggregation reads, resulting in 0 reads for this step.
        const targetUserIds = memberIds.length > 0 ? memberIds : users.map(u => u.username);
        targetUserIds.forEach((memberId) => {
          const memberBeers = fetchedBeers.filter((b) => b.user === memberId);
          const ratedBeers = memberBeers.filter((b) => b.rating && b.rating > 0);
          const abvBeers = memberBeers.filter((b) => b.abv && b.abv > 0);

          const totalPints = memberBeers.length;
          const totalRating = ratedBeers.reduce((acc, b) => acc + (b.rating || 0), 0);
          const avgRating = ratedBeers.length > 0 ? parseFloat((totalRating / ratedBeers.length).toFixed(1)) : 0;

          const totalAbv = abvBeers.reduce((acc, b) => acc + (b.abv || 0), 0);
          const avgAbv = abvBeers.length > 0 ? parseFloat((totalAbv / abvBeers.length).toFixed(1)) : 0;

          statsMap[memberId] = {
            totalPints,
            avgRating,
            avgAbv
          };
        });

        if (isMounted) {
          fetchedBeers.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          
          // Save to module cache
          leaderboardCache[cacheKey] = {
            beers: fetchedBeers,
            pubMemberStats: statsMap,
            timestamp: Date.now(),
            latestLogId
          };

          setLeaderboardBeers(fetchedBeers);
          setPubMemberStats(statsMap);

          // Auto-widen to the next timeframe if this one came up empty and
          // the user hasn't manually picked a filter for this pub view yet.
          // Checked against the scoped per-member stats (not the raw fetched
          // beers, which can include other users' logs merged in from props
          // that fall in-range but outside this pub) so this matches what
          // the Ledger's own "No logs" empty state is actually keyed on.
          const hasAnyPints = targetUserIds.some((id) => (statsMap[id]?.totalPints || 0) > 0);
          if (!rangeFilterLocked && !hasAnyPints) {
            if (rangeFilter === "this_week") setRangeFilter("this_month");
            else if (rangeFilter === "this_month") setRangeFilter("all_time");
          }
        }
      } catch (err) {
        console.error("Failed to fetch leaderboard beers:", err);
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    fetchLeaderboardBeers();
    return () => {
      isMounted = false;
    };
  }, [rangeFilter, clientUseFirestore, absoluteMinDate, selectedPubId, pubs, logs, currentUser, rangeFilterLocked]);

  const { filteredUsers, filteredPubLogs } = useMemo(() => {
    if (!selectedPubId || selectedPubId === "global" || selectedPubId === "all") {
      return { filteredUsers: users, filteredPubLogs: leaderboardBeers };
    }
    const activePub = pubs ? pubs.find(p => p.id === selectedPubId) : null;
    if (!activePub) {
      return { filteredUsers: users, filteredPubLogs: leaderboardBeers };
    }
    const mSet = new Set(activePub.members);
    return {
      filteredUsers: users.filter(u => mSet.has(u.username)),
      filteredPubLogs: leaderboardBeers.filter(l => mSet.has(l.user))
    };
  }, [leaderboardBeers, users, pubs, selectedPubId]);

  const [excludedUsers, setExcludedUsers] = useState<string[]>([]);
  const [isCompareDropdownOpen, setIsCompareDropdownOpen] = useState(false);
  const LEADERBOARD_PAGE_SIZE = 5;
  const [leaderboardVisibleCount, setLeaderboardVisibleCount] = useState(LEADERBOARD_PAGE_SIZE);
  const [templeVisibleCount, setTempleVisibleCount] = useState(LEADERBOARD_PAGE_SIZE);

  // Derive selectedUsers from filteredUsers, filteredPubLogs, and excludedUsers
  const selectedUsers = useMemo(() => {
    const userSet = new Set<string>();
    filteredUsers.forEach((u) => userSet.add(u.username));
    filteredPubLogs.forEach((l) => {
      if (l.user) userSet.add(l.user);
    });
    return Array.from(userSet).filter((username) => !excludedUsers.includes(username));
  }, [filteredUsers, filteredPubLogs, excludedUsers]);

  // Reset exclusions when the selected pub changes
  useEffect(() => {
    setExcludedUsers([]);
  }, [selectedPubId]);

  // Reset leaderboard pagination whenever the underlying ranking could change
  useEffect(() => {
    setLeaderboardVisibleCount(LEADERBOARD_PAGE_SIZE);
    setTempleVisibleCount(LEADERBOARD_PAGE_SIZE);
  }, [selectedPubId, rangeFilter]);

  // "My Body Is A Temple" - ranks by longest dry streak on record (all-time,
  // not scoped to the date-range filter, since a streak is a running record
  // rather than something that resets each week/month). Pulled straight from
  // each profile's cached stats rather than recomputed from logs here.
  //
  // Excludes accounts that have gone quiet: without this, a friend's abandoned
  // account just accumulates dry-streak days forever and permanently dominates
  // the board. "Active" here means the app was opened within the last 14 days
  // (lastActiveDate, a lightweight heartbeat pinged on load) OR they posted
  // within 14 days OR they joined within 14 days - whichever signal is freshest.
  // The moment someone reopens the app, the next ping puts them right back on
  // the board - there's no separate "welcome back" step, it just self-corrects.
  const TEMPLE_INACTIVITY_DAYS = 14;
  const templeLeaderboardData = useMemo(() => {
    const cutoff = Date.now() - TEMPLE_INACTIVITY_DAYS * 24 * 60 * 60 * 1000;

    const lastPostByUser: Record<string, number> = {};
    (logs || []).forEach((l) => {
      const t = new Date(l.date).getTime();
      if (!Number.isFinite(t)) return;
      const key = l.user.toLowerCase();
      if (!lastPostByUser[key] || t > lastPostByUser[key]) lastPostByUser[key] = t;
    });

    return filteredUsers
      .filter((u) => (u.stats?.longestDryStreak || 0) > 0)
      .filter((u) => {
        const key = u.username.toLowerCase();
        const lastActive = u.lastActiveDate ? new Date(u.lastActiveDate).getTime() : 0;
        const lastPost = lastPostByUser[key] || 0;
        const joined = u.joinedDate ? new Date(u.joinedDate).getTime() : 0;
        const mostRecentSignal = Math.max(lastActive, lastPost, joined);
        return mostRecentSignal >= cutoff;
      })
      .map((u) => ({ username: u.username, longestDryStreak: u.stats?.longestDryStreak || 0 }))
      .sort((a, b) => b.longestDryStreak - a.longestDryStreak);
  }, [filteredUsers, logs]);

  const [tableSearch, setTableSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  // Handler to toggle user selection for comparison
  const handleToggleUser = (username: string) => {
    if (excludedUsers.includes(username)) {
      setExcludedUsers(excludedUsers.filter((u) => u !== username));
    } else {
      // Ensure we don't exclude the last remaining user
      if (selectedUsers.length > 1) {
        setExcludedUsers([...excludedUsers, username]);
      }
    }
  };

  const handleSelectAllUsers = () => {
    setExcludedUsers([]);
  };

  const handleSelectNoneUsers = () => {
    if (filteredUsers.length > 0) {
      const firstUser = filteredUsers[0].username;
      setExcludedUsers(filteredUsers.map((u) => u.username).filter((u) => u !== firstUser));
    }
  };

  // Compute start/end dates based on rangeFilter
  const dateRange = useMemo(() => {
    const now = new Date();
    let startDate = new Date(absoluteMinDate);
    let endDate = new Date(now);

    const dayOfWeek = now.getDay();
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const mondayThisWeek = new Date(now);
    mondayThisWeek.setDate(now.getDate() - daysSinceMonday);
    mondayThisWeek.setHours(0, 0, 0, 0);

    if (rangeFilter === "this_week") {
      startDate = mondayThisWeek;
      const sundayThisWeek = new Date(mondayThisWeek);
      sundayThisWeek.setDate(mondayThisWeek.getDate() + 6);
      sundayThisWeek.setHours(23, 59, 59, 999);
      endDate = sundayThisWeek;
    } else if (rangeFilter === "last_week") {
      const mondayLastWeek = new Date(mondayThisWeek);
      mondayLastWeek.setDate(mondayThisWeek.getDate() - 7);
      startDate = mondayLastWeek;
      
      const sundayLastWeek = new Date(mondayLastWeek);
      sundayLastWeek.setDate(mondayLastWeek.getDate() + 6);
      sundayLastWeek.setHours(23, 59, 59, 999);
      endDate = sundayLastWeek;
    } else if (rangeFilter === "this_month") {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (rangeFilter === "all_time") {
      // Expand day by day starting from earliest logged beer up to today
      let minTime = Infinity;
      if (filteredPubLogs && filteredPubLogs.length > 0) {
        filteredPubLogs.forEach((l) => {
          const t = new Date(l.date).getTime();
          if (!isNaN(t) && t < minTime) minTime = t;
        });
      }
      if (minTime !== Infinity) {
        startDate = new Date(minTime);
        startDate.setHours(0, 0, 0, 0);
      } else {
        startDate = new Date(now);
        startDate.setDate(now.getDate() - 6);
        startDate.setHours(0, 0, 0, 0);
      }
      endDate = new Date(now);
      endDate.setHours(23, 59, 59, 999);
    }

    // Clip the future portion of endDate for all_time and this_month so the graph ends at today and grows dynamically day by day
    if (rangeFilter === "this_month" || rangeFilter === "all_time") {
      const todayEnd = new Date(now);
      todayEnd.setHours(23, 59, 59, 999);
      if (endDate > todayEnd) {
        endDate = todayEnd;
      }
    }

    if (startDate < absoluteMinDate) {
      startDate = new Date(absoluteMinDate);
    }

    return { startDate, endDate };
  }, [rangeFilter, absoluteMinDate, filteredPubLogs]);

  // Helper to check if a log falls into the selected time frame
  const filteredLogs = useMemo(() => {
    const { startDate, endDate } = dateRange;

    return filteredPubLogs.filter((log) => {
      // User filter (if explicitly excluded)
      if (excludedUsers.includes(log.user)) return false;

      // Time filter
      const logDate = new Date(log.date);
      if (isNaN(logDate.getTime())) return false;

      return logDate >= startDate && logDate <= endDate;
    });
  }, [filteredPubLogs, dateRange, excludedUsers]);

  // Expand graph day by day for all range filters including all_time
  const viewMode = useMemo<"daily" | "weekly" | "monthly">(() => {
    return "daily";
  }, []);

  // Calculated Metrics
  const metrics = useMemo(() => {
    if (filteredLogs.length === 0) {
      return {
        totalBeers: 0,
        avgRating: 0,
        avgAbv: 0,
        topBeer: "N/A",
        avgPintsPerDay: 0
      };
    }

    const totalBeers = filteredLogs.length;
    
    // Average Rating (exclude unrated logs, i.e., rating === 0)
    const ratedLogs = filteredLogs.filter(b => b.rating > 0);
    const totalRating = ratedLogs.reduce((acc, curr) => acc + curr.rating, 0);
    const avgRating = ratedLogs.length > 0 ? parseFloat((totalRating / ratedLogs.length).toFixed(1)) : 0;

    // Average ABV (exclude unspecified ABV logs, i.e., abv === 0)
    const abvLogs = filteredLogs.filter(b => b.abv > 0);
    const totalAbv = abvLogs.reduce((acc, curr) => acc + curr.abv, 0);
    const avgAbv = abvLogs.length > 0 ? parseFloat((totalAbv / abvLogs.length).toFixed(1)) : 0;

    // Top Beer
    const beerCounts: Record<string, number> = {};
    filteredLogs.forEach((log) => {
      beerCounts[log.beerName] = (beerCounts[log.beerName] || 0) + 1;
    });
    let topBeer = "N/A";
    let maxBeerCount = 0;
    Object.entries(beerCounts).forEach(([beer, count]) => {
      if (count > maxBeerCount) {
        maxBeerCount = count;
        topBeer = beer;
      }
    });

    // Pints per day average
    const { startDate, endDate } = dateRange;
    const now = new Date();
    const activeEnd = endDate < now ? endDate : now;
    const activeStart = startDate < absoluteMinDate ? absoluteMinDate : startDate;
    const diffTime = Math.abs(activeEnd.getTime() - activeStart.getTime());
    const diffDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    const avgPintsPerDay = parseFloat((totalBeers / diffDays).toFixed(2));

    return {
      totalBeers,
      avgRating,
      avgAbv,
      topBeer,
      avgPintsPerDay
    };
  }, [filteredLogs, dateRange, absoluteMinDate]);

  // Chart 1 Data: Beer logs over time (Daily, Weekly, Yearly) - Cumulative Sum
  const timelineChartData = useMemo(() => {
    let rawData: any[] = [];

    const { startDate, endDate } = dateRange;

    if (viewMode === "daily") {
      const buckets: { label: string; key: string }[] = [];
      const current = new Date(startDate);
      current.setHours(0, 0, 0, 0);

      const isMultiWeek = (endDate.getTime() - startDate.getTime()) > 14 * 24 * 60 * 60 * 1000;

      // Create daily buckets
      while (current <= endDate) {
        // Show month and day (e.g., "Jan 14") if range is > 14 days, else weekday & day (e.g., "Tue 14")
        const dateStr = isMultiWeek
          ? current.toLocaleDateString(undefined, { month: "short", day: "numeric" })
          : current.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
        const key = current.toDateString();
        buckets.push({
          label: dateStr,
          key
        });
        current.setDate(current.getDate() + 1);
      }

      const dataMap: Record<string, any> = {};
      buckets.forEach((bucket) => {
        dataMap[bucket.key] = {
          date: bucket.label,
          Total: 0
        };
        selectedUsers.forEach((u) => {
          dataMap[bucket.key][u] = 0;
        });
      });

      filteredLogs.forEach((log) => {
        const logDate = new Date(log.date);
        if (isNaN(logDate.getTime())) return;
        const key = logDate.toDateString();
        if (dataMap[key]) {
          dataMap[key][log.user] = (dataMap[key][log.user] || 0) + 1;
          dataMap[key]["Total"] = (dataMap[key]["Total"] || 0) + 1;
        }
      });

      rawData = buckets.map((bucket) => dataMap[bucket.key]);
    } else if (viewMode === "weekly") {
      const buckets: { label: string; startDate: Date; endDate: Date; key: string }[] = [];
      const current = new Date(startDate);
      // Normalize current to the Monday of its week
      const day = current.getDay();
      const daysSinceMonday = day === 0 ? 6 : day - 1;
      current.setDate(current.getDate() - daysSinceMonday);
      current.setHours(0, 0, 0, 0);

      while (current <= endDate) {
        const monday = new Date(current);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        sunday.setHours(23, 59, 59, 999);

        // Prettier label: compact week notation (e.g. "Wk: Jul 13")
        const label = `Wk: ${monday.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
        const key = monday.toDateString();

        buckets.push({
          label,
          startDate: monday,
          endDate: sunday,
          key
        });

        current.setDate(current.getDate() + 7);
      }

      const dataMap: Record<string, any> = {};
      buckets.forEach((bucket) => {
        dataMap[bucket.key] = {
          date: bucket.label,
          Total: 0
        };
        selectedUsers.forEach((u) => {
          dataMap[bucket.key][u] = 0;
        });
      });

      filteredLogs.forEach((log) => {
        const logDate = new Date(log.date);
        if (isNaN(logDate.getTime())) return;

        const matchingBucket = buckets.find(
          (b) => logDate >= b.startDate && logDate <= b.endDate
        );

        if (matchingBucket) {
          dataMap[matchingBucket.key][log.user] = (dataMap[matchingBucket.key][log.user] || 0) + 1;
          dataMap[matchingBucket.key]["Total"] = (dataMap[matchingBucket.key]["Total"] || 0) + 1;
        }
      });

      rawData = buckets.map((bucket) => dataMap[bucket.key]);
    } else {
      // Monthly View
      const buckets: { label: string; key: string; year: number; month: number }[] = [];
      const current = new Date(startDate);
      current.setDate(1);
      current.setHours(0, 0, 0, 0);

      const endLimit = new Date(endDate);
      endLimit.setDate(1);
      endLimit.setHours(0, 0, 0, 0);

      while (current <= endLimit) {
        // Prettier label: short month name (e.g. "Jul") without confusing numeric years
        const label = current.toLocaleDateString(undefined, { month: "short" });
        const key = `${current.getFullYear()}-${current.getMonth()}`;

        buckets.push({
          label,
          year: current.getFullYear(),
          month: current.getMonth(),
          key
        });

        current.setMonth(current.getMonth() + 1);
      }

      const dataMap: Record<string, any> = {};
      buckets.forEach((bucket) => {
        dataMap[bucket.key] = {
          date: bucket.label,
          Total: 0
        };
        selectedUsers.forEach((u) => {
          dataMap[bucket.key][u] = 0;
        });
      });

      filteredLogs.forEach((log) => {
        const logDate = new Date(log.date);
        if (isNaN(logDate.getTime())) return;

        const key = `${logDate.getFullYear()}-${logDate.getMonth()}`;
        if (dataMap[key]) {
          dataMap[key][log.user] = (dataMap[key][log.user] || 0) + 1;
          dataMap[key]["Total"] = (dataMap[key]["Total"] || 0) + 1;
        }
      });

      rawData = buckets.map((bucket) => dataMap[bucket.key]);
    }

    // Accumulate values chronologically for cumulative sum over the selected time range
    let runningTotal = 0;
    const runningUserTotals: Record<string, number> = {};
    selectedUsers.forEach((u) => {
      runningUserTotals[u] = 0;
    });

    return rawData.map((item) => {
      runningTotal += item.Total || 0;
      const baseUserTotals: Record<string, number> = {};
      selectedUsers.forEach((u) => {
        runningUserTotals[u] += item[u] || 0;
        baseUserTotals[u] = runningUserTotals[u];
      });

      // Group users by their exact cumulative value to stack tied lines cleanly
      const valueGroups: Record<number, string[]> = {};
      selectedUsers.forEach((u) => {
        const val = baseUserTotals[u];
        if (!valueGroups[val]) valueGroups[val] = [];
        valueGroups[val].push(u);
      });

      const cumulativeItem: any = {
        date: item.date,
        Total: runningTotal
      };

      selectedUsers.forEach((u) => {
        const rawVal = baseUserTotals[u];
        const group = valueGroups[rawVal];
        if (group && group.length > 1 && rawVal > 0) {
          const idxInGroup = group.indexOf(u);
          const offset = (idxInGroup - (group.length - 1) / 2) * 0.08;
          cumulativeItem[u] = rawVal + offset;
        } else {
          cumulativeItem[u] = rawVal;
        }
      });

      return cumulativeItem;
    });
  }, [filteredLogs, selectedUsers, viewMode, dateRange]);

  // Chart 2 Data: User Comparison (Beer Counts)
  const userComparisonData = useMemo(() => {
    const { startDate, endDate } = dateRange;
    const now = new Date();
    const activeEnd = endDate < now ? endDate : now;
    const activeStart = startDate < absoluteMinDate ? absoluteMinDate : startDate;
    const diffTime = Math.abs(activeEnd.getTime() - activeStart.getTime());
    const diffDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));

    return selectedUsers.map((username) => {
      const hasAggStats = pubMemberStats && pubMemberStats[username] !== undefined;
      const beersCount = hasAggStats ? pubMemberStats[username].totalPints : filteredLogs.filter((l) => l.user === username).length;
      
      const avgRating = hasAggStats ? pubMemberStats[username].avgRating : (() => {
        const ratings = filteredLogs.filter((l) => l.user === username && l.rating > 0).map((l) => l.rating);
        return ratings.length > 0 ? parseFloat((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1)) : 0;
      })();

      const avgAbv = hasAggStats ? pubMemberStats[username].avgAbv : (() => {
        const abvs = filteredLogs.filter((l) => l.user === username && l.abv > 0).map((l) => l.abv);
        return abvs.length > 0 ? parseFloat((abvs.reduce((a, b) => a + b, 0) / abvs.length).toFixed(1)) : 0;
      })();

      const avgPintsPerDay = parseFloat((beersCount / diffDays).toFixed(2));

      return {
        name: username,
        Pints: beersCount,
        "Avg Rating": avgRating,
        "Avg ABV": avgAbv,
        avgPintsPerDay
      };
    }).filter(user => user.Pints > 0).sort((a, b) => {
      if (b.Pints !== a.Pints) {
        return b.Pints - a.Pints;
      }
      return b["Avg ABV"] - a["Avg ABV"];
    });
  }, [filteredLogs, selectedUsers, dateRange, absoluteMinDate, pubMemberStats]);

  // Users who have drank at least 1 beer in the active filter
  const usersWithBeerOnGraph = useMemo(() => {
    return selectedUsers.filter((username) => {
      return filteredLogs.some((l) => l.user === username);
    });
  }, [selectedUsers, filteredLogs]);

  // Cap the timeline chart to the top drinkers by volume - a line per person stops being
  // readable well before you get anywhere near a full pub's worth of users.
  const TIMELINE_MAX_LINES = 6;
  const topGraphUsers = useMemo(
    () => userComparisonData.slice(0, TIMELINE_MAX_LINES).map((u) => u.name),
    [userComparisonData]
  );

  // Chart 3 Data: Beer Name distribution - Guinness vs Other Beers
  const beerNameBreakdownData = useMemo(() => {
    if (filteredLogs.length === 0) return [];

    let guinnessCount = 0;
    let otherCount = 0;

    filteredLogs.forEach((log) => {
      if (log.beerName && log.beerName.toLowerCase().includes("guinness")) {
        guinnessCount++;
      } else {
        otherCount++;
      }
    });

    const result = [];
    if (guinnessCount > 0) {
      result.push({ name: "Creamy Pint of Guinness", value: guinnessCount });
    }
    if (otherCount > 0) {
      result.push({ name: "Not a Guinness", value: otherCount });
    }

    return result;
  }, [filteredLogs]);

  // Table sorting & searching
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortOrder("desc");
    }
  };

  const sortedAndSearchedLogs = useMemo(() => {
    let result = [...filteredLogs];

    // Apply Search
    if (tableSearch.trim()) {
      const term = tableSearch.toLowerCase();
      result = result.filter(
        (l) =>
          l.beerName.toLowerCase().includes(term) ||
          (l.comment && l.comment.toLowerCase().includes(term))
      );
    }

    // Sort
    result.sort((a, b) => {
      let valA: any = a[sortKey];
      let valB: any = b[sortKey];

      if (sortKey === "date") {
        valA = new Date(a.date).getTime();
        valB = new Date(b.date).getTime();
      }

      if (typeof valA === "string") {
        return sortOrder === "asc"
          ? valA.localeCompare(valB)
          : valB.localeCompare(valA);
      } else {
        return sortOrder === "asc" ? valA - valB : valB - valA;
      }
    });

    const uniqueResult: BeerLog[] = [];
    const seenIds = new Set<string>();
    for (const item of result) {
      if (item && item.id && !seenIds.has(item.id)) {
        seenIds.add(item.id);
        uniqueResult.push(item);
      }
    }

    return uniqueResult;
  }, [filteredLogs, tableSearch, sortKey, sortOrder]);

  // Custom Dot renderer that draws clean, un-cluttered data markers for each line
  const renderCustomDot = (props: any) => {
    const { cx, cy, dataKey, payload } = props;
    if (cx === undefined || cy === undefined) return <circle r={0} />;

    const val = payload[dataKey];
    if (val === undefined || val === 0) return <circle r={0} />; // don't draw dots for 0 or non-logged values

    // Overlap clustering to shift overlapping markers when they are tied so you can see all of them!
    let shiftX = 0;
    let shiftY = 0;

    // Find all selected users who have the exact same value at this payload point
    const matchingUsers = selectedUsers.filter(u => payload[u] === val);
    if (matchingUsers.length > 1) {
      let offsetIndex = matchingUsers.indexOf(dataKey);
      if (offsetIndex === -1) offsetIndex = 0;
      const count = matchingUsers.length;
      shiftX = (offsetIndex - (count - 1) / 2) * 8;
      shiftY = (offsetIndex - (count - 1) / 2) * -8;
    }

    const index = selectedUsers.indexOf(dataKey);
    const color = COLORS[index >= 0 ? index % COLORS.length : 0];

    return (
      <circle
        key={`${dataKey}-${cx}-${cy}`}
        cx={cx + shiftX}
        cy={cy + shiftY}
        r={4}
        fill={color}
        stroke="#ffffff"
        strokeWidth={2}
      />
    );
  };

  return (
    <div className="space-y-8" id="statistics-view">
      {isDataTruncated && (
        <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-800/50 text-amber-900 dark:text-amber-300 px-4 py-3 rounded-xl text-xs flex items-center gap-3 shadow-sm animate-fade-in">
          <span className="text-lg shrink-0">⚠️</span>
          <div>
            <p className="font-bold">Partial Dataset Notice</p>
            <p className="text-amber-800/90 dark:text-amber-400/90 text-[11px] mt-0.5">
              Query reached the 500-log display cap. Statistics for this period are computed from the 500 most recent records to maintain real-time speed.
            </p>
          </div>
        </div>
      )}

      {/* Filters Panel */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-5">
        <div className="pb-4 border-b border-slate-100">
          <h2 className="text-xl font-black text-slate-800 tracking-tight">
            The Ledger
          </h2>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Pub Filter */}
          <div className="space-y-2 animate-fade-in">
            <span className="block text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Active Pub Community Filter
            </span>
            <div className="flex bg-slate-100 dark:bg-slate-900/50 p-1.5 rounded-xl border border-slate-200/40 dark:border-slate-800 gap-2 items-center">
              <span className="text-xs font-bold text-slate-500 dark:text-slate-400 pl-2">Current View:</span>
              <select
                value={selectedPubId === "all" || !selectedPubId ? "global" : selectedPubId}
                onChange={(e) => onPubSelect?.(e.target.value)}
                className="flex-1 py-1.5 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-bold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-500/10 focus:border-amber-500 transition-all cursor-pointer"
              >
                <option value="global">🌍 Global Community (All Users)</option>
                {pubs.filter(p => p.members.includes(currentUser)).map((p) => {
                  const isImg = p.emblem && (p.emblem.startsWith("http://") || p.emblem.startsWith("https://") || p.emblem.startsWith("/") || p.emblem.startsWith("data:image"));
                  const displayEmblem = p.emblem ? (isImg ? "🖼️" : p.emblem) : "🏠";
                  return (
                    <option key={p.id} value={p.id}>
                      {displayEmblem} {p.name}
                    </option>
                  );
                })}
              </select>
              {onPinPub && pinnedPubId !== (selectedPubId || "global") && (
                <button
                  type="button"
                  id="pin-pub-stats-button"
                  onClick={() => onPinPub(selectedPubId || "global")}
                  title="Pin as default view to start"
                  className="p-1.5 rounded-lg border transition-all shrink-0 bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-50"
                >
                  <Pin className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Top Date Range selector */}
          <div className="space-y-2">
            <span className="block text-xs font-bold uppercase tracking-wider text-slate-400">
              Date Range Filter
            </span>
            <div className="flex flex-wrap bg-slate-100 p-1 rounded-md w-full gap-1">
              {([
                { id: "all_time", label: "All Time" },
                { id: "this_month", label: "This Month" },
                { id: "last_week", label: "Last Week" },
                { id: "this_week", label: "This Week" }
              ] as const).map((filter) => (
                <button
                  key={filter.id}
                  onClick={() => selectRangeFilter(filter.id)}
                  className={`flex-1 text-[10px] font-bold py-1.5 px-2 rounded capitalize transition-all cursor-pointer whitespace-nowrap ${
                    rangeFilter === filter.id
                      ? "bg-white text-slate-800 shadow-sm"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-24 bg-white rounded-xl border border-slate-200 shadow-sm space-y-4">
          <div className="w-8 h-8 border-4 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs font-bold text-slate-500">Calculating community stats & pints poured... 🍻</p>
        </div>
      ) : (
        <>
          {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {/* KPI 1: Total Pints */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex items-center gap-4">
          <div className="p-2.5 bg-amber-50 text-amber-500 rounded-lg shrink-0">
            <Beer className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider truncate">Total Pints</span>
            <span className="text-xl font-bold text-slate-850">{metrics.totalBeers}</span>
          </div>
        </div>

        {/* KPI 2: Pints Per Day */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex items-center gap-4">
          <div className="p-2.5 bg-amber-50 text-amber-500 rounded-lg shrink-0">
            <Calendar className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider truncate">Pints / Day</span>
            <span className="text-xl font-bold text-slate-850">{metrics.avgPintsPerDay}</span>
          </div>
        </div>

        {/* KPI 3: Avg Rating */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex items-center gap-4">
          <div className="p-2.5 bg-amber-50 text-amber-500 rounded-lg shrink-0">
            <Star className="w-5 h-5 fill-amber-500 text-amber-500" />
          </div>
          <div className="min-w-0">
            <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider truncate">Avg Rating</span>
            <span className="text-xl font-bold text-slate-850">
              {metrics.avgRating > 0 ? `${metrics.avgRating} / 5` : "N/A"}
            </span>
          </div>
        </div>

        {/* KPI 4: Avg ABV */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex items-center gap-4">
          <div className="p-2.5 bg-amber-50 text-amber-500 rounded-lg shrink-0">
            <Percent className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider truncate">Avg ABV</span>
            <span className="text-xl font-bold text-slate-850">
              {metrics.avgAbv > 0 ? `${metrics.avgAbv}%` : "N/A"}
            </span>
          </div>
        </div>

        {/* KPI 5: Top Beer (Spans 2 cols on mobile for balance) */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex items-center gap-4 col-span-2 lg:col-span-1">
          <div className="p-2.5 bg-amber-50 text-amber-500 rounded-lg shrink-0">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider truncate">Top Beer</span>
            <span className="text-xs font-extrabold text-slate-850 truncate block" title={metrics.topBeer}>
              {metrics.topBeer}
            </span>
          </div>
        </div>
      </div>

      {/* Pint Leaderboard - Full Width */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4" id="leaderboard-card">
        <div className="border-b border-slate-100 pb-3.5 flex justify-between items-center">
          <div>
            <h3 className="text-sm font-extrabold text-slate-800 tracking-tight flex items-center gap-1.5">
              <TrendingUp className="w-4 h-4 text-amber-500" />
              The Ledger
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5 font-normal">Total pints recorded by community regulars in The Ledger within the filtered period</p>
          </div>
          <span className="text-[10px] text-amber-600 font-extrabold bg-amber-50 border border-amber-200/50 px-2.5 py-1 rounded-full uppercase tracking-wider">
            Ledger Totals
          </span>
        </div>

        {userComparisonData.length === 0 ? (
          <div className="py-12 text-center text-slate-400 italic">No logs within filtered period</div>
        ) : (
          <div className="space-y-3">
            {userComparisonData.slice(0, leaderboardVisibleCount).map((user, idx) => {
              const maxPints = Math.max(...userComparisonData.map((u) => u.Pints), 1);
              const percentage = (user.Pints / maxPints) * 100;
              const userProfile = filteredUsers.find((u) => u.username === user.name);
              const rank = idx + 1;
              
              // Get custom medal or rank badge (Gold, Silver, Bronze)
              const getRankBadge = (r: number) => {
                if (r === 1) return <span className="flex items-center justify-center w-7 h-7 rounded-full bg-yellow-100 text-yellow-600 font-extrabold text-sm shadow-sm border border-yellow-300/80 animate-bounce-slow">🥇</span>;
                if (r === 2) return <span className="flex items-center justify-center w-7 h-7 rounded-full bg-slate-100 text-slate-600 font-extrabold text-sm shadow-sm border border-slate-300">🥈</span>;
                if (r === 3) return <span className="flex items-center justify-center w-7 h-7 rounded-full bg-amber-700/10 text-amber-800 font-extrabold text-sm shadow-sm border border-amber-700/30">🥉</span>;
                return <span className="flex items-center justify-center w-7 h-7 rounded-full bg-slate-50 text-slate-400 font-extrabold text-xs border border-slate-200">#{r}</span>;
              };

              // Determine special row styles for podium positions
              const getRowStyles = (r: number) => {
                if (r === 1) return "border-yellow-300/50 bg-gradient-to-r from-yellow-50/30 via-amber-50/15 to-transparent hover:from-yellow-50/40 hover:via-amber-50/25";
                if (r === 2) return "border-slate-250 bg-gradient-to-r from-slate-50/40 to-transparent hover:from-slate-50/60";
                if (r === 3) return "border-orange-200/40 bg-gradient-to-r from-orange-50/10 to-transparent hover:from-orange-50/20";
                return "border-slate-150 bg-slate-50/10 hover:bg-slate-50";
              };

              return (
                <div 
                  key={user.name} 
                  className={`group flex flex-col md:flex-row md:items-center gap-4 p-3.5 border rounded-xl transition-all duration-200 hover:shadow-sm cursor-pointer ${getRowStyles(rank)}`}
                  onClick={() => onViewProfileRequested?.(user.name)}
                >
                  {/* Rank, Avatar, & Name info */}
                  <div className="flex items-center gap-3 shrink-0 md:w-52">
                    <div className="shrink-0">{getRankBadge(rank)}</div>
                    <UserAvatar username={user.name} users={filteredUsers} className="w-9 h-9 text-lg" />
                    <div className="min-w-0">
                      <h4 className="font-extrabold text-slate-800 text-xs truncate group-hover:underline">{user.name}</h4>
                      <p className="text-[10px] text-amber-600 font-bold uppercase tracking-wider truncate" title={getMostDrankBeerForUser(user.name, filteredPubLogs)}>
                        {getMostDrankBeerForUser(user.name, filteredPubLogs) === "No beers logged yet" ? "Pub Regular" : `Fav: ${getMostDrankBeerForUser(user.name, filteredPubLogs).split(" (")[0]}`}
                      </p>
                    </div>
                  </div>

                  {/* Progress bar (Takes up flexible space in the center on desktop) */}
                  <div className="flex-1 min-w-0 flex flex-col justify-center">
                    <div className="flex justify-between items-center mb-1 md:hidden">
                      <span className="text-[10px] text-slate-400 font-bold uppercase">Progress</span>
                      <span className="font-extrabold text-amber-600 text-xs">{user.Pints} {user.Pints === 1 ? 'pint' : 'pints'}</span>
                    </div>
                    
                    <div className="w-full bg-slate-200/70 h-2 rounded-full overflow-hidden relative">
                      <div 
                        className="h-full rounded-full transition-all duration-500 ease-out" 
                        style={{ 
                          width: `${percentage}%`,
                          backgroundColor: COLORS[idx % COLORS.length]
                        }}
                      />
                    </div>
                  </div>
                  
                  {/* Stats (Pints Count & Averages on the right side) */}
                  <div className="flex items-center justify-between md:justify-end gap-6 shrink-0 md:w-[380px] pt-2.5 md:pt-0 border-t border-slate-150 md:border-t-0 mt-1 md:mt-0">
                    {/* Desktop Pints Counter */}
                    <div className="hidden md:block text-right min-w-[70px]">
                      <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider">Pints</span>
                      <span className="font-extrabold text-slate-800 text-sm">
                        {user.Pints}
                      </span>
                    </div>

                    {/* Pints per day */}
                    <div className="text-left md:text-right min-w-[80px]">
                      <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider">Pints / Day</span>
                      <span className="font-extrabold text-slate-800 text-sm">
                        {user.avgPintsPerDay}
                      </span>
                    </div>

                    {/* Average Rating */}
                    <div className="text-left md:text-right min-w-[80px]">
                      <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider">Avg Rating</span>
                      <span className="font-extrabold text-amber-500 text-sm flex items-center gap-1 justify-start md:justify-end">
                        <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                        {user["Avg Rating"] > 0 ? `${user["Avg Rating"]}` : "N/A"}
                      </span>
                    </div>

                    {/* Average ABV */}
                    <div className="text-right min-w-[70px]">
                      <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider">Avg ABV</span>
                      <span className="font-extrabold text-slate-700 text-sm">
                        {user["Avg ABV"] > 0 ? `${user["Avg ABV"]}%` : "N/A"}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {(userComparisonData.length > leaderboardVisibleCount || leaderboardVisibleCount > LEADERBOARD_PAGE_SIZE) && (
          <div className="flex items-center justify-center gap-3 pt-1 flex-wrap">
            {userComparisonData.length > leaderboardVisibleCount && (
              <button
                type="button"
                onClick={() => setLeaderboardVisibleCount((c) => Math.min(c + LEADERBOARD_PAGE_SIZE, userComparisonData.length))}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-extrabold rounded-lg transition-all cursor-pointer"
              >
                Show {Math.min(LEADERBOARD_PAGE_SIZE, userComparisonData.length - leaderboardVisibleCount)} More
              </button>
            )}
            {leaderboardVisibleCount > LEADERBOARD_PAGE_SIZE && (
              <button
                type="button"
                onClick={() => setLeaderboardVisibleCount(LEADERBOARD_PAGE_SIZE)}
                className="px-4 py-2 bg-transparent hover:bg-slate-100 text-slate-500 text-xs font-extrabold rounded-lg transition-all cursor-pointer border border-slate-200"
              >
                Show Less
              </button>
            )}
            <span className="text-[10px] text-slate-400 font-bold">
              {Math.min(leaderboardVisibleCount, userComparisonData.length)} of {userComparisonData.length}
            </span>
          </div>
        )}
      </div>

      {/* My Body Is A Temple Leaderboard - longest dry streak on record */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4" id="temple-leaderboard-card">
        <div className="border-b border-slate-100 pb-3.5 flex justify-between items-center">
          <div>
            <h3 className="text-sm font-extrabold text-slate-800 tracking-tight flex items-center gap-1.5">
              <span className="text-base">🏛️</span>
              My Body Is A Temple
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5 font-normal">Longest dry streak on record - the longest stretch between pints</p>
          </div>
          <span className="text-[10px] text-emerald-600 font-extrabold bg-emerald-50 border border-emerald-200/50 px-2.5 py-1 rounded-full uppercase tracking-wider">
            All-Time Record
          </span>
        </div>

        {templeLeaderboardData.length === 0 ? (
          <div className="py-12 text-center text-slate-400 italic">No dry streaks on record yet</div>
        ) : (
          <div className="space-y-3">
            {templeLeaderboardData.slice(0, templeVisibleCount).map((entry, idx) => {
              const maxStreak = Math.max(...templeLeaderboardData.map((u) => u.longestDryStreak), 1);
              const percentage = (entry.longestDryStreak / maxStreak) * 100;
              const rank = idx + 1;

              const getRankBadge = (r: number) => {
                if (r === 1) return <span className="flex items-center justify-center w-7 h-7 rounded-full bg-yellow-100 text-yellow-600 font-extrabold text-sm shadow-sm border border-yellow-300/80 animate-bounce-slow">🥇</span>;
                if (r === 2) return <span className="flex items-center justify-center w-7 h-7 rounded-full bg-slate-100 text-slate-600 font-extrabold text-sm shadow-sm border border-slate-300">🥈</span>;
                if (r === 3) return <span className="flex items-center justify-center w-7 h-7 rounded-full bg-amber-700/10 text-amber-800 font-extrabold text-sm shadow-sm border border-amber-700/30">🥉</span>;
                return <span className="flex items-center justify-center w-7 h-7 rounded-full bg-slate-50 text-slate-400 font-extrabold text-xs border border-slate-200">#{r}</span>;
              };

              const getRowStyles = (r: number) => {
                if (r === 1) return "border-emerald-300/50 bg-gradient-to-r from-emerald-50/40 via-teal-50/15 to-transparent hover:from-emerald-50/50 hover:via-teal-50/25";
                if (r === 2) return "border-slate-250 bg-gradient-to-r from-slate-50/40 to-transparent hover:from-slate-50/60";
                if (r === 3) return "border-orange-200/40 bg-gradient-to-r from-orange-50/10 to-transparent hover:from-orange-50/20";
                return "border-slate-150 bg-slate-50/10 hover:bg-slate-50";
              };

              return (
                <div
                  key={entry.username}
                  className={`group flex items-center gap-4 p-3.5 border rounded-xl transition-all duration-200 hover:shadow-sm cursor-pointer ${getRowStyles(rank)}`}
                  onClick={() => onViewProfileRequested?.(entry.username)}
                >
                  <div className="flex items-center gap-3 shrink-0 w-44 sm:w-52">
                    <div className="shrink-0">{getRankBadge(rank)}</div>
                    <UserAvatar username={entry.username} users={filteredUsers} className="w-9 h-9 text-lg" />
                    <div className="min-w-0">
                      <h4 className="font-extrabold text-slate-800 text-xs truncate group-hover:underline">{entry.username}</h4>
                      <p className="text-[10px] text-emerald-600 font-bold uppercase tracking-wider truncate">Record</p>
                    </div>
                  </div>

                  <div className="flex-1 min-w-0 flex flex-col justify-center">
                    <div className="w-full bg-slate-200/70 h-2 rounded-full overflow-hidden relative">
                      <div
                        className="h-full rounded-full transition-all duration-500 ease-out bg-emerald-500"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>

                  <div className="text-right min-w-[70px] shrink-0">
                    <span className="text-[10px] text-slate-400 font-bold block uppercase tracking-wider">Dry Streak</span>
                    <span className="font-extrabold text-emerald-600 text-sm">
                      {entry.longestDryStreak}d
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {(templeLeaderboardData.length > templeVisibleCount || templeVisibleCount > LEADERBOARD_PAGE_SIZE) && (
          <div className="flex items-center justify-center gap-3 pt-1 flex-wrap">
            {templeLeaderboardData.length > templeVisibleCount && (
              <button
                type="button"
                onClick={() => setTempleVisibleCount((c) => Math.min(c + LEADERBOARD_PAGE_SIZE, templeLeaderboardData.length))}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-extrabold rounded-lg transition-all cursor-pointer"
              >
                Show {Math.min(LEADERBOARD_PAGE_SIZE, templeLeaderboardData.length - templeVisibleCount)} More
              </button>
            )}
            {templeVisibleCount > LEADERBOARD_PAGE_SIZE && (
              <button
                type="button"
                onClick={() => setTempleVisibleCount(LEADERBOARD_PAGE_SIZE)}
                className="px-4 py-2 bg-transparent hover:bg-slate-100 text-slate-500 text-xs font-extrabold rounded-lg transition-all cursor-pointer border border-slate-200"
              >
                Show Less
              </button>
            )}
            <span className="text-[10px] text-slate-400 font-bold">
              {Math.min(templeVisibleCount, templeLeaderboardData.length)} of {templeLeaderboardData.length}
            </span>
          </div>
        )}
      </div>

      {/* Graphs Grid */}
      <div className="grid grid-cols-1 gap-6">
        {/* Graph 1: Line Chart Timeline (A Pint in Time) */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-sm font-bold text-slate-800">A Pint in Time</h3>
              <p className="text-[11px] text-slate-400 mt-0.5 font-normal">
                Cumulative pints - top {Math.min(TIMELINE_MAX_LINES, topGraphUsers.length)}
                {userComparisonData.length > TIMELINE_MAX_LINES ? ` of ${userComparisonData.length} drinkers` : " drinkers"}
              </p>
            </div>
          </div>

          {/* Compact Graph Key / Legend - capped to the users actually plotted. A fixed-
              column grid instead of flex-wrap, so it reads as an organized key instead
              of a ragged wrap where only one or two wide name pills fit per row. */}
          {topGraphUsers.length > 0 && (
            <div className="p-1.5 bg-slate-50/80 border border-slate-200/70 rounded-lg space-y-1">
              <span className="text-[9px] font-extrabold uppercase tracking-wider text-slate-400 pl-1">Key</span>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {topGraphUsers.map((user, index) => {
                  const color = COLORS[index % COLORS.length];
                  const userPintsCount = filteredLogs.filter(l => l.user === user).length;
                  return (
                    <div
                      key={user}
                      className="flex items-center gap-1.5 px-2 py-1 bg-white border border-slate-200/80 rounded-md text-[11px] font-medium text-slate-700 shadow-2xs min-w-0"
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: color }}
                      />
                      <UserAvatar username={user} users={filteredUsers} className="w-4 h-4 text-[9px] shrink-0" />
                      <span className="font-bold text-slate-800 truncate min-w-0 flex-1">{user}</span>
                      <span className="text-[9px] font-bold text-slate-500 bg-slate-100 px-1 py-0.2 rounded shrink-0">
                        {userPintsCount}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="h-64 text-xs font-semibold">
            {filteredLogs.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-400 italic">No logs within filtered period</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timelineChartData} margin={{ top: 15, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    {topGraphUsers.map((user, index) => (
                      <linearGradient key={user} id={`ledgerGrad-${index}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={COLORS[index % COLORS.length]} stopOpacity={0.35} />
                        <stop offset="95%" stopColor={COLORS[index % COLORS.length]} stopOpacity={0} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11, fill: '#334155', fontWeight: 700 }}
                    minTickGap={15}
                  />
                  <YAxis
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11, fill: '#334155', fontWeight: 700 }}
                    domain={[0, 'dataMax']}
                  />
                  <Tooltip
                    formatter={(val: any, name: any) => {
                      const rounded = Math.round(Number(val));
                      return [`${rounded} ${rounded === 1 ? 'pint' : 'pints'}`, name];
                    }}
                    contentStyle={{ backgroundColor: '#161d2f', border: '1px solid #242f49', borderRadius: '10px', boxShadow: '0 8px 20px 0 rgb(0 0 0 / 0.35)' }}
                    labelStyle={{ fontWeight: 'bold', color: '#f1f5f9' }}
                    itemStyle={{ fontWeight: 600 }}
                  />
                  {topGraphUsers.map((user, index) => (
                    <Area
                      key={user}
                      type="monotone"
                      dataKey={user}
                      stroke={COLORS[index % COLORS.length]}
                      strokeWidth={2.5}
                      fill={`url(#ledgerGrad-${index})`}
                      dot={false}
                      activeDot={{ r: 5, strokeWidth: 2, stroke: '#0b0f19' }}
                      name={`${user}'s Pints`}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>
        </>
      )}
    </div>
  );
}
