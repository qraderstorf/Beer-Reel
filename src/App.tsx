import React, { useState, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Beer, BarChart3, Activity, Users, Compass, ChevronDown, Smile, RefreshCw, LogOut, Bell, Smartphone, Database, Cloud, Flame, ShieldAlert, Tag, MessageSquare, Heart, Sparkles, UserPlus, UserCheck } from "lucide-react";
import { BeerLog, UserProfile, AppNotification, Pub } from "./types";
import { getMostDrankBeerForUser } from "./utils";
import ActivityFeed from "./components/ActivityFeed";
import Statistics from "./components/Statistics";
import UserProfileManager from "./components/UserProfileManager";
import LoginScreen from "./components/LoginScreen";
import AgeGate from "./components/AgeGate";
import PubHub from "./components/PubHub";
import QuickLogWorkflow from "./components/QuickLogWorkflow";
import UserAvatar from "./components/UserAvatar";
import Logo from "./components/Logo";
import FriendsHub from "./components/FriendsHub";
import WelcomeCarousel from "./components/WelcomeCarousel";
import { db, useFirestore } from "./firebase";
import { collection, query, orderBy, limit, onSnapshot, getDocs, startAfter, where, QueryConstraint, disableNetwork } from "firebase/firestore";

export default function App() {
  const [ageVerified, setAgeVerified] = useState<boolean>(() => {
    return localStorage.getItem("beer_real_age_verified") === "true";
  });
  const [activeTab, setActiveTab] = useState<"pubs" | "feed" | "stats">("feed");
  const [logs, setLogs] = useState<BeerLog[]>([]);
  const [liveBeers, setLiveBeers] = useState<BeerLog[]>([]);
  const [olderBeers, setOlderBeers] = useState<BeerLog[]>([]);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);

  // Scoped Firestore Filter States
  const [selectedUserFilter, setSelectedUserFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [filteredBeers, setFilteredBeers] = useState<BeerLog[]>([]);
  const [filteredHasMore, setFilteredHasMore] = useState<boolean>(true);
  const [loadingFiltered, setLoadingFiltered] = useState<boolean>(false);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [pubs, setPubs] = useState<Pub[]>([]);
  const [selectedPubId, setSelectedPubId] = useState<string>(() => {
    const user = localStorage.getItem("beer_logger_username") || "";
    if (user) {
      const pinned = localStorage.getItem(`beer_logger_pinned_pub_${user}`);
      if (pinned) return pinned;
    }
    return "";
  });
  const [pinnedPubId, setPinnedPubId] = useState<string>(() => {
    const user = localStorage.getItem("beer_logger_username") || "";
    return user ? (localStorage.getItem(`beer_logger_pinned_pub_${user}`) || "") : "";
  });

  const isFilterActive =
    selectedUserFilter !== "all" ||
    (selectedPubId !== "global" && selectedPubId !== "all" && selectedPubId !== "") ||
    searchTerm.trim() !== "";
  const [isQuickLogOpen, setIsQuickLogOpen] = useState(false);
  const [editLogTarget, setEditLogTarget] = useState<BeerLog | null>(null);
  const [clientUseFirestore, setClientUseFirestore] = useState<boolean>(() => {
    const saved = localStorage.getItem("beer_logger_use_firestore");
    if (saved !== null) {
      return saved === "true";
    }
    return useFirestore;
  });
  useEffect(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
    document.documentElement.setAttribute("data-theme", "dark");
    localStorage.setItem("beer_real_dark_mode", "true");
  }, []);

  const allLocalBeersRef = useRef<BeerLog[]>([]);

  useEffect(() => {
    const seen = new Set<string>();
    const merged: BeerLog[] = [];
    liveBeers.forEach((b) => {
      if (b && b.id && !seen.has(b.id)) {
        seen.add(b.id);
        merged.push(b);
      }
    });
    olderBeers.forEach((b) => {
      if (b && b.id && !seen.has(b.id)) {
        seen.add(b.id);
        merged.push(b);
      }
    });
    merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    setLogs(merged);
  }, [liveBeers, olderBeers]);

  useEffect(() => {
    if (clientUseFirestore) {
      setHasMore(true);
    }
  }, [clientUseFirestore]);

  const [currentUser, setCurrentUser] = useState<string>(() => {
    return localStorage.getItem("beer_logger_username") || "";
  });

  // GET /api/users strips email addresses from every entry except the requesting
  // user's own, so the bulk listing can't be scraped for everyone's email at once.
  const usersApiUrl = () =>
    currentUser ? `/api/users?viewerUsername=${encodeURIComponent(currentUser)}` : "/api/users";

  const [showFriendsOnboarding, setShowFriendsOnboarding] = useState(false);
  const [showWelcomeCarousel, setShowWelcomeCarousel] = useState(false);

  // Usernames the current user has blocked, so their posts/comments can be
  // hidden client-side. A profile is the source of truth for the block list;
  // this just derives a fast lookup set from it.
  const blockedUsernamesLower = useMemo(() => {
    const me = users.find((u) => u.username === currentUser);
    return new Set((me?.blockedUsers || []).map((b) => b.toLowerCase()));
  }, [users, currentUser]);

  const applyBlockFilter = (list: BeerLog[]): BeerLog[] => {
    if (blockedUsernamesLower.size === 0) return list;
    return list
      .filter((log) => !blockedUsernamesLower.has(log.user.toLowerCase()))
      .map((log) => {
        if (!log.comments || log.comments.length === 0) return log;
        const hasBlockedComment = log.comments.some((c) => blockedUsernamesLower.has(c.user.toLowerCase()));
        if (!hasBlockedComment) return log;
        return { ...log, comments: log.comments.filter((c) => !blockedUsernamesLower.has(c.user.toLowerCase())) };
      });
  };

  // Ensure selectedPubId matches an existing pub or fallback to global
  useEffect(() => {
    if (!currentUser || pubs.length === 0) return;
    if (selectedPubId === "global" || selectedPubId === "all" || selectedPubId === "") return;
    const pubExists = pubs.some(p => p.id === selectedPubId);
    if (!pubExists) {
      setSelectedPubId("global");
    }
  }, [pubs, currentUser, selectedPubId]);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    return localStorage.getItem("beer_logger_authenticated") === "true";
  });

  // Lightweight "app was opened" heartbeat, once per session - lets the dry-streak
  // leaderboard tell apart accounts that are still around from ones that were only
  // ever set up once and abandoned, without requiring a fresh beer post to count.
  useEffect(() => {
    if (!isAuthenticated || !currentUser) return;
    fetch(`/api/users/${encodeURIComponent(currentUser)}/ping`, { method: "POST" }).catch(() => {});
  }, [isAuthenticated, currentUser]);

  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [viewingProfileUsername, setViewingProfileUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const [syncingCloud, setSyncingCloud] = useState<boolean>(false);
  const [syncResult, setSyncResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showSyncBanner, setShowSyncBanner] = useState<boolean>(true);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [showNotifsDropdown, setShowNotifsDropdown] = useState(false);
  const [activeToast, setActiveToast] = useState<{ id: string; text: string; user?: string } | null>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showNotifsDropdown) return;

    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (
        notificationsRef.current &&
        !notificationsRef.current.contains(event.target as Node)
      ) {
        setShowNotifsDropdown(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [showNotifsDropdown]);

  const [isPageVisible, setIsPageVisible] = useState<boolean>(() => {
    return typeof document !== "undefined" ? document.visibilityState === "visible" : true;
  });
  const [isUserActive, setIsUserActive] = useState<boolean>(true);

  // Page Visibility API Hook
  useEffect(() => {
    const handleVisibilityChange = () => {
      const visible = document.visibilityState === "visible";
      console.log(`[Visibility] Page visibility changed to: ${visible ? "visible" : "hidden"}`);
      setIsPageVisible(visible);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // User Interaction and Idle Timeout Hook (25 mins)
  useEffect(() => {
    let idleTimer: NodeJS.Timeout | null = null;
    const IDLE_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes

    const resetIdleTimer = () => {
      setIsUserActive((prevActive) => {
        if (!prevActive) {
          console.log("[Idle] User interacted (click/scroll/tap). Reconnecting listeners!");
        }
        return true;
      });

      if (idleTimer) {
        clearTimeout(idleTimer);
      }

      idleTimer = setTimeout(() => {
        console.log("[Idle] No user interaction for 25 minutes. Disconnecting listeners to save reads.");
        setIsUserActive(false);
      }, IDLE_TIMEOUT_MS);
    };

    // Register interaction listeners: clicks, scrolls, taps, mousedown, keydowns
    const events = ["mousedown", "keydown", "scroll", "touchstart", "click"];
    events.forEach((event) => {
      window.addEventListener(event, resetIdleTimer, { passive: true });
    });

    resetIdleTimer();

    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      events.forEach((event) => {
        window.removeEventListener(event, resetIdleTimer);
      });
    };
  }, []);

  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() => {
    return typeof Notification !== "undefined" ? Notification.permission : "default";
  });

  const registerPushToken = async (): Promise<string | null> => {
    try {
      if (!currentUser) return null;
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return null;

      // 1. Wait for Service Worker to be fully ready and active
      if (!("serviceWorker" in navigator)) return null;
      const registration = await navigator.serviceWorker.ready;
      console.log("[PWA] Service worker is ready for FCM token registration:", registration.scope);

      let token: string | null = null;
      const vapidKey = "BEAvudUCXRjL5PR4F9QcF5SPddJXhzNE7ZN2SWV7LF-yZSCUmDCPEnkxSVnPoXuomyyW1aEb-w842p_y1q2oBS8";

      // 2. Generate FCM SDK token using our active unified service worker registration
      try {
        const { getMessaging, getToken } = await import("firebase/messaging");
        const { app } = await import("./firebase");
        if (app) {
          const messaging = getMessaging(app);
          token = await getToken(messaging, {
            vapidKey,
            serviceWorkerRegistration: registration
          });
          if (token) {
            console.log("[FCM] Obtained FCM registration token:", token);
          }
        }
      } catch (fcmErr) {
        console.warn("[FCM] FCM SDK token registration warning:", fcmErr);
      }

      // Check standard Web Push subscription fallback if FCM SDK returned null
      if (!token) {
        try {
          let sub = await registration.pushManager.getSubscription();
          if (!sub) {
            const padding = "=".repeat((4 - (vapidKey.length % 4)) % 4);
            const base64 = (vapidKey + padding).replace(/-/g, "+").replace(/_/g, "/");
            const rawData = window.atob(base64);
            const applicationServerKey = new Uint8Array(rawData.length);
            for (let i = 0; i < rawData.length; ++i) {
              applicationServerKey[i] = rawData.charCodeAt(i);
            }
            sub = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey
            });
          }
          if (sub && sub.endpoint) {
            token = sub.endpoint;
          }
        } catch (e) {
          console.warn("[FCM] Push manager subscription lookup/creation failed:", e);
        }
      }

      // 3. Save FCM token to server if a valid token or endpoint was retrieved
      if (token) {
        // FCM can hand this device a rotated token (reload, cache clear, SW update, etc.)
        // without the old one ever stopping - it stays valid and keeps receiving pushes
        // unless we explicitly tell the server to drop it. Left unchecked this piles up
        // stale-but-live tokens for the same device, so every notification arrives once
        // per leftover token instead of once. Track our own last-registered token per
        // device and unregister it whenever it's superseded by a new value.
        const lastTokenKey = "beer_logger_last_fcm_token";
        const previousToken = localStorage.getItem(lastTokenKey);
        if (previousToken && previousToken !== token) {
          fetch("/api/unregister-fcm-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: previousToken })
          }).catch(() => {});
        }
        await fetch("/api/register-fcm-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, user: currentUser })
        });
        localStorage.setItem(lastTokenKey, token);
      }
      return token;
    } catch (err) {
      console.warn("[FCM] Push token registration error:", err);
      return null;
    }
  };

  const sendTestPushNotification = async () => {
    if (!currentUser) return;
    
    // Trigger an in-app visual toast banner so user knows test notification was sent
    setActiveToast({
      id: `test-toast-${Date.now()}`,
      text: "Test Notification Triggered! Check your lock screen / notification banner 🍻"
    });

    try {
      // Trigger server FCM dispatch (the server sends the background FCM push)
      await fetch("/api/send-test-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: currentUser })
      });
    } catch (err) {
      console.warn("Failed to trigger test push:", err);
    }
  };

  const requestNotificationPermission = async () => {
    // Check if on iOS
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    // Check if in standalone mode
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || 
      (window.navigator as any).standalone === true;

    if (isIOS && !isStandalone) {
      alert("iOS system notifications require this app to be installed on your Home Screen.\n\nPlease tap the Share button (⎋) in Safari and select 'Add to Home Screen' (⊞) first!");
      return;
    }

    if (!("Notification" in window)) {
      alert("This browser does not support home screen notifications.");
      return;
    }

    // 1. Request permission
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);

    if (permission === "granted") {
      // 2. Register FCM token and send test push notification
      await registerPushToken();
      await sendTestPushNotification();
    }
  };

  useEffect(() => {
    if (isAuthenticated && currentUser && notificationPermission === "granted") {
      registerPushToken();
    }
  }, [isAuthenticated, currentUser, notificationPermission]);

  // Track session start time and seen notification IDs to prevent old/duplicate toasts
  const sessionStartTimeRef = useRef<number>(Date.now());
  const seenNotifIdsRef = useRef<Set<string>>(new Set());

  // Reset seen notifications tracking when active user changes
  useEffect(() => {
    sessionStartTimeRef.current = Date.now() - 5000; // 5s buffer
    seenNotifIdsRef.current = new Set();
  }, [currentUser]);

  useEffect(() => {
    if (!notifications || notifications.length === 0) return;

    const currentUsernameLower = currentUser ? currentUser.toLowerCase().trim() : "";

    for (const notif of notifications) {
      const isNewInSession = !seenNotifIdsRef.current.has(notif.id);
      seenNotifIdsRef.current.add(notif.id);

      if (!isNewInSession) continue;

      // Ensure notification date is RECENT (created during or right before active session)
      // This prevents old/historical notifications from popping up as toasts on page load/reconnect!
      const notifTime = notif.date ? new Date(notif.date).getTime() : 0;
      const isRecent = notifTime >= sessionStartTimeRef.current - 15000;
      if (!isRecent) continue;

      // 1. Never show toast to the user who performed the action
      const senderLower = notif.user ? notif.user.toLowerCase().trim() : "";
      if (senderLower && senderLower === currentUsernameLower) {
        continue;
      }

      // 2. If targetUser is defined, ONLY show toast if targetUser matches currentUser
      if (notif.targetUser) {
        const targetLower = notif.targetUser.toLowerCase().trim();
        if (targetLower !== currentUsernameLower) {
          continue; // Notification is meant for someone else!
        }
      } else {
        // 3. If targetUser is NOT defined, check if it's a targeted type (comment/cheer/reaction)
        const isTargetedType = notif.type === "comment" || notif.type === "cheer" || notif.type === "reaction" ||
          notif.text.includes("cheered your pint") || notif.text.includes("commented on your pint") || notif.text.includes("reacted with");

        if (isTargetedType) {
          // Verify if this action is on a beer log belonging to currentUser
          const belongsToMe = logs.some(l => 
            l.user.toLowerCase().trim() === currentUsernameLower && 
            notif.text.toLowerCase().includes(l.beerName.toLowerCase().trim())
          );
          if (!belongsToMe) {
            continue; // Action was performed on someone else's post!
          }
        }
      }

      const cleanText = notif.text.replace(/<[^>]*>/g, "");
      let formattedText = cleanText;
      if (notif.user && !cleanText.toLowerCase().startsWith(notif.user.toLowerCase())) {
        formattedText = `${notif.user} ${cleanText}`;
      }

      // Trigger sleek in-app toast for new items during active session
      setActiveToast({ id: notif.id, text: formattedText, user: notif.user });
      setTimeout(() => {
        setActiveToast((curr) => (curr?.id === notif.id ? null : curr));
      }, 7000);
    }
  }, [notifications, currentUser, logs]);

  // FCM Foreground Messaging Listener
  useEffect(() => {
    let unsub: (() => void) | null = null;
    const setupFCMForeground = async () => {
      try {
        const { getMessaging, onMessage } = await import("firebase/messaging");
        const { app } = await import("./firebase");
        if (app) {
          const messaging = getMessaging(app);
          unsub = onMessage(messaging, (payload) => {
            console.log("[FCM Client] Foreground message received:", payload);
            const body = payload.notification?.body || payload.data?.body || "A cold beer was logged!";
            const rawNotifId = payload.data?.notificationId || payload.data?.id || (payload.notification as any)?.tag;
            const notifId = rawNotifId || ("fcm-fg-" + Date.now());

            // Add notification ID to seen set so fetch notifications state effect does not duplicate toast
            if (rawNotifId) {
              seenNotifIdsRef.current.add(rawNotifId);
            }
            seenNotifIdsRef.current.add(notifId);

            // Display in-app toast when foreground message arrives
            setActiveToast({ id: notifId, text: body });
            setTimeout(() => {
              setActiveToast((curr) => (curr?.id === notifId ? null : curr));
            }, 7000);

            // Immediately refresh data
            fetchData();
          });
        }
      } catch (err) {
        console.warn("[FCM Client] Foreground messaging listener skipped:", err);
      }
    };
    setupFCMForeground();
    return () => {
      if (unsub) unsub();
    };
  }, []);

  // Load initial app data
  const fetchData = async (showRefreshIndicator = false, forceApiFallback = false) => {
    if (showRefreshIndicator) setRefreshing(true);
    setError(null);
    try {
      const activeFirestore = forceApiFallback ? false : clientUseFirestore;
      if (activeFirestore) {
        const [usersRes, pubsRes, notifsRes] = await Promise.all([
          fetch(usersApiUrl()),
          fetch("/api/pubs").catch(() => null),
          fetch("/api/notifications").catch(() => null)
        ]);

        let usersData: UserProfile[] = [];
        let pubsData: Pub[] = [];
        let notifsData: AppNotification[] = [];

        if (usersRes && usersRes.ok && usersRes.headers.get("content-type")?.includes("application/json")) {
          try {
            usersData = await usersRes.json();
          } catch (e) {
            console.warn("Failed to parse users JSON response:", e);
          }
        }

        if (pubsRes && pubsRes.ok && pubsRes.headers.get("content-type")?.includes("application/json")) {
          try {
            pubsData = await pubsRes.json();
          } catch (e) {
            console.warn("Failed to parse pubs JSON response:", e);
          }
        }

        if (notifsRes && notifsRes.ok && notifsRes.headers.get("content-type")?.includes("application/json")) {
          try {
            notifsData = await notifsRes.json();
          } catch (e) {
            console.warn("Failed to parse notifications JSON response:", e);
          }
        }

        if (usersData.length > 0) setUsers(usersData);
        if (pubsData.length > 0) setPubs(pubsData);
        if (notifsData.length > 0) setNotifications(notifsData);

        // Resolve a stable current user profile
        const storedUser = localStorage.getItem("beer_logger_username");
        const isAuth = localStorage.getItem("beer_logger_authenticated") === "true";
        const userExists = usersData.some((u) => u.username === storedUser);
        if (isAuth && storedUser && userExists) {
          setCurrentUser(storedUser);
          setIsAuthenticated(true);
        } else {
          setIsAuthenticated(false);
          setCurrentUser("");
          localStorage.removeItem("beer_logger_authenticated");
        }
      } else {
        const [beersRes, usersRes, notifsRes, pubsRes] = await Promise.all([
          fetch("/api/beers?limit=10"),
          fetch(usersApiUrl()),
          fetch("/api/notifications").catch(() => null),
          fetch("/api/pubs").catch(() => null)
        ]);

        if (!beersRes.ok || !usersRes.ok) {
          throw new Error("Failed to fetch beer logs or user profiles");
        }

        const beersResponseData = await beersRes.json();
        const usersData: UserProfile[] = await usersRes.json();
        const notifsData: AppNotification[] = notifsRes && notifsRes.ok ? await notifsRes.json() : [];
        const pubsData: Pub[] = pubsRes && pubsRes.ok ? await pubsRes.json() : [];

        setLiveBeers(beersResponseData.beers || []);
        setOlderBeers([]);
        setHasMore(!!beersResponseData.hasMore);

        setUsers(usersData);
        setNotifications(notifsData);
        setPubs(pubsData);

        // Resolve a stable current user profile
        const storedUser = localStorage.getItem("beer_logger_username");
        const isAuth = localStorage.getItem("beer_logger_authenticated") === "true";
        const userExists = usersData.some((u) => u.username === storedUser);
        if (isAuth && storedUser && userExists) {
          setCurrentUser(storedUser);
          setIsAuthenticated(true);
        } else {
          setIsAuthenticated(false);
          setCurrentUser("");
          localStorage.removeItem("beer_logger_authenticated");
        }
      }
    } catch (err: any) {
      setError(err.message || "An error occurred while loading dashboard.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [clientUseFirestore]);

  // Try to auto-reconnect to Firestore on mount in case it was previously offline
  useEffect(() => {
    const saved = localStorage.getItem("beer_logger_use_firestore");
    const sessionDisabled = sessionStorage.getItem("firestore_disabled_session");
    if (saved === "false" || sessionDisabled === "true") {
      // User has manually chosen local storage fallback or stream was exhausted, do not auto-reconnect
      return;
    }
    const autoReconnect = async () => {
      try {
        const res = await fetch("/api/firestore-reconnect", { method: "POST" });
        const data = await res.json();
        if (res.ok && data.success) {
          setClientUseFirestore(true);
          setRealtimeError(null);
          await fetchData(true);
        }
      } catch (err) {
        console.warn("Auto-reconnect failed on mount:", err);
      }
    };
    autoReconnect();
  }, []);

  const handleListenerErrorGlobal = (err: any, source: string) => {
    const errMsg = err?.message || err?.toString() || "";
    console.error(`[Firestore Error on ${source}]:`, err);
    setRealtimeError(errMsg || "Firestore connection error");
  };

  // 1. Conditional Beers Listener & Info Fetch: suspended when page is hidden or user is idle to save read costs!
  useEffect(() => {
    if (!isAuthenticated || !currentUser) return;
    if (!clientUseFirestore || !db) return;
    if (!isPageVisible || !isUserActive) {
      console.log("[Firestore] Core feed listeners suspended because page is hidden or user is idle.");
      return;
    }

    console.log("[Firestore] Connecting core feed real-time listeners and fetching users/pubs...");

    // Beers Listener with limit of 10 recent pints
    const qBeers = query(collection(db, "beers"), orderBy("date", "desc"), limit(10));
    const unsubBeers = onSnapshot(
      qBeers,
      (snapshot) => {
        const list: BeerLog[] = [];
        snapshot.forEach((doc) => {
          list.push(doc.data() as BeerLog);
        });
        setLiveBeers(list);
        if (list.length < 10) {
          setHasMore(false);
        } else {
          setHasMore(true);
        }
        setRealtimeError(null);
      },
      (err: any) => handleListenerErrorGlobal(err, "beers")
    );

    // Fetch users and pubs from cache-backed API endpoints
    fetch(usersApiUrl())
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch cached users");
        return res.json();
      })
      .then((data) => setUsers(data))
      .catch((err) => console.warn("Failed to load cached users:", err));

    fetch("/api/pubs")
      .then((res) => {
        if (res.ok) return res.json();
        return [];
      })
      .then((data) => setPubs(data))
      .catch((err) => console.warn("Failed to load cached pubs:", err));

    return () => {
      console.log("[Firestore] Unsubscribing core feed real-time listeners...");
      unsubBeers();
    };
  }, [isAuthenticated, currentUser, clientUseFirestore, isPageVisible, isUserActive]);

  // Polling fallback to keep feed, leaderboards, and notifications updated (ONLY if clientUseFirestore is disabled and page is active)
  useEffect(() => {
    if (!isAuthenticated || !currentUser) return;
    if (clientUseFirestore) return; // Skip polling if real-time firestore listeners are active
    if (!isPageVisible || !isUserActive) return; // Skip background polling when inactive/hidden
    const timer = setInterval(() => {
      fetchData();
    }, 45000);
    return () => clearInterval(timer);
  }, [isAuthenticated, currentUser, clientUseFirestore, isPageVisible, isUserActive]);

  // Update current user identity
  const handleCurrentUserChange = (username: string) => {
    setCurrentUser(username);
    localStorage.setItem("beer_logger_username", username);
  };

  const handleLoginSuccess = (username: string) => {
    setCurrentUser(username);
    setIsAuthenticated(true);
    localStorage.setItem("beer_logger_username", username);
    localStorage.setItem("beer_logger_authenticated", "true");
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    setCurrentUser("");
    localStorage.removeItem("beer_logger_authenticated");
    localStorage.removeItem("beer_logger_username");
  };

  useEffect(() => {
    if (currentUser) {
      const pinned = localStorage.getItem(`beer_logger_pinned_pub_${currentUser}`) || "";
      setPinnedPubId(pinned);
      if (pinned) {
        setSelectedPubId(pinned);
      } else {
        setSelectedPubId("all");
      }
    } else {
      setPinnedPubId("");
      setSelectedPubId("all");
    }
  }, [currentUser]);

  const handlePinPub = (pubId: string) => {
    if (!currentUser) return;
    if (pinnedPubId === pubId) {
      // Unpin
      localStorage.removeItem(`beer_logger_pinned_pub_${currentUser}`);
      setPinnedPubId("");
    } else {
      // Pin
      localStorage.setItem(`beer_logger_pinned_pub_${currentUser}`, pubId);
      setPinnedPubId(pubId);
    }
  };

  // Add new logged beer
  const handleLogAdded = (newLog: BeerLog) => {
    setLiveBeers((prev) => {
      if (prev.some((b) => b.id === newLog.id)) return prev;
      return [newLog, ...prev];
    });
    setLogs((prevLogs) => {
      if (prevLogs.some((b) => b.id === newLog.id)) return prevLogs;
      return [newLog, ...prevLogs];
    });
    setFilteredBeers((prev) => {
      if (prev.some((b) => b.id === newLog.id)) return prev;
      return [newLog, ...prev];
    });
    setActiveTab("feed"); // Jump to feed to see check-in
  };

  const handleOpenQuickLog = () => {
    setEditLogTarget(null);
    setIsQuickLogOpen(true);
  };

  const handleEditLogRequested = (log: BeerLog) => {
    setEditLogTarget(log);
    setIsQuickLogOpen(true);
  };

  // Handle Cheers toggled
  const handleCheersToggled = async (id: string) => {
    // Save snapshots for rollback if server write fails
    const prevLive = liveBeers;
    const prevOlder = olderBeers;
    const prevLogs = logs;

    // Generate optimistic state
    const toggleCheersLocally = (log: BeerLog): BeerLog => {
      if (log.id !== id) return log;
      const cheersList = log.cheers ? [...log.cheers] : [];
      const userIndex = cheersList.indexOf(currentUser);
      if (userIndex === -1) {
        cheersList.push(currentUser);
      } else {
        cheersList.splice(userIndex, 1);
      }
      
      // Also update reactions map "cheers" key for uniformity
      const reactionsObj = log.reactions ? { ...log.reactions } : {};
      reactionsObj["cheers"] = [...cheersList];

      return {
        ...log,
        cheers: cheersList,
        reactions: reactionsObj,
      };
    };

    // Apply optimistic updates immediately
    setLiveBeers((prev) => prev.map(toggleCheersLocally));
    setOlderBeers((prev) => prev.map(toggleCheersLocally));
    setLogs((prev) => prev.map(toggleCheersLocally));
    setFilteredBeers((prev) => prev.map(toggleCheersLocally));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`/api/beers/${encodeURIComponent(id)}/cheers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username: currentUser, user: currentUser }),
        signal: controller.signal,
      });

      if (!response.ok) {
        console.warn("Could not sync cheers to server. Reverting optimistic update.");
        setLiveBeers(prevLive);
        setOlderBeers(prevOlder);
        setLogs(prevLogs);
        return;
      }

      const updatedLog: BeerLog = await response.json();
      if (updatedLog && updatedLog.id) {
        setLiveBeers((prev) => prev.map((log) => (log.id === id ? updatedLog : log)));
        setOlderBeers((prev) => prev.map((log) => (log.id === id ? updatedLog : log)));
        setLogs((prevLogs) =>
          prevLogs.map((log) => (log.id === id ? updatedLog : log))
        );
        setFilteredBeers((prev) =>
          prev.map((log) => (log.id === id ? updatedLog : log))
        );
      }
    } catch (err) {
      console.warn("Error registering cheers. Reverting optimistic update:", err);
      setLiveBeers(prevLive);
      setOlderBeers(prevOlder);
      setLogs(prevLogs);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  // Handle Reaction toggled
  const handleReactionToggled = async (id: string, reactionType: string) => {
    // Save snapshots for rollback if server write fails
    const prevLive = liveBeers;
    const prevOlder = olderBeers;
    const prevLogs = logs;

    const toggleReactionLocally = (log: BeerLog): BeerLog => {
      if (log.id !== id) return log;
      const reactionsObj = log.reactions ? { ...log.reactions } : {};
      const list = reactionsObj[reactionType] ? [...reactionsObj[reactionType]] : [];
      const userIndex = list.indexOf(currentUser);
      if (userIndex === -1) {
        list.push(currentUser);
      } else {
        list.splice(userIndex, 1);
      }
      reactionsObj[reactionType] = list;

      // Handle dual sync if reaction is "cheers"
      let cheersList = log.cheers ? [...log.cheers] : [];
      if (reactionType === "cheers") {
        cheersList = [...list];
      }

      return {
        ...log,
        reactions: reactionsObj,
        cheers: cheersList,
      };
    };

    // Apply optimistic updates immediately
    setLiveBeers((prev) => prev.map(toggleReactionLocally));
    setOlderBeers((prev) => prev.map(toggleReactionLocally));
    setLogs((prev) => prev.map(toggleReactionLocally));
    setFilteredBeers((prev) => prev.map(toggleReactionLocally));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`/api/beers/${encodeURIComponent(id)}/react`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username: currentUser, user: currentUser, reactionType }),
        signal: controller.signal,
      });

      if (!response.ok) {
        console.warn("Could not sync reaction to server. Reverting optimistic update.");
        setLiveBeers(prevLive);
        setOlderBeers(prevOlder);
        setLogs(prevLogs);
        return;
      }

      const updatedLog: BeerLog = await response.json();
      if (updatedLog && updatedLog.id) {
        setLiveBeers((prev) => prev.map((log) => (log.id === id ? updatedLog : log)));
        setOlderBeers((prev) => prev.map((log) => (log.id === id ? updatedLog : log)));
        setLogs((prevLogs) =>
          prevLogs.map((log) => (log.id === id ? updatedLog : log))
        );
        setFilteredBeers((prev) =>
          prev.map((log) => (log.id === id ? updatedLog : log))
        );
      }
    } catch (err) {
      console.warn("Error registering reaction. Reverting optimistic update:", err);
      setLiveBeers(prevLive);
      setOlderBeers(prevOlder);
      setLogs(prevLogs);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  // Delete log
  const handleLogDeleted = async (id: string) => {
    // Snapshot state for potential rollback
    const prevLive = liveBeers;
    const prevOlder = olderBeers;
    const prevLogs = logs;

    // Immediately update local state so UI responds instantly
    setLiveBeers((prev) => prev.filter((log) => log.id !== id));
    setOlderBeers((prev) => prev.filter((log) => log.id !== id));
    setLogs((prevLogs) => prevLogs.filter((log) => log.id !== id));
    setFilteredBeers((prev) => prev.filter((log) => log.id !== id));

    try {
      const response = await fetch(`/api/beers/${id}?currentUser=${encodeURIComponent(currentUser)}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorData = await response.json();
        // Rollback state on error
        setLiveBeers(prevLive);
        setOlderBeers(prevOlder);
        setLogs(prevLogs);
        alert(errorData.error || "Failed to delete log");
      }
    } catch (err: any) {
      console.error("Failed to delete log:", err);
      setLiveBeers(prevLive);
      setOlderBeers(prevOlder);
      setLogs(prevLogs);
    }
  };

  // Handle Log Updated (e.g. comment added or deleted)
  const handleLogUpdated = (updatedLog: BeerLog) => {
    setLiveBeers((prev) => prev.map((log) => (log.id === updatedLog.id ? updatedLog : log)));
    setOlderBeers((prev) => prev.map((log) => (log.id === updatedLog.id ? updatedLog : log)));
    setLogs((prevLogs) =>
      prevLogs.map((log) => (log.id === updatedLog.id ? updatedLog : log))
    );
    setFilteredBeers((prev) =>
      prev.map((log) => (log.id === updatedLog.id ? updatedLog : log))
    );
  };

  // Scoped Firestore Filter One-Time Fetch (getDocs)
  useEffect(() => {
    if (!isFilterActive) {
      setFilteredBeers([]);
      return;
    }

    if (!isAuthenticated || !currentUser) return;

    let isCancelled = false;

    const fetchFilteredBeers = async () => {
      setLoadingFiltered(true);

      const constraints: QueryConstraint[] = [];

      if (selectedUserFilter !== "all") {
        constraints.push(where("user", "==", selectedUserFilter));
      }

      if (selectedPubId && selectedPubId !== "global" && selectedPubId !== "all") {
        constraints.push(where("pubId", "==", selectedPubId));
      }

      if (!clientUseFirestore || !db || searchTerm.trim()) {
        try {
          const params = new URLSearchParams({ limit: "10" });
          if (selectedUserFilter !== "all") params.append("user", selectedUserFilter);
          if (selectedPubId && selectedPubId !== "global" && selectedPubId !== "all") {
            params.append("pubId", selectedPubId);
          }
          if (searchTerm.trim()) {
            params.append("search", searchTerm.trim());
          }

          const res = await fetch(`/api/beers?${params.toString()}`);
          if (res.ok) {
            const data = await res.json();
            if (!isCancelled) {
              setFilteredBeers(data.beers || []);
              setFilteredHasMore(!!data.hasMore);
            }
          }
        } catch (err) {
          console.error("Failed to fetch filtered beers via API:", err);
        } finally {
          if (!isCancelled) setLoadingFiltered(false);
        }
        return;
      }

      try {
        console.log(`[Firestore Scoped Query] Fetching database-scoped query for filters: user=${selectedUserFilter}, pubId=${selectedPubId}`);
        const q = query(
          collection(db, "beers"),
          ...constraints,
          orderBy("date", "desc"),
          limit(10)
        );

        const snapshot = await getDocs(q);
        const list: BeerLog[] = [];
        snapshot.forEach((d) => list.push(d.data() as BeerLog));

        if (!isCancelled) {
          setFilteredBeers(list);
          setFilteredHasMore(list.length >= 10);
        }
      } catch (err: any) {
        console.warn("[Firestore Scoped Query] Filtered query error/index missing. Trying fallback query:", err);
        try {
          const qFallback = query(collection(db, "beers"), ...constraints, limit(20));
          const snapshotFallback = await getDocs(qFallback);
          const fallbackList: BeerLog[] = [];
          snapshotFallback.forEach((d) => fallbackList.push(d.data() as BeerLog));
          fallbackList.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

          if (!isCancelled) {
            setFilteredBeers(fallbackList.slice(0, 10));
            setFilteredHasMore(fallbackList.length >= 10);
          }
        } catch (fallbackErr: any) {
          console.error("Failed to fetch fallback filtered beers:", fallbackErr);
          handleListenerErrorGlobal(fallbackErr, "filtered_beers");
        }
      } finally {
        if (!isCancelled) setLoadingFiltered(false);
      }
    };

    fetchFilteredBeers();

    return () => {
      isCancelled = true;
    };
  }, [
    selectedUserFilter,
    selectedPubId,
    searchTerm,
    clientUseFirestore,
    isAuthenticated,
    currentUser,
    db,
    isFilterActive
  ]);

  // Handle Load More Filtered Results with startAfter pagination
  const handleLoadMoreFiltered = async () => {
    if (loadingMore || !filteredHasMore) return;
    setLoadingMore(true);

    const oldestDate = filteredBeers.length > 0 ? filteredBeers[filteredBeers.length - 1].date : null;
    if (!oldestDate) {
      setFilteredHasMore(false);
      setLoadingMore(false);
      return;
    }

    const constraints: QueryConstraint[] = [];
    if (selectedUserFilter !== "all") {
      constraints.push(where("user", "==", selectedUserFilter));
    }
    if (selectedPubId && selectedPubId !== "global" && selectedPubId !== "all") {
      constraints.push(where("pubId", "==", selectedPubId));
    }

    if (!clientUseFirestore || !db || searchTerm.trim()) {
      try {
        const offset = filteredBeers.length;
        const params = new URLSearchParams({ limit: "10", offset: offset.toString() });
        if (selectedUserFilter !== "all") params.append("user", selectedUserFilter);
        if (selectedPubId && selectedPubId !== "global" && selectedPubId !== "all") {
          params.append("pubId", selectedPubId);
        }
        if (searchTerm.trim()) {
          params.append("search", searchTerm.trim());
        }

        const res = await fetch(`/api/beers?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          const fetched = data.beers || [];
          setFilteredBeers((prev) => [...prev, ...fetched]);
          setFilteredHasMore(!!data.hasMore);
        }
      } catch (err) {
        console.error("Failed to load more filtered beers via API:", err);
      } finally {
        setLoadingMore(false);
      }
      return;
    }

    try {
      console.log(`[Firestore Scoped Query] Fetching next 10 filtered logs starting after date ${oldestDate}...`);
      const q = query(
        collection(db, "beers"),
        ...constraints,
        orderBy("date", "desc"),
        startAfter(oldestDate),
        limit(10)
      );

      const snapshot = await getDocs(q);
      const fetched: BeerLog[] = [];
      snapshot.forEach((doc) => fetched.push(doc.data() as BeerLog));

      if (fetched.length < 10) {
        setFilteredHasMore(false);
      }

      setFilteredBeers((prev) => {
        const existingIds = new Set(prev.map((b) => b.id));
        const uniqueNew = fetched.filter((b) => !existingIds.has(b.id));
        return [...prev, ...uniqueNew];
      });
    } catch (err: any) {
      console.error("Failed to load more filtered beers from Firestore:", err);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleClearFilters = () => {
    setSelectedUserFilter("all");
    setSelectedPubId("global");
  };

  // Handle Load More older paginated beers
  const handleLoadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);

    if (!clientUseFirestore) {
      try {
        const currentCount = liveBeers.length + olderBeers.length;
        const res = await fetch(`/api/beers?limit=10&offset=${currentCount}`);
        if (!res.ok) {
          throw new Error("Failed to load more local pints");
        }
        const data = await res.json();
        setOlderBeers((prev) => [...prev, ...(data.beers || [])]);
        setHasMore(!!data.hasMore);
      } catch (err) {
        console.error("Failed to load more local pints:", err);
      } finally {
        setLoadingMore(false);
      }
      return;
    }

    if (!db) {
      setLoadingMore(false);
      return;
    }

    try {
      // Find the oldest date currently in the logs list
      const oldestDate = logs.length > 0 ? logs[logs.length - 1].date : null;
      if (!oldestDate) {
        setHasMore(false);
        return;
      }

      console.log(`[Firestore] Fetching older pints starting after: ${oldestDate}...`);
      const q = query(
        collection(db, "beers"),
        orderBy("date", "desc"),
        startAfter(oldestDate),
        limit(10)
      );

      const snapshot = await getDocs(q);
      const fetched: BeerLog[] = [];
      snapshot.forEach((doc) => {
        fetched.push(doc.data() as BeerLog);
      });

      if (fetched.length < 10) {
        setHasMore(false);
      }

      setOlderBeers((prev) => {
        const existingIds = new Set(prev.map((b) => b.id));
        const filtered = fetched.filter((b) => !existingIds.has(b.id));
        return [...prev, ...filtered];
      });
    } catch (err: any) {
      console.error("Failed to load more pints from Firestore:", err);
      const errMsg = err?.message || err?.toString() || "";
      if (
        errMsg.toLowerCase().includes("quota") ||
        errMsg.toLowerCase().includes("exhausted") ||
        err?.code === "resource-exhausted"
      ) {
        setRealtimeError("Database quota exceeded. Switched to local server files fallback.");
        setClientUseFirestore(false);
        fetchData(false, true);
      }
    } finally {
      setLoadingMore(false);
    }
  };

  // Add/Update user profile
  const handleProfileAddedOrUpdated = (profile: UserProfile) => {
    setUsers((prevUsers) => {
      const index = prevUsers.findIndex((u) => u.username === profile.username);
      if (index !== -1) {
        const copy = [...prevUsers];
        copy[index] = profile;
        return copy;
      } else {
        return [...prevUsers, profile];
      }
    });
  };

  // Delete user profile and clean up associated local state
  const handleProfileDeleted = async (username: string) => {
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(username)}?currentUser=${encodeURIComponent(currentUser)}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to delete user profile");
      }

      setUsers((prevUsers) => {
        const updatedUsers = prevUsers.filter((u) => u.username !== username);
        // If the deleted user was the currentUser, change the currentUser
        if (currentUser === username) {
          if (updatedUsers.length > 0) {
            handleCurrentUserChange(updatedUsers[0].username);
          } else {
            handleCurrentUserChange("");
          }
        }
        return updatedUsers;
      });

      // Also remove their logs from local state to keep consistency
      setLogs((prevLogs) => prevLogs.filter((log) => log.user !== username));
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Could not delete profile");
    }
  };

  // Self-service account deletion: unlike handleProfileDeleted (admin removing
  // someone else), this always ends in a full logout rather than switching
  // to another account.
  const handleSelfAccountDeleted = async (password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(currentUser)}?currentUser=${encodeURIComponent(currentUser)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { success: false, error: data.error || "Failed to delete your account." };
      }

      setUsers((prevUsers) => prevUsers.filter((u) => u.username !== currentUser));
      setLogs((prevLogs) => prevLogs.filter((log) => log.user !== currentUser));
      handleLogout();
      return { success: true };
    } catch (err: any) {
      console.error(err);
      return { success: false, error: err.message || "Could not delete your account." };
    }
  };

  const handlePubCreated = (newPub: Pub) => {
    setPubs((prev) => [...prev, newPub]);
  };

  const handlePubUpdated = (updatedPub: Pub) => {
    setPubs((prev) => prev.map((p) => p.id === updatedPub.id ? updatedPub : p));
  };

  const handlePubDeleted = (pubId: string) => {
    setPubs((prev) => prev.filter((p) => p.id !== pubId));
    if (selectedPubId === pubId) {
      setSelectedPubId("");
    }
  };

  // Quick helper to fetch active user profile avatar
  const getActiveUserAvatar = () => {
    const matched = users.find((u) => u.username === currentUser);
    return matched?.avatar || "👤";
  };

  const myNotifications = notifications.filter((n) => {
    if (!currentUser) return false;
    const currentUsernameLower = currentUser.toLowerCase().trim();
    const senderLower = n.user?.toLowerCase().trim();
    
    // Never show notifications of actions you performed yourself
    if (senderLower === currentUsernameLower) {
      return false;
    }

    // If targetUser is explicitly defined:
    if (n.targetUser) {
      const targetLower = n.targetUser.toLowerCase().trim();
      return targetLower === currentUsernameLower;
    }
    
    // Otherwise, handle legacy notifications or general notifications:
    const isPostOrBenderOrImposter = n.type === "post" || n.type === "bender" || n.type === "first_pour" || n.type === "imposter" ||
      n.text.includes("logged a pint") || n.text.includes("BENDER ALERT") || n.text.includes("first pint of the day") || n.text.includes("IMPOSTER PINT") ||
      n.text.includes("is sinking") || n.text.includes("is pouring") || n.text.includes("is enjoying") || n.text.includes("is howling");

    if (isPostOrBenderOrImposter) {
      // General post notifications from other users
      return true;
    }

    const isCommentOrCheerOrReaction = n.type === "comment" || n.type === "cheer" || n.type === "reaction" ||
      n.text.includes("cheered your pint") || n.text.includes("commented on your pint") || n.text.includes("reacted with");

    if (isCommentOrCheerOrReaction) {
      // Comments and reactions only to your own posts.
      // We scan the user's logs to see if they own the beer that matches this notification text
      return logs.some(l => 
        l.user.toLowerCase().trim() === currentUsernameLower && 
        n.text.toLowerCase().includes(l.beerName.toLowerCase().trim())
      );
    }

    // Pub invites legacy format (where user was the invitee)
    if (n.text.includes("invited you to join")) {
      return senderLower !== currentUsernameLower;
    }

    // Default fallback: keep if not our own creation
    return senderLower !== currentUsernameLower;
  });

  const unreadCount = myNotifications.filter(
    (n) => !(n.readBy || []).map((r) => r.toLowerCase().trim()).includes(currentUser.toLowerCase().trim())
  ).length;

  const pendingInvitesCount = pubs.filter(
    (p) => (p.invited || []).map((u) => u.toLowerCase().trim()).includes(currentUser.toLowerCase().trim())
  ).length;

  const pendingFriendRequestsCount = (users.find((u) => u.username === currentUser)?.friendRequests || []).length;

  const handleOpenNotifications = async () => {
    const opening = !showNotifsDropdown;
    setShowNotifsDropdown(opening);
    if (opening) {
      // One-time read of notification history when user opens the activity hub
      fetch("/api/notifications")
        .then((res) => (res.ok ? res.json() : []))
        .then((data: AppNotification[]) => {
          if (Array.isArray(data) && data.length > 0) setNotifications(data);
        })
        .catch(() => {});

      if (unreadCount > 0) {
        try {
          await fetch("/api/notifications/read", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ username: currentUser }),
          });
          setNotifications((prev) =>
            prev.map((n) => ({
              ...n,
              readBy: [...(n.readBy || []), currentUser.toLowerCase().trim()],
            }))
          );
        } catch (err) {
          console.error("Failed to mark notifications as read:", err);
        }
      }
    }
  };

  const formatNotifTime = (dateStr: string) => {
    try {
      const diff = Date.now() - new Date(dateStr).getTime();
      if (diff < 60000) return "Just now";
      const mins = Math.floor(diff / 60000);
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      return new Date(dateStr).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch (e) {
      return "";
    }
  };

  if (!ageVerified) {
    return (
      <AgeGate
        onVerified={() => {
          localStorage.setItem("beer_real_age_verified", "true");
          setAgeVerified(true);
        }}
      />
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-3 font-sans">
        <div className="w-10 h-10 border-4 border-amber-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm font-bold text-slate-400">Loading beer records...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <LoginScreen
        users={users}
        onLoginSuccess={handleLoginSuccess}
        onProfileCreated={(newProfile) => {
          setUsers((prev) => [...prev, newProfile]);
          setShowWelcomeCarousel(true);
        }}
      />
    );
  }

  if (showWelcomeCarousel) {
    return (
      <WelcomeCarousel
        onDone={() => {
          setShowWelcomeCarousel(false);
          setShowFriendsOnboarding(true);
        }}
      />
    );
  }

  if (showFriendsOnboarding) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col justify-center py-10 px-4 sm:px-6">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <FriendsHub
            currentUser={currentUser}
            users={users}
            onProfileAddedOrUpdated={handleProfileAddedOrUpdated}
            isOnboarding
            onClose={() => setShowFriendsOnboarding(false)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans antialiased text-slate-900">
      {/* Toast Notification Banner */}
      {activeToast && (
        <div className="fixed top-[calc(1rem+env(safe-area-inset-top,0px))] right-4 left-4 sm:left-auto z-[9999] max-w-sm bg-slate-900 text-white p-4 rounded-2xl shadow-2xl border border-amber-500/40 flex items-start gap-3">
          <div className="p-2 bg-amber-500 text-white rounded-xl text-lg font-black shrink-0">🍻</div>
          <div className="flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-black text-amber-400 uppercase tracking-wider">BeerReel Alert</span>
              <button onClick={() => setActiveToast(null)} className="text-slate-400 hover:text-white text-xs font-bold p-1">✕</button>
            </div>
            <p className="text-xs font-semibold text-slate-100 mt-1">{activeToast.text}</p>
          </div>
        </div>
      )}

      {/* Navigation Top Bar */}
      <header className="sticky top-0 bg-white border-b border-slate-200 z-40 flex-shrink-0 pt-safe">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between gap-2">
          {/* Logo with new stylized Camera-Pint Vector Mark */}
          <Logo size="md" onClick={() => setActiveTab("feed")} />

          {/* Navigation Tabs (Professional Polish Pill-tabs) */}
          <nav className="hidden sm:flex items-center bg-slate-100 p-1 rounded-md">
            <button
              onClick={() => setActiveTab("feed")}
              className={`px-4 py-1.5 text-xs font-semibold rounded transition-all ${
                activeTab === "feed"
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              Live Pints
            </button>
            <button
              onClick={() => setActiveTab("pubs")}
              className={`px-4 py-1.5 text-xs font-semibold rounded transition-all flex items-center gap-1.5 ${
                activeTab === "pubs"
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-850"
              }`}
            >
              Pub Hub
              {pendingInvitesCount > 0 && (
                <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse" />
              )}
            </button>
            <button
              onClick={() => setActiveTab("stats")}
              className={`px-4 py-1.5 text-xs font-semibold rounded transition-all ${
                activeTab === "stats"
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              The Ledger
            </button>
          </nav>

          {/* Identity & Refresh Actions (Professional Polish style) */}
          <div className="flex items-center gap-1.5 sm:gap-3">
            {/* Refresh Button */}
            <button
              onClick={() => fetchData(true)}
              disabled={refreshing}
              className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600 transition-all focus:outline-none shrink-0"
              title="Refresh logs"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin text-amber-500" : ""}`} />
            </button>

            {/* Notifications Bell */}
            <div className="relative" ref={notificationsRef}>
              <button
                onClick={handleOpenNotifications}
                className={`flex items-center gap-1.5 py-1 px-2.5 sm:py-1.5 sm:px-3 rounded-xl border transition-all focus:outline-none cursor-pointer shrink-0 ${
                  unreadCount > 0
                    ? "bg-amber-500 text-white border-amber-500 shadow-lg shadow-amber-200/50 dark:shadow-none animate-pulse font-black"
                    : "bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 hover:text-amber-500 hover:bg-slate-100 hover:border-slate-300 dark:hover:bg-slate-700"
                }`}
                title="Notifications"
              >
                <Bell className={`w-4 h-4 sm:w-4.5 sm:h-4.5 ${unreadCount > 0 ? "text-white" : "text-slate-400 hover:text-amber-500"}`} />
                <span className="text-xs font-bold hidden sm:inline">Alerts</span>
                {unreadCount > 0 && (
                  <span className="bg-white text-amber-600 dark:bg-slate-900 dark:text-amber-400 w-4 h-4 sm:w-4.5 sm:h-4.5 text-[9px] font-black rounded-full flex items-center justify-center shadow-sm shrink-0">
                    {unreadCount}
                  </span>
                )}
              </button>

              <AnimatePresence>
                {showNotifsDropdown && (
                  <>
                    <motion.div
                      initial={{ opacity: 0, y: 10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 10, scale: 0.95 }}
                      transition={{ duration: 0.15 }}
                      className="fixed sm:absolute top-[calc(3.75rem+env(safe-area-inset-top,0px))] sm:top-auto left-3 right-3 sm:left-auto sm:right-0 sm:mt-2 sm:w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl z-50 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800 animate-in fade-in zoom-in-95 duration-100 flex flex-col max-h-[calc(100vh-8rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] sm:max-h-[500px]"
                    >
                      <div className="px-3.5 py-2.5 bg-slate-900 dark:bg-black/60 flex items-center justify-between border-b border-slate-850 shadow-sm shrink-0">
                        <span className="font-extrabold text-white text-[10px] tracking-wider uppercase flex items-center gap-1.5">
                          <Bell className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
                          Activity Hub
                        </span>
                        <div className="flex items-center gap-2">
                          {unreadCount > 0 && (
                            <button
                              onClick={handleOpenNotifications}
                              className="text-[9px] bg-amber-500 hover:bg-amber-400 text-slate-950 font-black px-2 py-0.5 rounded-full uppercase tracking-wider shadow-sm transition-all cursor-pointer active:scale-95"
                              title="Mark all notifications as read"
                            >
                              Mark All Read ({unreadCount})
                            </button>
                          )}
                        </div>
                      </div>
                      
                      <div className="overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/50 flex-1 min-h-0">
                        {myNotifications.length === 0 ? (
                          <div className="p-8 text-center text-slate-400 dark:text-slate-500 space-y-2">
                            <span className="text-2xl">🍺</span>
                            <p className="text-[11px] font-bold">No notifications yet</p>
                            <p className="text-[10px] text-slate-400">Activity on your logs or check-ins will show up here.</p>
                          </div>
                        ) : (
                          myNotifications.slice(0, 15).map((notif) => {
                            const isUnread = !(notif.readBy || []).map(r => r.toLowerCase().trim()).includes(currentUser.toLowerCase().trim());
                            
                            // Define overlay icon and colors based on type
                            let typeColorClass = "bg-slate-400 text-white";
                            let typeIcon = <Bell className="w-2.5 h-2.5" />;
                            let badgeLabel = "";
                            let badgeStyle = "";

                            if (notif.type === "imposter" || notif.text.includes("IMPOSTER PINT")) {
                              typeColorClass = "bg-rose-500 text-white shadow-rose-300/30";
                              typeIcon = <ShieldAlert className="w-2.5 h-2.5" />;
                              badgeLabel = "Imposter Outed";
                              badgeStyle = "bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400 border-rose-100 dark:border-rose-900/40";
                            } else if (notif.type === "bender" || notif.text.includes("BENDER ALERT")) {
                              typeColorClass = "bg-red-500 text-white animate-pulse shadow-red-300/30";
                              typeIcon = <Flame className="w-2.5 h-2.5" />;
                              badgeLabel = "Bender";
                              badgeStyle = "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400 border-red-100 dark:border-red-900/40";
                            } else if (notif.type === "first_pour" || notif.text.includes("first pint of the day")) {
                              typeColorClass = "bg-amber-500 text-white shadow-amber-300/30";
                              typeIcon = <Sparkles className="w-2.5 h-2.5" />;
                              badgeLabel = "First Pour";
                              badgeStyle = "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 border-amber-100 dark:border-amber-900/40";
                            } else if (notif.type === "comment" || notif.text.includes("commented on")) {
                              typeColorClass = "bg-indigo-500 text-white shadow-indigo-300/30";
                              typeIcon = <MessageSquare className="w-2.5 h-2.5" />;
                              badgeLabel = "Comment";
                              badgeStyle = "bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400 border-indigo-100 dark:border-indigo-900/40";
                            } else if (notif.type === "cheer" || notif.text.includes("cheered your")) {
                              typeColorClass = "bg-amber-500 text-white shadow-amber-300/30";
                              typeIcon = <Heart className="w-2.5 h-2.5" />;
                              badgeLabel = "Cheer";
                              badgeStyle = "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 border-amber-100 dark:border-amber-900/40";
                            } else if (notif.type === "reaction" || notif.text.includes("reacted with")) {
                              typeColorClass = "bg-pink-500 text-white shadow-pink-300/30";
                              typeIcon = <Smile className="w-2.5 h-2.5" />;
                              badgeLabel = "Reacted";
                              badgeStyle = "bg-pink-50 text-pink-600 dark:bg-pink-950/40 dark:text-pink-400 border-pink-100 dark:border-pink-900/40";
                            } else if (notif.type === "tag" || notif.text.includes("tagged you")) {
                              typeColorClass = "bg-teal-500 text-white shadow-teal-300/30";
                              typeIcon = <Tag className="w-2.5 h-2.5" />;
                              badgeLabel = "Tagged";
                              badgeStyle = "bg-teal-50 text-teal-600 dark:bg-teal-950/40 dark:text-teal-400 border-teal-100 dark:border-teal-900/40";
                            } else if (notif.type === "post" || notif.text.includes("logged a pint") || notif.text.includes("sinking") || notif.text.includes("whistle")) {
                              typeColorClass = "bg-amber-500 text-white shadow-amber-300/30";
                              typeIcon = <Beer className="w-2.5 h-2.5" />;
                              badgeLabel = "Fresh Pint";
                              badgeStyle = "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 border-amber-100 dark:border-amber-900/40";
                            } else if (notif.type === "invite" || notif.text.includes("invited you")) {
                              typeColorClass = "bg-emerald-500 text-white shadow-emerald-300/30";
                              typeIcon = <Users className="w-2.5 h-2.5" />;
                              badgeLabel = "Invite";
                              badgeStyle = "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400 border-emerald-100 dark:border-emerald-900/40";
                            } else if (notif.type === "beacon" || notif.text.includes("BEACON LIT")) {
                              typeColorClass = "bg-orange-500 text-slate-950 font-black animate-pulse shadow-orange-300/30";
                              typeIcon = <Flame className="w-2.5 h-2.5" />;
                              badgeLabel = "Beacon Lit";
                              badgeStyle = "bg-orange-50 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400 border-orange-100 dark:border-orange-900/40";
                            } else if (notif.type === "chat" || notif.text.includes("posted in")) {
                              typeColorClass = "bg-sky-500 text-white shadow-sky-300/30";
                              typeIcon = <MessageSquare className="w-2.5 h-2.5" />;
                              badgeLabel = "Pub Chat";
                              badgeStyle = "bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400 border-sky-100 dark:border-sky-900/40";
                            } else if (notif.type === "friend_request" || notif.text.includes("wants to be your friend")) {
                              typeColorClass = "bg-violet-500 text-white shadow-violet-300/30";
                              typeIcon = <UserPlus className="w-2.5 h-2.5" />;
                              badgeLabel = "Friend Request";
                              badgeStyle = "bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400 border-violet-100 dark:border-violet-900/40";
                            } else if (notif.type === "friend_accept" || notif.text.includes("friend request") || notif.text.includes("now friends with you")) {
                              typeColorClass = "bg-violet-500 text-white shadow-violet-300/30";
                              typeIcon = <UserCheck className="w-2.5 h-2.5" />;
                              badgeLabel = "New Friend";
                              badgeStyle = "bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400 border-violet-100 dark:border-violet-900/40";
                            }

                             return (
                               <motion.div
                                 initial={{ opacity: 0, x: -5 }}
                                 animate={{ opacity: 1, x: 0 }}
                                 transition={{ duration: 0.15 }}
                                 key={notif.id}
                                 className={`p-3.5 flex items-start gap-3 transition-all relative border-b border-slate-50 dark:border-slate-800/40 hover:bg-slate-50/70 dark:hover:bg-slate-850/40 ${
                                   isUnread ? "bg-amber-500/[0.03] dark:bg-amber-500/[0.015]" : ""
                                 }`}
                               >
                                 {isUnread && (
                                   <div className="absolute top-0 bottom-0 left-0 w-1 bg-amber-500 rounded-r-md" />
                                 )}
                                 
                                 {/* Avatar with sleek sub-icon overlay */}
                                 <div className="relative shrink-0">
                                   <UserAvatar username={notif.user} users={users} className="w-9 h-9 text-xs ring-2 ring-white dark:ring-slate-900 shadow-sm" />
                                   <div className={`absolute -bottom-1 -right-1 w-4.5 h-4.5 rounded-full flex items-center justify-center border border-white dark:border-slate-900 shadow-sm text-white ${typeColorClass}`}>
                                     {typeIcon}
                                   </div>
                                 </div>

                                 <div className="flex-1 min-w-0">
                                   <div className="flex flex-wrap items-center justify-between gap-1 mb-1">
                                     <span className="font-extrabold text-slate-900 dark:text-slate-100 text-[12px] hover:underline cursor-pointer">
                                       {notif.user}
                                     </span>
                                     {badgeLabel && (
                                       <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[8px] font-black border uppercase tracking-wider scale-95 ${badgeStyle}`}>
                                         {badgeLabel}
                                       </span>
                                     )}
                                   </div>
                                   
                                   <div className="text-[11px] text-slate-700 dark:text-slate-300 leading-normal font-medium pr-1">
                                     <span dangerouslySetInnerHTML={{ __html: notif.text }} />
                                   </div>
                                   
                                   <div className="text-[9px] text-slate-400 dark:text-slate-500 font-bold mt-1.5 flex items-center gap-1.5">
                                     <span>{formatNotifTime(notif.date)}</span>
                                   </div>
                                 </div>
                                 
                                 {isUnread && (
                                   <span className="w-2 h-2 bg-amber-500 rounded-full shrink-0 mt-2.5 shadow-sm shadow-amber-500/50 animate-pulse" />
                                 )}
                               </motion.div>
                             );
                           })
                        )}
                      </div>

                      {/* PWA Home Screen Alerts Management (Styled sleekly as dropdown footer) */}
                      <div className="p-3 sm:p-3.5 bg-slate-50 dark:bg-slate-900/90 border-t border-slate-100 dark:border-slate-800 text-center flex flex-col gap-2 shrink-0">
                        <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 font-bold px-0.5">
                          <span className="flex items-center gap-1.5">
                            <Smartphone className="w-3.5 h-3.5 text-amber-500" />
                            Mobile & Lock Screen Alerts
                          </span>
                          <span className={`px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-wider ${
                            notificationPermission === "granted" 
                              ? "bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400" 
                              : notificationPermission === "denied"
                              ? "bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400"
                              : "bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                          }`}>
                            {notificationPermission === "default" ? "inactive" : notificationPermission}
                          </span>
                        </div>

                        {/* iOS PWA Guidance if on iOS and not standalone */}
                        {typeof window !== "undefined" &&
                         (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) &&
                         !(window.matchMedia("(display-mode: standalone)").matches || (window.navigator as any).standalone) && (
                          <div className="p-2.5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40 rounded-xl text-left text-[9.5px] text-amber-800 dark:text-amber-300 font-medium space-y-1">
                            <p className="font-extrabold flex items-center gap-1 text-[10px]">
                              <span>📱</span> iOS Lock Screen Notifications
                            </p>
                            <p className="text-[9px]">To receive alerts on your iPhone screen when app is closed:</p>
                            <ol className="list-decimal list-inside space-y-0.5 text-[9px] font-semibold text-amber-700 dark:text-amber-400">
                              <li>Tap <strong>Share (⎋)</strong> in Safari</li>
                              <li>Tap <strong>Add to Home Screen (⊞)</strong></li>
                              <li>Open app from Home Screen & enable alerts!</li>
                            </ol>
                          </div>
                        )}

                        {notificationPermission !== "granted" ? (
                          <button
                            onClick={requestNotificationPermission}
                            className="w-full py-1.5 px-3 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white font-black rounded-lg text-[9px] uppercase tracking-wider transition-all cursor-pointer shadow-sm hover:shadow active:scale-[0.98] outline-none"
                          >
                            Enable System Notifications
                          </button>
                        ) : (
                          <button
                            onClick={sendTestPushNotification}
                            className="w-full py-1.5 px-3 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold rounded-lg text-[9px] transition-all cursor-pointer border border-slate-200 dark:border-slate-700 shadow-sm active:scale-[0.98] outline-none flex items-center justify-center gap-1.5"
                          >
                            <span>🔔</span> Send Test Lock Screen Push
                          </button>
                        )}
                      </div>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>

            {/* Profile Dropdown with line-separated indicators */}
            <div className="flex items-center gap-1.5 sm:gap-3 border-l border-slate-200 pl-2 sm:pl-4">
              <div className="text-right hidden sm:block">
                <p className="text-xs font-bold text-slate-800 leading-none">{currentUser}</p>
                <p className="text-[10px] text-amber-600 font-bold uppercase mt-1 truncate max-w-[150px]" title={getMostDrankBeerForUser(currentUser, logs)}>
                  {getMostDrankBeerForUser(currentUser, logs) === "No beers logged yet" ? "Pub Regular" : `Fav: ${getMostDrankBeerForUser(currentUser, logs).split(" (")[0]}`}
                </p>
              </div>
              <button
                onClick={() => setIsProfileOpen(true)}
                className="relative transition-all focus:outline-none hover:opacity-80 active:scale-95 shrink-0"
                title="My Profile & Friends"
              >
                <UserAvatar username={currentUser} users={users} className="w-8 h-8 sm:w-9 sm:h-9 text-base sm:text-lg" />
                {pendingFriendRequestsCount > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-rose-500 text-white text-[9px] font-black rounded-full flex items-center justify-center border-2 border-white dark:border-slate-900">
                    {pendingFriendRequestsCount}
                  </span>
                )}
              </button>

              <button
                onClick={handleLogout}
                className="p-1 sm:p-1.5 hover:bg-red-50 rounded-lg text-slate-400 hover:text-red-500 transition-all focus:outline-none shrink-0"
                title="Log Out"
              >
                <LogOut className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Arena */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24 sm:pb-8">
        {error ? (
          /* Error State */
          <div className="text-center py-16 bg-white border border-red-100 rounded-2xl max-w-md mx-auto p-6 space-y-4">
            <div className="text-4xl">⚠️</div>
            <h3 className="text-lg font-bold text-red-800">Connection Error</h3>
            <p className="text-sm text-red-600/80">{error}</p>
            <button
              onClick={() => fetchData()}
              className="bg-red-100 hover:bg-red-200 text-red-800 font-bold py-2 px-4 rounded-xl text-xs transition-colors"
            >
              Retry Connection
            </button>
          </div>
        ) : (
          /* Dynamic Route Views */
          <>
            {realtimeError && (
              <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-850 p-4 rounded-xl text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm animate-fade-in dark:bg-amber-950/20 dark:border-amber-900/30 dark:text-amber-400">
                <div className="flex items-start gap-3">
                  <span className="relative flex h-2 w-2 mt-1">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                  </span>
                  <div className="space-y-1">
                    <p className="font-semibold text-amber-950 dark:text-amber-200">
                      {realtimeError.toLowerCase().includes("quota") || realtimeError.toLowerCase().includes("exhausted")
                        ? "Firestore Daily Quota Limit Exceeded"
                        : "Real-time Sync Interrupted"}
                    </p>
                    <p className="text-amber-800/90 dark:text-amber-400/80 leading-relaxed">
                      {realtimeError.toLowerCase().includes("quota") || realtimeError.toLowerCase().includes("exhausted") ? (
                        <>
                          Your actual logs and user profiles are <strong>completely safe and intact</strong> inside Firestore! However, the Firebase project has reached its free tier daily limit of 50,000 document reads. To restore your data instantly, you can enable billing (the pay-as-you-go Blaze plan, which is extremely cheap) in your Firebase Console, or simply wait for the daily quota to reset (midnight PST). The app is currently falling back to a temporary offline container memory copy.
                        </>
                      ) : (
                        `Details: ${realtimeError}. Viewing cached/offline copy.`
                      )}
                    </p>
                  </div>
                </div>
                <button
                  onClick={async (e) => {
                    const btn = e.currentTarget;
                    btn.disabled = true;
                    const originalText = btn.textContent;
                    btn.textContent = "Connecting...";
                    setRealtimeError(null);
                    try {
                      const res = await fetch("/api/firestore-reconnect", { method: "POST" });
                      const data = await res.json();
                      if (res.ok && data.success) {
                        setClientUseFirestore(true);
                        await fetchData(true);
                      } else {
                        setRealtimeError("Reconnection failed: " + (data.message || "Unknown error"));
                      }
                    } catch (err: any) {
                      setRealtimeError("Reconnection failed: " + (err.message || "Connection refused"));
                    } finally {
                      btn.disabled = false;
                      btn.textContent = originalText;
                    }
                  }}
                  className="bg-amber-100 dark:bg-amber-900/40 hover:bg-amber-200 dark:hover:bg-amber-900/60 text-amber-800 dark:text-amber-300 font-bold py-1.5 px-3 rounded-lg transition-colors whitespace-nowrap self-end sm:self-center disabled:opacity-50"
                >
                  Retry Connection
                </button>
              </div>
            )}

            {clientUseFirestore && !isUserActive && (
              <div className="mb-6 bg-amber-50/95 border border-amber-200 text-amber-950 p-4 rounded-xl text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm animate-fade-in dark:bg-amber-950/20 dark:border-amber-900/30 dark:text-amber-400">
                <div className="flex items-start gap-3">
                  <span className="relative flex h-2 w-2 mt-1 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                  </span>
                  <div className="space-y-1">
                    <p className="font-semibold text-amber-950 dark:text-amber-200">
                      Real-time Feed Paused (Idle Timeout)
                    </p>
                    <p className="text-amber-800/90 dark:text-amber-400/80 leading-relaxed">
                      To prevent background read costs, real-time database listeners have been disconnected after 25 minutes of inactivity. Don't worry, your feed will automatically resume as soon as you move, scroll, click, or tap anywhere in the app!
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setIsUserActive(true);
                  }}
                  className="bg-amber-100 dark:bg-amber-900/40 hover:bg-amber-200 dark:hover:bg-amber-900/60 text-amber-800 dark:text-amber-300 font-bold py-1.5 px-3 rounded-lg transition-colors whitespace-nowrap self-end sm:self-center focus:outline-none"
                >
                  Reconnect Now
                </button>
              </div>
            )}



            <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === "pubs" && (
                <PubHub
                  currentUser={currentUser}
                  users={users}
                  pubs={pubs}
                  logs={logs}
                  selectedPubId={selectedPubId}
                  onPubSelect={setSelectedPubId}
                  pinnedPubId={pinnedPubId}
                  onPinPub={handlePinPub}
                  onPubCreated={handlePubCreated}
                  onPubUpdated={handlePubUpdated}
                  onPubDeleted={handlePubDeleted}
                  onViewProfileRequested={(username) => {
                    setViewingProfileUsername(username);
                    setIsProfileOpen(true);
                  }}
                />
              )}

              {activeTab === "feed" && (
                <ActivityFeed
                  logs={applyBlockFilter(isFilterActive ? filteredBeers : logs)}
                  users={users}
                  currentUser={currentUser}
                  pubs={pubs}
                  selectedPubId={selectedPubId}
                  onPubSelect={setSelectedPubId}
                  selectedUserFilter={selectedUserFilter}
                  onUserFilterChange={setSelectedUserFilter}
                  searchTerm={searchTerm}
                  onSearchTermChange={setSearchTerm}
                  pinnedPubId={pinnedPubId}
                  onPinPub={handlePinPub}
                  onCheersToggled={handleCheersToggled}
                  onReactionToggled={handleReactionToggled}
                  onLogDeleted={handleLogDeleted}
                  onLogUpdated={handleLogUpdated}
                  onEditLogRequested={handleEditLogRequested}
                  onQuickLogRequested={handleOpenQuickLog}
                  onViewProfileRequested={(username) => {
                    setViewingProfileUsername(username);
                    setIsProfileOpen(true);
                  }}
                  onLoadMore={isFilterActive ? handleLoadMoreFiltered : handleLoadMore}
                  loadingMore={loadingMore || (isFilterActive && loadingFiltered)}
                  hasMore={isFilterActive ? filteredHasMore : hasMore}
                />
              )}

              {activeTab === "stats" && (
                <Statistics 
                  logs={logs}
                  users={users} 
                  pubs={pubs}
                  selectedPubId={selectedPubId}
                  onPubSelect={setSelectedPubId}
                  pinnedPubId={pinnedPubId}
                  onPinPub={handlePinPub}
                  currentUser={currentUser}
                  onViewProfileRequested={(username) => {
                    setViewingProfileUsername(username);
                    setIsProfileOpen(true);
                  }}
                  clientUseFirestore={clientUseFirestore}
                />
              )}
            </motion.div>
          </AnimatePresence>
          </>
        )}
      </main>

      {/* Identity Profile Overlay Modal */}
      <UserProfileManager
        users={users}
        currentUser={currentUser}
        logs={logs}
        isOpen={isProfileOpen}
        onClose={() => {
          setIsProfileOpen(false);
          setViewingProfileUsername(null);
        }}
        viewingUsername={viewingProfileUsername}
        onCurrentUserChanged={handleCurrentUserChange}
        onProfileAddedOrUpdated={handleProfileAddedOrUpdated}
        onProfileDeleted={handleProfileDeleted}
        onSelfAccountDeleted={handleSelfAccountDeleted}
        clientUseFirestore={clientUseFirestore}
        onViewProfileRequested={(username) => setViewingProfileUsername(username)}
        onBackToMyProfile={() => setViewingProfileUsername(null)}
      />

      {/* Quick Log Camera/Enrichment Workflow Overlay */}
      <QuickLogWorkflow
        isOpen={isQuickLogOpen}
        onClose={() => {
          setIsQuickLogOpen(false);
          setEditLogTarget(null);
        }}
        logs={logs}
        currentUser={currentUser}
        selectedPubId={selectedPubId}
        onLogAdded={handleLogAdded}
        onLogUpdated={handleLogUpdated}
        editLog={editLogTarget}
      />

      {/* Mobile Navigation Sticky Bottom Bar */}
      <div className="sm:hidden fixed inset-x-0 bottom-0 z-[100] bg-slate-900/95 dark:bg-slate-950/95 backdrop-blur-md border-t border-slate-800 shadow-[0_-4px_16px_rgba(0,0,0,0.4)] px-2 py-1.5 pb-[calc(env(safe-area-inset-bottom,0px)+8px)] flex justify-around items-center touch-manipulation mobile-bottom-nav">
        <button
          onClick={() => setActiveTab("feed")}
          className={`flex flex-col items-center gap-1 py-1.5 px-2 rounded-xl transition-all flex-1 ${
            activeTab === "feed"
              ? "text-amber-400 bg-amber-500/15 font-extrabold"
              : "text-slate-400 hover:text-slate-200 font-medium"
          }`}
        >
          <Activity className="w-5 h-5" />
          <span className="text-[10px]">Live Feed</span>
        </button>

        <button
          onClick={() => setActiveTab("pubs")}
          className={`flex flex-col items-center gap-1 py-1.5 px-2 rounded-xl transition-all flex-1 relative ${
            activeTab === "pubs"
              ? "text-amber-400 bg-amber-500/15 font-extrabold"
              : "text-slate-400 hover:text-slate-200 font-medium"
          }`}
        >
          <Compass className="w-5 h-5" />
          <span className="text-[10px]">Pub Hub</span>
          {pendingInvitesCount > 0 && (
            <span className="absolute top-1 right-6 w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
          )}
        </button>

        <button
          onClick={() => setActiveTab("stats")}
          className={`flex flex-col items-center gap-1 py-1.5 px-2 rounded-xl transition-all flex-1 ${
            activeTab === "stats"
              ? "text-amber-400 bg-amber-500/15 font-extrabold"
              : "text-slate-400 hover:text-slate-200 font-medium"
          }`}
        >
          <BarChart3 className="w-5 h-5" />
          <span className="text-[10px]">Ledger</span>
        </button>
      </div>
    </div>
  );
}
