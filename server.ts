import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import { BeerLog, UserProfile, AppNotification, Pub, PubChatMessage, ContentReport, PubWidgetConfig, PubWidgetType } from "./src/types";
import { normalizeBeerName } from "./src/data/beerCatalog";
import { isImposterLog } from "./src/utils";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, orderBy, where, writeBatch, limit, onSnapshot, runTransaction } from "firebase/firestore";
import { getStorage, ref, uploadString, getDownloadURL } from "firebase/storage";
import { initializeApp as initializeAdminApp, getApps as getAdminApps, applicationDefault, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { getStorage as getAdminStorage } from "firebase-admin/storage";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: "15mb" }));

// --- Password hashing (salted scrypt, Node's built-in crypto, no extra dependency) ---
const PASSWORD_HASH_PREFIX = "scrypt$";

function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(plain, salt, 64).toString("hex");
  return `${PASSWORD_HASH_PREFIX}${salt}$${hash}`;
}

function isHashedPassword(stored: string): boolean {
  return typeof stored === "string" && stored.startsWith(PASSWORD_HASH_PREFIX);
}

// Verifies a plaintext password against a stored value. Supports legacy plaintext
// values (direct compare) for accounts created before hashing was added - callers
// that authenticate successfully against a legacy value should re-save the user with
// hashPassword() so the account gets migrated to a hash on its next successful login.
function verifyPassword(plain: string, stored: string): boolean {
  if (!stored || typeof plain !== "string") return false;
  if (isHashedPassword(stored)) {
    const parts = stored.slice(PASSWORD_HASH_PREFIX.length).split("$");
    if (parts.length !== 2) return false;
    const [salt, hash] = parts;
    try {
      const hashBuf = Buffer.from(hash, "hex");
      const candidateBuf = crypto.scryptSync(plain, salt, 64);
      if (hashBuf.length !== candidateBuf.length) return false;
      return crypto.timingSafeEqual(hashBuf, candidateBuf);
    } catch {
      return false;
    }
  }
  return stored === plain;
}

// Generates a human-typeable recovery code (e.g. "7F3K-QP9X-2MNR") for self-service
// password reset. There's no email-sending infra in this app, so this is the account
// recovery mechanism: shown to the user exactly once (at signup, or on regeneration),
// hashed at rest with the same scrypt helper used for passwords, never stored in plaintext.
const RECOVERY_CODE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I - avoids ambiguity when handwritten/read aloud
function generateRecoveryCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < 3; g++) {
    let group = "";
    for (let i = 0; i < 4; i++) {
      group += RECOVERY_CODE_CHARS[crypto.randomInt(RECOVERY_CODE_CHARS.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

function normalizeRecoveryCode(code: string): string {
  return (code || "").toString().trim().toUpperCase();
}

// Sanity bounds so a joke/typo'd value (e.g. "5000" instead of "5.0") can't submit
// and silently skew ABV/rating averages across the whole app.
function clampAbv(value: number): number {
  if (!Number.isFinite(value)) return 5.0;
  return Math.min(Math.max(value, 0), 20);
}

function clampRating(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), 5);
}

// Escapes user-supplied text before it's spliced into a notification's HTML string.
// Notification text is rendered client-side via dangerouslySetInnerHTML (so the
// <strong> tags server templates add can render) - without this, a comment, caption,
// username, or pub name containing HTML/script would execute in the browser of
// whoever receives the notification.
function escapeHtml(value: any): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Strips the password hash before a user profile ever reaches a client response.
// Nothing client-side needs to read this back, and a hash still enables offline
// dictionary/brute-force attempts if leaked, so it should never leave the server.
function stripPassword<T extends { password?: any; recoveryCodeHash?: any }>(user: T): Omit<T, "password" | "recoveryCodeHash"> {
  const { password, recoveryCodeHash, ...rest } = user;
  return rest;
}

function stripPasswords<T extends { password?: any; recoveryCodeHash?: any }>(users: T[]): Omit<T, "password" | "recoveryCodeHash">[] {
  return users.map(stripPassword);
}

// Static uploads directory for images
const uploadsDir = path.join(process.cwd(), "public", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use("/uploads", express.static(uploadsDir));

let firebaseStorage: any = null;

function getStorageInstance(): any {
  if (firebaseStorage !== null) return firebaseStorage;
  try {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (config.projectId) {
        const firebaseApp = initializeApp(config);
        firebaseStorage = getStorage(firebaseApp);
        console.log("[Storage] Initialized Firebase Storage JS SDK successfully.");
      }
    }
  } catch (err) {
    console.error("[Storage] Failed to initialize Firebase Storage JS SDK:", err);
    firebaseStorage = null;
  }
  return firebaseStorage;
}

async function saveBase64ToStorage(base64Data: string): Promise<string> {
  if (!base64Data || typeof base64Data !== "string") return base64Data;
  if (!base64Data.startsWith("data:image/")) {
    return base64Data; // Already a URL or empty
  }
  const matches = base64Data.match(/^data:image\/([a-zA-Z0-9-+.]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) return base64Data;
  const ext = matches[1] === "jpeg" ? "jpg" : matches[1] || "jpg";
  const filename = `photos/photo-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${ext}`;

  // Prefer the Admin SDK: it writes with the server's privileged service-account
  // credentials and bypasses Firebase Storage Security Rules entirely, so uploads
  // can't be broken by a rules change the way the unauthenticated client SDK call
  // below can.
  //
  // Deliberately NOT using makePublic()/a public download URL here: that depends on
  // the bucket's object ACL settings, which throw outright on a bucket with Uniform
  // Bucket-Level Access (a common default) and can independently be blocked by the
  // same kind of Security Rules change that broke the client SDK write above. Instead
  // we serve the bytes back out ourselves via GET /api/image/:filename using these
  // same Admin SDK credentials, so viewing a photo never depends on the bucket or an
  // object being publicly readable at all.
  //
  // A couple of quick retries absorb the same class of transient credential/network
  // hiccup (e.g. a cold Cloud Run instance) that GET /api/image/:filename also retries
  // around, rather than treating one bad moment as a real failure.
  if (getAdminApps().length > 0) {
    const buffer = Buffer.from(matches[2], "base64");
    let lastAdminErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const bucket = getAdminStorage().bucket();
        const file = bucket.file(filename);
        await file.save(buffer, { metadata: { contentType: `image/${matches[1]}` } });
        const proxyUrl = `/api/image/${encodeURIComponent(filename.replace(/^photos\//, ""))}`;
        console.log(`[Storage] Uploaded base64 (${base64Data.length} chars) via Admin SDK, serving via ${proxyUrl}`);
        return proxyUrl;
      } catch (adminErr) {
        lastAdminErr = adminErr;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    console.warn("[Storage] Admin SDK upload failed after retries, trying client SDK:", lastAdminErr);
  }

  try {
    const storage = getStorageInstance();
    if (storage) {
      const storageRef = ref(storage, filename);
      await uploadString(storageRef, base64Data, "data_url");
      const downloadUrl = await getDownloadURL(storageRef);
      console.log(`[Storage] Uploaded base64 (${base64Data.length} chars) to Firebase Storage: ${downloadUrl}`);
      return downloadUrl;
    }
  } catch (err) {
    console.error("[Storage] Failed to upload image to Firebase Storage:", err);
  }

  // Deliberately NOT falling back to local disk here anymore: Cloud Run wipes it on
  // every redeploy/instance recycle, so a photo saved there "succeeds" immediately
  // and then silently vanishes later with no error anyone sees - exactly the
  // symptom this was built to stop. If durable storage genuinely isn't reachable
  // after retries, the check-in should still save (its other details matter more
  // than the photo), just without a photo, rather than promising one it can't keep.
  console.error("[Storage] All upload paths failed - saving this check-in without a photo rather than risking a photo that silently disappears later.");
  return "";
}

// Resolves an imageUrl/photoUrl value saved on a post or user profile back to the
// object path inside the Storage bucket, or null if it isn't a Storage-backed URL at
// all (a base64 data URL that never got uploaded, an empty value, or some other
// external URL). Handles both the current proxy format this app writes today
// (/api/image/<filename>, an object under photos/) and the legacy Firebase Storage
// download-URL format (https://firebasestorage.googleapis.com/.../o/<encoded-path>?...)
// written by the client-SDK fallback path and the old Google AI Studio app.
function storageObjectPathForImageUrl(imageUrl: string | undefined): string | null {
  if (!imageUrl || typeof imageUrl !== "string") return null;
  const proxyMatch = imageUrl.match(/^\/api\/image\/([^/?]+)/);
  if (proxyMatch) {
    return `photos/${decodeURIComponent(proxyMatch[1])}`;
  }
  const legacyMatch = imageUrl.match(/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/([^?]+)/);
  if (legacyMatch) {
    return decodeURIComponent(legacyMatch[1]);
  }
  return null;
}

// Deletes the Storage object backing a post/profile photo, if any. Best-effort only -
// a failure here (object already gone, transient credential hiccup, etc.) is logged
// and swallowed rather than thrown, since losing a few cents of orphaned Storage is
// far preferable to blocking someone from deleting their own post or account over it.
async function deleteStorageObjectForImageUrl(imageUrl: string | undefined): Promise<void> {
  const objectPath = storageObjectPathForImageUrl(imageUrl);
  if (!objectPath) return;
  if (getAdminApps().length === 0) return;
  try {
    await getAdminStorage().bucket().file(objectPath).delete({ ignoreNotFound: true });
    console.log(`[Storage] Deleted ${objectPath}`);
  } catch (err) {
    console.warn(`[Storage] Failed to delete ${objectPath} (leaving it orphaned):`, err);
  }
}

// Stream an image back out of Cloud Storage using the server's own privileged Admin
// SDK credentials, so viewing a photo never depends on the bucket/object being
// publicly readable, on Storage Security Rules, or on signed URLs - all of which
// have proven unreliable in this project. See saveBase64ToStorage() above.
app.get("/api/image/:filename", async (req, res) => {
  // Error responses are never cached - a transient hiccup here should never get
  // "remembered" as broken by a browser or CDN sitting in front of this route.
  const fail = (status: number) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(status).end();
  };

  if (getAdminApps().length === 0) {
    fail(503);
    return;
  }

  // Only allow simple filenames (no path traversal) under the fixed photos/ prefix.
  const safeName = path.basename(req.params.filename);
  const bucket = getAdminStorage().bucket();
  const file = bucket.file(`photos/${safeName}`);

  // A couple of quick retries absorbs the same class of transient credential/network
  // hiccup (e.g. a cold Cloud Run instance) that the client itself now retries around -
  // no reason to bounce a request back to the browser for something a 1-2s wait fixes.
  let exists = false;
  let metadata: any = null;
  let lastErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      [exists] = await file.exists();
      if (exists) {
        [metadata] = await file.getMetadata();
      }
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }

  if (lastErr) {
    console.error(`[Storage] Failed to serve image ${safeName} after retries:`, lastErr);
    fail(500);
    return;
  }
  if (!exists) {
    fail(404);
    return;
  }

  res.setHeader("Content-Type", metadata.contentType || "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  file.createReadStream()
    .on("error", (err) => {
      console.error(`[Storage] Failed to stream image ${safeName}:`, err);
      if (!res.headersSent) fail(500);
    })
    .pipe(res);
});

// TEMPORARY diagnostic endpoint - visit this URL directly in any browser to see exactly
// why photo uploads are failing, without needing Cloud Console log access. Safe to remove
// once uploads are confirmed working again. Does a real tiny write+read+delete against
// Storage via both the Admin SDK and the client SDK and reports the raw error from each.
app.get("/api/debug-storage", async (req, res) => {
  const report: any = {
    adminAppsInitialized: getAdminApps().length > 0,
    adminCredentialSource,
    configuredStorageBucket: null,
    adminSdk: { attempted: false, success: false, bucketName: null, error: null },
    clientSdk: { attempted: false, success: false, error: null }
  };

  try {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      report.configuredStorageBucket = config.storageBucket || null;
    }
  } catch (e) {}

  const testFilename = `debug/storage-test-${Date.now()}.txt`;
  const testContent = "beerreel storage diagnostic write";

  if (getAdminApps().length > 0) {
    report.adminSdk.attempted = true;
    try {
      const bucket = getAdminStorage().bucket();
      report.adminSdk.bucketName = bucket.name;
      const file = bucket.file(testFilename);
      await file.save(Buffer.from(testContent), { metadata: { contentType: "text/plain" } });
      const [contents] = await file.download();
      await file.delete().catch(() => {});
      report.adminSdk.success = contents.toString() === testContent;
    } catch (err: any) {
      report.adminSdk.error = { message: err?.message || String(err), code: err?.code || null };
    }
  }

  try {
    const storage = getStorageInstance();
    if (storage) {
      report.clientSdk.attempted = true;
      const storageRef = ref(storage, testFilename);
      await uploadString(storageRef, testContent);
      await getDownloadURL(storageRef);
      report.clientSdk.success = true;
    }
  } catch (err: any) {
    report.clientSdk.error = { message: err?.message || String(err), code: err?.code || null };
  }

  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(report, null, 2));
});

// Endpoint to upload base64 images and get back a short Storage download URL
app.post("/api/upload-image", async (req, res) => {
  try {
    const { image } = req.body;
    if (!image || typeof image !== "string") {
      res.status(400).json({ error: "Missing image string" });
      return;
    }
    const url = await saveBase64ToStorage(image);
    res.json({ url });
  } catch (err: any) {
    console.error("Error in /api/upload-image:", err);
    res.status(500).json({ error: "Failed to upload image" });
  }
});

// Turns a GPS coordinate into a rough place name for the "Use my location" button -
// proxied through the server (rather than called from the client) so the required
// identifying User-Agent and request pattern stay compliant with Nominatim's usage
// policy in one place, not scattered across every client. Free, no API key, no
// billing account - the tradeoff against a real Places lookup is a best-effort name
// (nearest venue/business if one is tagged at that spot, otherwise neighborhood/city),
// not a verified, precise venue picker.
app.get("/api/reverse-geocode", async (req, res) => {
  const lat = parseFloat((req.query.lat || "").toString());
  const lng = parseFloat((req.query.lng || "").toString());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: "Valid lat and lng query params are required." });
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=17&addressdetails=1`;
    const response = await fetch(url, {
      headers: { "User-Agent": "BeerReel/1.0 (beer check-in app; contact via app support)" },
      signal: controller.signal,
    });
    if (!response.ok) {
      res.json({ name: null });
      return;
    }
    const data: any = await response.json();
    const addr = data.address || {};
    // Prefer a specific venue (bar/pub/restaurant) if the coordinate lands on one,
    // otherwise fall back to a neighborhood/city-level description.
    const venue = addr.pub || addr.bar || addr.restaurant || addr.cafe || addr.amenity || data.name;
    const cityLike = addr.suburb || addr.neighbourhood || addr.city || addr.town || addr.village;
    res.json({ name: venue || cityLike || null });
  } catch (err) {
    console.warn("[Reverse Geocode] Failed:", err);
    res.json({ name: null });
  } finally {
    clearTimeout(timeoutId);
  }
});

// --- FIRESTORE PERSISTENCE ---
let db: any = null;
let useFirestore = false;

// Seed Initial User Profiles
const DEFAULT_USERS: UserProfile[] = [
  {
    username: "Quin",
    favoriteStyle: "IPA",
    joinedDate: "2026-06-01",
    avatar: "🍻",
    bio: "Love dry-hopped double IPAs. Drinking in moderation... usually.",
    password: "Pints!",
    email: "quin@beerreel.com"
  },
  {
    username: "Sam",
    favoriteStyle: "Stout",
    joinedDate: "2026-06-03",
    avatar: "☕",
    bio: "Stout season is all year round. The darker, the better.",
    password: "Pints!",
    email: "sam@beerreel.com"
  },
  {
    username: "Alex",
    favoriteStyle: "Sour",
    joinedDate: "2026-06-05",
    avatar: "🍋",
    bio: "Sour and wild fermentation enthusiast. Can't resist a good Gose.",
    password: "Pints!",
    email: "alex@beerreel.com"
  },
  {
    username: "Taylor",
    favoriteStyle: "Pilsner",
    joinedDate: "2026-06-10",
    avatar: "🍺",
    bio: "Keep it crispy. Dedicated lager and craft pilsner fan.",
    password: "Pints!",
    email: "taylor@beerreel.com"
  },
  {
    username: "Jordan",
    favoriteStyle: "Hazy IPA",
    joinedDate: "2026-06-15",
    avatar: "🍊",
    bio: "Juicy, tropical hazy IPAs are life. Citra & Mosaic hops please!",
    password: "Pints!",
    email: "jordan@beerreel.com"
  }
];

// Seed Initial Beer Logs
const DEFAULT_BEERS: BeerLog[] = [
  {
    id: "log-1",
    user: "Quin",
    beerName: "Space Dust IPA",
    beerStyle: "IPA",
    abv: 8.2,
    date: "2026-07-13T14:30:00.000Z",
    rating: 5,
    cheers: ["Sam", "Jordan"],
    comment: "An absolute classic. Heavy citrus and pine notes."
  },
  {
    id: "log-2",
    user: "Sam",
    beerName: "Bourbon County Stout",
    beerStyle: "Stout",
    abv: 14.7,
    date: "2026-07-12T19:45:00.000Z",
    rating: 5,
    cheers: ["Quin"],
    comment: "Incredibly rich, notes of vanilla, oak, and dark chocolate."
  },
  {
    id: "log-3",
    user: "Alex",
    beerName: "Aura Peach Sour",
    beerStyle: "Sour",
    abv: 5.0,
    date: "2026-07-11T21:15:00.000Z",
    rating: 4,
    cheers: ["Taylor", "Jordan"],
    comment: "Tart, refreshing, with real peach puree flavor!"
  },
  {
    id: "log-4",
    user: "Taylor",
    beerName: "Rothaus Pils",
    beerStyle: "Pilsner",
    abv: 5.1,
    date: "2026-07-10T18:00:00.000Z",
    rating: 5,
    cheers: ["Quin", "Sam"],
    comment: "The ultimate clean-crisp German pilsner."
  },
  {
    id: "log-5",
    user: "Jordan",
    beerName: "Heady Topper",
    beerStyle: "IPA",
    abv: 8.0,
    date: "2026-07-09T17:30:00.000Z",
    rating: 5,
    cheers: ["Quin", "Alex"],
    comment: "Double Hazy IPA perfection. Unfiltered and unbelievably juicy."
  },
  {
    id: "log-6",
    user: "Quin",
    beerName: "Guinness Draft",
    beerStyle: "Stout",
    abv: 4.2,
    date: "2026-07-08T22:00:00.000Z",
    rating: 4,
    cheers: ["Sam"],
    comment: "Always smooth. Perfect session drink."
  },
  {
    id: "log-7",
    user: "Alex",
    beerName: "Focal Banger",
    beerStyle: "IPA",
    abv: 7.0,
    date: "2026-07-07T16:00:00.000Z",
    rating: 4,
    cheers: ["Jordan", "Taylor"],
    comment: "Great piney hop profile, very drinkable."
  },
  {
    id: "log-8",
    user: "Sam",
    beerName: "Pliny the Elder",
    beerStyle: "IPA",
    abv: 8.0,
    date: "2026-07-05T19:00:00.000Z",
    rating: 5,
    cheers: ["Quin", "Taylor", "Alex"],
    comment: "The double IPA gold standard."
  },
  {
    id: "log-9",
    user: "Taylor",
    beerName: "Miller Lite",
    beerStyle: "Lager",
    abv: 4.2,
    date: "2026-07-03T20:30:00.000Z",
    rating: 3,
    cheers: [],
    comment: "Hey, it's a hot day, and we're mowing the lawn!"
  },
  {
    id: "log-10",
    user: "Jordan",
    beerName: "Juice Bomb",
    beerStyle: "Hazy IPA",
    abv: 6.5,
    date: "2026-06-28T18:00:00.000Z",
    rating: 4,
    cheers: ["Quin"],
    comment: "Super low bitterness, high tropical fruit notes."
  },
  {
    id: "log-11",
    user: "Quin",
    beerName: "Two Hearted Ale",
    beerStyle: "IPA",
    abv: 7.0,
    date: "2026-06-25T21:00:00.000Z",
    rating: 5,
    cheers: ["Sam", "Alex"],
    comment: "Best single IPA in America. Consistent and classic Centennials."
  },
  {
    id: "log-12",
    user: "Sam",
    beerName: "Milk Stout Nitro",
    beerStyle: "Stout",
    abv: 6.0,
    date: "2026-06-20T17:00:00.000Z",
    rating: 4,
    cheers: ["Taylor"],
    comment: "Creamy and sweet with lactose, super smooth."
  },
  {
    id: "log-13",
    user: "Alex",
    beerName: "Duchesse de Bourgogne",
    beerStyle: "Sour",
    abv: 6.2,
    date: "2026-06-18T19:30:00.000Z",
    rating: 5,
    cheers: ["Jordan"],
    comment: "Incredible Flanders Red Ale. Tastes like balsamic, cherries, and oak."
  },
  {
    id: "log-14",
    user: "Taylor",
    beerName: "Pilsner Urquell",
    beerStyle: "Pilsner",
    abv: 4.4,
    date: "2026-06-15T20:00:00.000Z",
    rating: 5,
    cheers: ["Quin", "Jordan"],
    comment: "The absolute original Pilsner. Soft bready malts and spicy Saaz hops."
  }
];

function handleFirestoreError(err: any, context: string) {
  const errMsg = err?.message || err?.toString() || "";
  const errCode = err?.code || "";
  const isQuotaOrUnavailable = 
    errCode === "resource-exhausted" || 
    errCode === "quota-exceeded" ||
    errCode === "unavailable" ||
    errCode === "permission-denied" ||
    errCode === "unauthenticated" ||
    errCode === "failed-precondition" ||
    errMsg.toLowerCase().includes("quota") ||
    errMsg.toLowerCase().includes("exhausted") ||
    errMsg.toLowerCase().includes("unavailable") ||
    errMsg.toLowerCase().includes("could not reach cloud firestore backend") ||
    errMsg.toLowerCase().includes("operation could not be completed") ||
    errMsg.toLowerCase().includes("offline");

  if (isQuotaOrUnavailable) {
    if (useFirestore) {
      console.warn(`[Firestore] Connection unavailable or quota reached during ${context}. Gracefully switching server to local JSON storage files.`);
      useFirestore = false;
    }
  } else {
    console.error(`[Firestore] Failed during ${context}:`, err);
  }
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs = 2500, fallbackName = "Firestore operation"): Promise<T | null> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[Firestore] ${fallbackName} timed out after ${timeoutMs}ms. Continuing with local data.`);
      resolve(null);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return result;
  } catch (err) {
    handleFirestoreError(err, fallbackName);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getFirestoreInstance(): any {
  if (db !== null) return db;

  try {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (config.projectId) {
        const app = initializeApp(config);
        db = getFirestore(app, config.firestoreDatabaseId || "(default)");
        useFirestore = true;
        console.log(`[Firestore] Initialized JS SDK with databaseId: ${config.firestoreDatabaseId}`);
      }
    }
  } catch (err) {
    console.error("[Firestore] Failed to initialize Firestore JS SDK, using JSON fallback:", err);
    db = null;
    useFirestore = false;
  }
  return db;
}

let fcmAvailable = false;
let fcmPermissionDenied = false;
let adminCredentialSource = "none";
try {
  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  const serviceAccountPath = path.join(process.cwd(), "serviceAccountKey.json");
  const altServiceAccountPath = path.join(process.cwd(), "service-account.json");
  
  let credentialToUse = null;
  
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    try {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
      credentialToUse = cert(sa);
      adminCredentialSource = "FIREBASE_SERVICE_ACCOUNT_KEY env var";
      console.log("[FCM Server] Using Firebase Admin Service Account credentials from environment variable.");
    } catch (e) {
      console.warn("[FCM Server] Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY env var:", e);
    }
  }

  if (!credentialToUse && fs.existsSync(serviceAccountPath)) {
    try {
      const sa = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
      credentialToUse = cert(sa);
      adminCredentialSource = "serviceAccountKey.json";
      console.log("[FCM Server] Using Firebase Admin Service Account credentials from serviceAccountKey.json");
    } catch (e) {
      console.warn("[FCM Server] Failed to read serviceAccountKey.json:", e);
    }
  }

  if (!credentialToUse && fs.existsSync(altServiceAccountPath)) {
    try {
      const sa = JSON.parse(fs.readFileSync(altServiceAccountPath, "utf8"));
      credentialToUse = cert(sa);
      adminCredentialSource = "service-account.json";
      console.log("[FCM Server] Using Firebase Admin Service Account credentials from service-account.json");
    } catch (e) {
      console.warn("[FCM Server] Failed to read service-account.json:", e);
    }
  }

  if (!credentialToUse) {
    credentialToUse = applicationDefault();
    adminCredentialSource = "Application Default Credentials (ADC)";
    console.log("[FCM Server] Using Application Default Credentials (ADC).");
  }

  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    initializeAdminApp({
      projectId: config.projectId,
      storageBucket: config.storageBucket,
      credential: credentialToUse
    });
    fcmAvailable = true;
    console.log("[FCM Server] Firebase Admin SDK initialized successfully.");
  }
} catch (err) {
  console.log("[FCM Server] Firebase Admin SDK running in simulation mode:", err);
}

// Track sent notification IDs to prevent duplicate FCM push dispatches
const pushedNotifIds = new Set<string>();

// Helper to clean up invalid/expired tokens
async function removeFcmToken(token: string) {
  try {
    const TOKENS_FILE = path.join(process.cwd(), "fcm_tokens.json");
    if (fs.existsSync(TOKENS_FILE)) {
      try {
        let localTokens: any[] = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
        localTokens = localTokens.filter((t) => t.token !== token);
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(localTokens, null, 2));
      } catch (e) {}
    }
    const firestore = getFirestoreInstance();
    if (firestore && useFirestore) {
      const docId = Buffer.from(token).toString("base64").substring(0, 50).replace(/[^a-zA-Z0-9]/g, "");
      await deleteDoc(doc(firestore, "fcm_tokens", docId));
    }
    console.log(`[FCM Server] Removed invalid/expired token: ${token.substring(0, 10)}...`);
  } catch (err) {
    console.warn("[FCM Server] Could not remove token:", err);
  }
}

// Get FCM tokens from Firestore or local JSON backup (case-insensitive username matching)
async function getFcmTokens(username: string | null): Promise<string[]> {
  const firestore = getFirestoreInstance();
  const tokenSet = new Set<string>();
  const targetLower = username ? username.toLowerCase().trim() : null;

  // 1. Fetch from Firestore if available
  if (firestore && useFirestore) {
    try {
      const coll = collection(firestore, "fcm_tokens");
      const snap = await getDocs(coll);
      snap.forEach((docSnap) => {
        const data = docSnap.data() as any;
        if (data && data.token) {
          const tokenUser = (data.user || data.userLower || "").toString().toLowerCase().trim();
          if (!targetLower || tokenUser === targetLower) {
            tokenSet.add(data.token);
          }
        }
      });
    } catch (err) {
      console.error("[FCM] Failed to fetch fcm tokens from Firestore:", err);
    }
  }

  // 2. Fallback / merge local file tokens
  const TOKENS_FILE = path.join(process.cwd(), "fcm_tokens.json");
  if (fs.existsSync(TOKENS_FILE)) {
    try {
      const localTokens: any[] = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
      localTokens.forEach((t: any) => {
        if (t && t.token) {
          const tokenUser = (t.user || "").toString().toLowerCase().trim();
          if (!targetLower || tokenUser === targetLower) {
            tokenSet.add(t.token);
          }
        }
      });
    } catch (e) {
      console.error("[FCM] Failed to read local tokens file:", e);
    }
  }

  return Array.from(tokenSet);
}

// Safe helper to attempt sending an FCM message
async function trySendFcmMessage(message: any): Promise<{ success: boolean; realFcmSent: boolean; error?: string }> {
  if (!fcmAvailable) {
    console.log(`[FCM Server] [SIMULATION MODE] Skipped real FCM API dispatch (FCM Admin SDK not authenticated or disabled). Target token: ${message.token?.substring(0, 10)}...`);
    return { success: false, realFcmSent: false, error: "FCM_UNAVAILABLE" };
  }
  try {
    const messageId = await getMessaging().send(message);
    console.log(`[FCM Server] [REAL FCM API SUCCESS] Delivered message ID: ${messageId} via Firebase Admin SDK to token: ${message.token?.substring(0, 10)}...`);
    return { success: true, realFcmSent: true };
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    if (
      errorMsg.includes("registration-token-not-registered") ||
      errorMsg.includes("invalid-argument") ||
      err?.code === "messaging/invalid-registration-token" ||
      err?.code === "messaging/registration-token-not-registered"
    ) {
      console.warn(`[FCM Server] Token expired or invalid. Pruning: ${message.token?.substring(0, 10)}...`);
      if (message.token) await removeFcmToken(message.token);
    } else if (
      errorMsg.includes("Permission") ||
      errorMsg.includes("permission-denied") ||
      err?.code === "messaging/permission-denied" ||
      err?.status === 403
    ) {
      console.log(`[FCM Server] Cloud Messaging API permission inactive on environment credential. Notifications handled via in-app toast & Web Push.`);
      fcmAvailable = false;
      fcmPermissionDenied = true;
    } else {
      console.error(`[FCM Server] [REAL FCM API ERROR] Failed to send FCM message to token ${message.token?.substring(0, 10)}...: ${errorMsg}`);
    }
    return { success: false, realFcmSent: false, error: errorMsg };
  }
}

// Send push notification helper
async function sendFCMNotification(targetUser: string | null, title: string, body: string, payload: any = {}) {
  console.log(`[FCM Server] Requesting push notification for ${targetUser || "ALL USERS"}: "${title} - ${body}"`);
  
  const tokens = await getFcmTokens(targetUser);
  if (tokens.length === 0) {
    console.log("[FCM Server] No registered device tokens found for target.");
    return { success: false, realFcmCount: 0, reason: "NO_TOKENS" };
  }

  console.log(`[FCM Server] Found ${tokens.length} registered device token(s). Processing dispatch...`);

  let realSentCount = 0;
  if (fcmAvailable) {
    for (const token of tokens) {
      const message = {
        token: token,
        // Data-only payload (no top-level/webpush "notification" block): the FCM Web SDK
        // auto-displays a notification whenever a message carries a "notification" payload,
        // and our service worker's onBackgroundMessage handler ALSO calls showNotification()
        // for every background message - together those caused every push to render twice.
        // Keeping this data-only means only our own SW handler shows it, exactly once.
        data: {
          click_action: "/",
          title: title,
          body: body,
          ...payload
        },
        webpush: {
          headers: {
            Urgency: "high",
            TTL: "86400"
          },
          fcm_options: {
            link: "/"
          }
        },
        apns: {
          headers: {
            "apns-priority": "10",
            "apns-push-type": "alert"
          },
          payload: {
            aps: {
              alert: {
                title: title,
                body: body
              },
              sound: "default"
            }
          }
        }
      };
      const res = await trySendFcmMessage(message);
      if (res.realFcmSent) realSentCount++;
      if (!fcmAvailable) break;
    }
    console.log(`[FCM Server] Completed FCM dispatch. Real API messages delivered: ${realSentCount}/${tokens.length}`);
    return { success: realSentCount > 0, realFcmCount: realSentCount };
  } else {
    console.log(`[FCM Server] [SIMULATION MODE] FCM API disabled/unauthenticated. Simulated push for ${tokens.length} token(s):`, tokens.map(t => `${t.substring(0, 10)}...`));
    return { success: false, realFcmCount: 0, reason: "SIMULATION_MODE" };
  }
}

// Handle trigger push for a notification (with deduplication)
async function sendFcmPushForNotification(notif: AppNotification) {
  if (!notif || !notif.id) return;
  if (pushedNotifIds.has(notif.id)) {
    console.log(`[FCM Server] Notification ${notif.id} was already dispatched. Skipping duplicate push.`);
    return;
  }
  pushedNotifIds.add(notif.id);
  if (pushedNotifIds.size > 1000) {
    const oldestKey = pushedNotifIds.values().next().value;
    if (oldestKey) pushedNotifIds.delete(oldestKey);
  }

  let targetUser: string | null = null;
  if (notif.targetUser) {
    targetUser = notif.targetUser;
  }

  // Never deliver targeted notification back to the sender
  if (targetUser && notif.user && targetUser.toLowerCase().trim() === notif.user.toLowerCase().trim()) {
    console.log(`[FCM Server] Notification ${notif.id} target is sender. Skipping dispatch.`);
    return;
  }

  const notifUser = notif.user;
  const title = notifUser ? `${notifUser} 🍻` : "🍻 Pint Alert";
  const cleanText = notif.text.replace(/<[^>]*>/g, "");
  const body = notifUser && !cleanText.toLowerCase().startsWith(notifUser.toLowerCase())
    ? `${notifUser} ${cleanText}`
    : cleanText;

  if (targetUser) {
    await sendFCMNotification(targetUser, title, body, { notificationId: notif.id, type: notif.type });
  } else {
    // Global notification (e.g. a friend logged a pint or went on a bender)
    const tokens = await getFcmTokens(null);
    const senderTokens = notif.user ? await getFcmTokens(notif.user) : [];
    const senderTokenSet = new Set(senderTokens);

    // Only deliver global notification to OTHER registered devices (never to the sender itself)
    const recipientTokens = tokens.filter(t => !senderTokenSet.has(t));

    if (recipientTokens.length > 0) {
      console.log(`[FCM Server] Sending global notification to ${recipientTokens.length} device(s) for user ${notif.user}.`);
      if (fcmAvailable) {
        let realSentCount = 0;
        for (const token of recipientTokens) {
          const message = {
            token: token,
            // Data-only payload - see comment in sendFCMNotification() above for why we don't
            // also set a webpush "notification" block (it caused every push to show twice).
            data: { click_action: "/", notificationId: notif.id, type: notif.type || "", title, body },
            webpush: {
              headers: {
                Urgency: "high",
                TTL: "86400"
              },
              fcm_options: {
                link: "/"
              }
            },
            apns: {
              headers: {
                "apns-priority": "10",
                "apns-push-type": "alert"
              },
              payload: {
                aps: {
                  alert: {
                    title: title,
                    body: body
                  },
                  sound: "default"
                }
              }
            }
          };
          const res = await trySendFcmMessage(message);
          if (res.realFcmSent) realSentCount++;
          if (!fcmAvailable) break;
        }
        console.log(`[FCM Server] Global notification FCM dispatch complete. Real API messages delivered: ${realSentCount}/${recipientTokens.length}`);
      } else {
        console.log(`[FCM Server] [SIMULATION MODE] FCM API disabled/unauthenticated. Skipped real push API for ${recipientTokens.length} devices.`);
      }
    } else {
      console.log("[FCM Server] No other registered device tokens available for global notification dispatch.");
    }
  }
}

// Helper to recursively strip out undefined values and enforce a 50KB field size safeguard
function sanitizeForFirestore<T extends Record<string, any>>(obj: T): Record<string, any> {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => (typeof item === "object" && item !== null ? sanitizeForFirestore(item) : item));
  }
  const clean: Record<string, any> = {};
  const MAX_FIELD_BYTES = 50 * 1024; // 50KB hard size limit per field

  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      if (value !== null && typeof value === "object" && !(value instanceof Date)) {
        clean[key] = sanitizeForFirestore(value);
      } else if (typeof value === "string") {
        let strVal = value;
        // Raw base64 shouldn't reach this point - it should already have gone through
        // saveBase64ToStorage() upstream. If it somehow slipped through anyway, strip it
        // rather than falling back to a synchronous local-disk write here: this function
        // isn't async so it can't retry through the real Admin SDK upload path, and a
        // "successful" local write is Cloud Run-ephemeral - it would look fine immediately
        // and silently vanish later, which is worse than just not having a photo.
        if ((key === "imageUrl" || key === "avatar") && strVal.startsWith("data:image/")) {
          console.warn(`[Firestore Safeguard] Raw base64 reached sanitizeForFirestore for "${key}" - this should have been uploaded already. Stripping instead of writing to ephemeral local disk.`);
          strVal = "";
        }
        // Enforce 50KB size safeguard
        if (strVal.length > MAX_FIELD_BYTES) {
          console.warn(`[Firestore Safeguard] Field "${key}" exceeds size safeguard (${strVal.length} chars > ${MAX_FIELD_BYTES}). Stripped raw data to protect Firestore.`);
          if (strVal.startsWith("data:")) {
            strVal = ""; // Strip raw base64 data completely if unsavable
          } else {
            strVal = strVal.substring(0, 1000); // Truncate text
          }
        }
        clean[key] = strVal;
      } else {
        clean[key] = value;
      }
    }
  }
  return clean;
}

// Seed default data to Firestore if empty
async function seedFirestoreIfEmpty() {
  const firestore = getFirestoreInstance();
  if (!firestore || !useFirestore) return;

  try {
    const usersColl = collection(firestore, "users");
    const usersSnap = await getDocs(query(usersColl, limit(1)));
    if (usersSnap.empty) {
      console.log("[Firestore] Seeding initial users...");
      for (const u of DEFAULT_USERS) {
        await setDoc(doc(firestore, "users", u.username.toLowerCase()), sanitizeForFirestore(u));
      }
    }

    const beersColl = collection(firestore, "beers");
    const beersSnap = await getDocs(query(beersColl, limit(1)));
    if (beersSnap.empty) {
      console.log("[Firestore] Seeding initial beers...");
      for (const b of DEFAULT_BEERS) {
        await setDoc(doc(firestore, "beers", b.id), sanitizeForFirestore(b));
      }
    }
  } catch (err) {
    handleFirestoreError(err, "seeding Firestore");
  }
}

// Helper to get all users
async function getAllUsers(): Promise<UserProfile[]> {
  const firestore = getFirestoreInstance();
  let list: UserProfile[] = [];
  if (firestore && useFirestore) {
    try {
      const snap = await getDocs(collection(firestore, "users"));
      snap.forEach((docSnap) => {
        list.push(docSnap.data() as UserProfile);
      });
    } catch (err) {
      handleFirestoreError(err, "get users");
    }
  }

  if (list.length === 0) {
    list = DEFAULT_USERS;
  }

  // Auto-set password to 'Pints!' for any user missing it, and grandfather
  // any pre-existing user (one with no `friends` field yet) into mutual
  // friendship with every other pre-existing user. Users created after this
  // migration ran get an explicit empty `friends` array at signup, so they're
  // never swept into this backfill - they have to add friends themselves.
  const legacyUsernames = list.filter((u) => u.friends === undefined).map((u) => u.username);

  let updatedUsersCount = 0;
  const migratedUsers = list.map((u) => {
    let next = u;
    let changed = false;
    if (!next.password) {
      next = { ...next, password: "Pints!" };
      changed = true;
    }
    if (next.friends === undefined) {
      next = {
        ...next,
        friends: legacyUsernames.filter((name) => name.toLowerCase() !== u.username.toLowerCase()),
      };
      changed = true;
    }
    if (changed) updatedUsersCount++;
    return next;
  });

  if (updatedUsersCount > 0 && firestore && useFirestore) {
    try {
      const batch = writeBatch(firestore);
      for (const u of migratedUsers) {
        batch.set(doc(firestore, "users", u.username.toLowerCase()), sanitizeForFirestore(u));
      }
      await batch.commit();
      console.log(`[Migration] Firestore updated with default passwords and grandfathered friends.`);
    } catch (err) {
      console.error("[Migration] Failed to batch-update Firestore with user migration:", err);
    }
  }

  return migratedUsers;
}

// Helper to save/update user
async function saveUser(profile: UserProfile): Promise<UserProfile> {
  const usernameKey = profile.username.toLowerCase();
  const firestore = getFirestoreInstance();
  if (firestore && useFirestore) {
    try {
      await setDoc(doc(firestore, "users", usernameKey), sanitizeForFirestore(profile));
    } catch (err) {
      handleFirestoreError(err, "save user");
    }
  }
  return profile;
}

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

function isValidTimeZone(timeZone: any): timeZone is string {
  if (!timeZone || typeof timeZone !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch (e) {
    return false;
  }
}

function getLocalHour(dateInput: Date | string | number, timeZone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false });
    const hourPart = formatter.formatToParts(new Date(dateInput)).find(p => p.type === 'hour')?.value;
    const hour = hourPart ? parseInt(hourPart, 10) : new Date(dateInput).getHours();
    return hour === 24 ? 0 : hour;
  } catch (e) {
    return new Date(dateInput).getHours();
  }
}

// "Golden Hour" time-of-day buckets - a fun personality label instead of a raw
// activity count. Ranges are in a 5am-29am (i.e. wraps past midnight) scale so
// the graveyard-shift hours (11pm-5am) group into one "Night Owl" bucket.
const GOLDEN_HOUR_BUCKETS: { start: number; end: number; label: string; emoji: string }[] = [
  { start: 5, end: 11, label: "Early Bird", emoji: "🌅" },
  { start: 11, end: 14, label: "Lunch Breaker", emoji: "🥪" },
  { start: 14, end: 17, label: "Afternoon Sipper", emoji: "☀️" },
  { start: 17, end: 20, label: "Happy Hour", emoji: "🍻" },
  { start: 20, end: 23, label: "Evening Regular", emoji: "🌆" },
  { start: 23, end: 29, label: "Night Owl", emoji: "🦉" },
];

function getGoldenHourBucket(hour: number): { label: string; emoji: string } {
  const normalizedHour = hour < 5 ? hour + 24 : hour;
  const bucket = GOLDEN_HOUR_BUCKETS.find((b) => normalizedHour >= b.start && normalizedHour < b.end);
  return bucket || GOLDEN_HOUR_BUCKETS[GOLDEN_HOUR_BUCKETS.length - 1];
}

// Recalculate and cache stats for a user
async function recalculateAndCacheUserStats(username: string): Promise<any> {
  const allBeersList = await getAllBeers();
  const userLogs = allBeersList.filter(
    (l) => l.user.toLowerCase() === username.toLowerCase() && !isImposterLog(l)
  );

  const totalPints = userLogs.length;

  const ratedLogs = userLogs.filter((l) => l.rating > 0);
  const avgRating = ratedLogs.length > 0
    ? (ratedLogs.reduce((acc, l) => acc + l.rating, 0) / ratedLogs.length).toFixed(1)
    : "0.0";

  const styleCounts: Record<string, number> = {};
  userLogs.forEach((l) => {
    const s = l.beerStyle || "Unknown";
    styleCounts[s] = (styleCounts[s] || 0) + 1;
  });
  let favoriteStyle = "None yet";
  let maxCount = 0;
  Object.entries(styleCounts).forEach(([style, count]) => {
    if (count > maxCount) {
      favoriteStyle = style;
      maxCount = count;
    }
  });

  const totalCheers = userLogs.reduce((acc, l) => acc + (l.cheers?.length || 0), 0);

  const allUsersList = await getAllUsers();
  const existingUser = allUsersList.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );

  // Each check-in carries the poster's own timezone (captured client-side at
  // log time), so date/hour bucketing below uses that per-log zone rather
  // than a single blanket one - correct even for someone who travels. Falls
  // back to a fixed default only for logs from before this was tracked.
  const DEFAULT_TIMEZONE = "America/Los_Angeles";
  const zoneFor = (l: BeerLog) => l.timezone || DEFAULT_TIMEZONE;
  const mostRecentLog = [...userLogs].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
  const currentZone = mostRecentLog ? zoneFor(mostRecentLog) : DEFAULT_TIMEZONE;

  // "The Usual" - your single most-repeated beer, a little personality fact
  // rather than a raw activity count.
  const beerNameCounts: Record<string, number> = {};
  userLogs.forEach((l) => {
    const name = (l.beerName || "").trim();
    if (!name) return;
    beerNameCounts[name] = (beerNameCounts[name] || 0) + 1;
  });
  let theUsualBeerName = "";
  let theUsualCount = 0;
  Object.entries(beerNameCounts).forEach(([name, count]) => {
    if (count > theUsualCount) {
      theUsualBeerName = name;
      theUsualCount = count;
    }
  });

  // "Golden Hour" - the time-of-day bucket they check in during most often.
  const goldenHourCounts: Record<string, number> = {};
  userLogs.forEach((l) => {
    const bucket = getGoldenHourBucket(getLocalHour(l.date, zoneFor(l)));
    goldenHourCounts[bucket.label] = (goldenHourCounts[bucket.label] || 0) + 1;
  });
  let goldenHourLabel = "TBD";
  let goldenHourEmoji = "🕐";
  let maxGoldenHourCount = 0;
  Object.entries(goldenHourCounts).forEach(([label, count]) => {
    if (count > maxGoldenHourCount) {
      maxGoldenHourCount = count;
      goldenHourLabel = label;
      goldenHourEmoji = GOLDEN_HOUR_BUCKETS.find((b) => b.label === label)?.emoji || "🕐";
    }
  });

  const firstPourCount = userLogs.filter((l) => l.isFirstOfDay).length;

  // Dry-streak calculations only - no "drinking streak" is tracked or surfaced,
  // since rewarding consecutive days of drinking is exactly the kind of pattern
  // that encourages excessive/habitual alcohol use.
  const loggedLocalDates = userLogs.map((l) => getLocalDateString(l.date, zoneFor(l)));
  const uniqueDates = Array.from(new Set(loggedLocalDates)).sort();

  let longestDryStreak = 0;
  let currentDryStreak = 0;

  if (uniqueDates.length > 0) {
    // 1. Today Status - "today" is judged from the zone of their most recent
    // check-in, our best guess at where they currently are.
    const todayStr = getLocalDateString(new Date(), currentZone);
    const hasLogToday = uniqueDates.includes(todayStr);

    // 2. Current Dry Streak (0 if they've already logged today)
    if (!hasLogToday) {
      let checkDate = new Date(todayStr + "T12:00:00");
      while (true) {
        const checkDateStr = getLocalDateString(checkDate, currentZone);
        if (!uniqueDates.includes(checkDateStr)) {
          currentDryStreak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
    }

    // 3. Longest Dry Streak
    if (uniqueDates.length > 1) {
      for (let i = 1; i < uniqueDates.length; i++) {
        const diff = getDayDifference(uniqueDates[i - 1], uniqueDates[i]);
        const dryDays = diff - 1;
        if (dryDays > longestDryStreak) {
          longestDryStreak = dryDays;
        }
      }
    }
    if (currentDryStreak > longestDryStreak) {
      longestDryStreak = currentDryStreak;
    }
  }

  const calculatedStats = {
    totalPints,
    avgRating,
    favoriteStyle,
    totalCheers,
    theUsualBeerName,
    theUsualCount,
    goldenHourLabel,
    goldenHourEmoji,
    firstPourCount,
    longestDryStreak,
    currentDryStreak
  };

  if (existingUser) {
    // Deliberately updateDoc, not saveUser()/setDoc: this function is often kicked
    // off as fire-and-forget background work (e.g. after a beer log delete) and can
    // still be running after the user account itself gets deleted moments later
    // (their last log deleted, then the account deleted right after). setDoc would
    // silently resurrect the just-deleted account with a fresh, zeroed-out profile;
    // updateDoc correctly no-ops (throws, caught below) if the document is gone.
    const firestore = getFirestoreInstance();
    if (firestore && useFirestore) {
      try {
        await updateDoc(doc(firestore, "users", username.toLowerCase()), { stats: calculatedStats });
      } catch (err) {
        console.log(`[Stats] Skipped stats update for ${username} - account no longer exists.`);
      }
    }
  }

  return calculatedStats;
}

// Helper to delete user
async function deleteUser(username: string): Promise<boolean> {
  const usernameKey = username.toLowerCase();
  const firestore = getFirestoreInstance();
  if (firestore && useFirestore) {
    try {
      // Strip the departing user from everyone else's friends/friendRequests/
      // blockedUsers lists first, so no other profile is left pointing at a
      // deleted account.
      const allUsers = await getAllUsers();
      const departingUser = allUsers.find((u) => u.username.toLowerCase() === usernameKey);
      // Without this check, deleting a username that doesn't actually match any
      // stored account (wrong case, a stale reference, a client-side truncated
      // value - e.g. the signup form's username input is capped at 15 characters,
      // so a caller passing a longer string here silently targets a document that
      // was never created) would still report success: deleteDoc() doesn't error
      // on a missing document, so every step below would appear to "work" while
      // touching nothing.
      if (!departingUser) {
        return false;
      }
      for (const other of allUsers) {
        if (other.username.toLowerCase() === usernameKey) continue;
        const hadFriend = (other.friends || []).some((f) => f.toLowerCase() === usernameKey);
        const hadRequest = (other.friendRequests || []).some((f) => f.toLowerCase() === usernameKey);
        const hadBlock = (other.blockedUsers || []).some((f) => f.toLowerCase() === usernameKey);
        if (hadFriend || hadRequest || hadBlock) {
          other.friends = (other.friends || []).filter((f) => f.toLowerCase() !== usernameKey);
          other.friendRequests = (other.friendRequests || []).filter((f) => f.toLowerCase() !== usernameKey);
          other.blockedUsers = (other.blockedUsers || []).filter((f) => f.toLowerCase() !== usernameKey);
          await saveUser(other);
        }
      }

      // Delete user
      await deleteDoc(doc(firestore, "users", usernameKey));

      // Delete user's beers from Firestore
      const beersColl = collection(firestore, "beers");
      const q = query(beersColl, where("user", "==", username));
      const snap = await getDocs(q);
      const batch = writeBatch(firestore);
      const orphanedImageUrls: string[] = [];
      snap.forEach((docSnap) => {
        batch.delete(docSnap.ref);
        const beerData = docSnap.data() as BeerLog;
        if (beerData.imageUrl) orphanedImageUrls.push(beerData.imageUrl);
      });
      await batch.commit();

      // Best-effort Storage cleanup for the profile photo and every deleted post's
      // photo - fired after the Firestore deletes succeed, never blocking or failing
      // the account deletion itself if a Storage object is already gone or briefly
      // unreachable.
      if (departingUser?.photoUrl) orphanedImageUrls.push(departingUser.photoUrl);
      Promise.all(orphanedImageUrls.map((url) => deleteStorageObjectForImageUrl(url))).catch((e) =>
        console.warn("Error cleaning up Storage objects after user delete:", e)
      );

      return true;
    } catch (err) {
      handleFirestoreError(err, "delete user");
      return false;
    }
  }
  return false;
}

// In-memory store for fast instant response and local fallback
let inMemoryBeers: BeerLog[] = [];

// Helper to get all beers
async function getAllBeers(): Promise<BeerLog[]> {
  const firestore = getFirestoreInstance();
  let list: BeerLog[] = [];
  
  if (firestore && useFirestore) {
    try {
      // This is the single source of truth every other beer-related feature
      // reads from (the feed, per-user stats, leaderboards, Pub Awards...),
      // so capping it silently truncates "all time" everywhere at once once
      // the community logs more pints than the limit - not just the visible
      // feed. 5000 gives a lot of headroom over today's real count (~250)
      // while still bounding the read/sort cost of every request.
      const beersColl = collection(firestore, "beers");
      const q = query(beersColl, orderBy("date", "desc"), limit(5000));
      const snap = await getDocs(q);
      snap.forEach((docSnap) => {
        list.push(docSnap.data() as BeerLog);
      });
    } catch (err) {
      handleFirestoreError(err, "get beers");
    }
  }

  // Merge list with inMemoryBeers
  const seenIds = new Set<string>();
  const merged: BeerLog[] = [];

  list.forEach((b) => {
    if (b && b.id && !seenIds.has(b.id)) {
      seenIds.add(b.id);
      merged.push(b);
    }
  });

  inMemoryBeers.forEach((b) => {
    if (b && b.id && !seenIds.has(b.id)) {
      seenIds.add(b.id);
      merged.push(b);
    }
  });

  if (merged.length === 0) {
    merged.push(...DEFAULT_BEERS);
  }

  // Sort beers in descending date order
  merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Auto-correct & normalize beer names
  let updatedCount = 0;
  const cleanedList = merged.map((b) => {
    if (!b.beerName) return b;
    const normalized = normalizeBeerName(b.beerName);
    const newName = normalized.name || b.beerName;

    if (newName !== b.beerName) {
      updatedCount++;
      const updatedLog = { ...b, beerName: newName };
      if (normalized.style && (!b.beerStyle || b.beerStyle === "Other")) {
        updatedLog.beerStyle = normalized.style;
      }
      if (normalized.abv && (!b.abv || b.abv === 5.0)) {
        updatedLog.abv = normalized.abv;
      }
      return updatedLog;
    }
    return b;
  });

  inMemoryBeers = cleanedList;

  if (updatedCount > 0 && firestore && useFirestore) {
    try {
      const batch = writeBatch(firestore);
      for (const log of cleanedList) {
        batch.set(doc(firestore, "beers", log.id), sanitizeForFirestore(log));
      }
      await batch.commit();
      console.log(`[Migration] Firestore updated with normalized beer log names.`);
    } catch (err) {
      console.error("[Migration] Failed to batch-update Firestore with corrected names:", err);
    }
  }

  return cleanedList;
}

// Helper to save beer log
async function saveBeerLog(log: BeerLog): Promise<BeerLog> {
  // Always update inMemoryBeers immediately
  const existingIdx = inMemoryBeers.findIndex((b) => b.id === log.id);
  if (existingIdx !== -1) {
    inMemoryBeers[existingIdx] = log;
  } else {
    inMemoryBeers.unshift(log);
  }

  const firestore = getFirestoreInstance();
  if (firestore && useFirestore) {
    try {
      await setDoc(doc(firestore, "beers", log.id), sanitizeForFirestore(log));
    } catch (err) {
      handleFirestoreError(err, "save beer log");
    }
  }
  return log;
}

// Helper to save notification
function isUserCustomBeerName(name: string | undefined | null): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.length === 0) return false;
  if (lower === "unnamed pint" || lower === "unnamed pint 🍺" || lower === "unnamed" || lower === "beer") return false;
  return true;
}

function isGuinnessBeerName(name: string | undefined | null): boolean {
  if (!name) return false;
  return name.trim().toLowerCase().includes("guinness");
}

function generateCreativeBeerNotificationText(beerName: string, abv: number, dateStr: string, todayCount: number): string {
  const isGuinness = isGuinnessBeerName(beerName);

  // Get hour from ISO date string
  let hour = 17; // default
  try {
    const dt = new Date(dateStr);
    hour = dt.getHours();
  } catch (e) {
    // fallback
  }

  // SPECIAL GUINNESS NOTIFICATION
  if (isGuinness) {
    const guinnessOptions = [
      `is pouring a majestic black pint of Guinness! 🖤🇮🇪🍺 Sláinte!`,
      `is settling a smooth, creamy pint of Guinness! 🇮🇪🍺 Good things come to those who wait!`,
      `just poured the dark stuff: a lovely pint of Guinness! 🖤🍻 Sláinte!`,
      `is enjoying a perfectly settled velvet pint of Guinness! 🖤🍺 Sláinte!`
    ];
    return guinnessOptions[Math.floor(Math.random() * guinnessOptions.length)];
  }

  // 1st of the day!
  if (todayCount === 1) {
    const options = [
      `is kickstarting their day with a cold <strong>1st pint</strong>! 🌅🍺`,
      `is opening the floodgates with their <strong>first pint of the day</strong>! 🔓🍻`,
      `is wetting their whistle with the debut pint of the day! 🎨🍺`,
      `is officially in play with their <strong>1st pint</strong>! 🚩🍻`
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  // Early morning (before 11 AM)
  if (hour < 11) {
    const options = [
      `is starting shockingly early with a morning pint! 🌅👀`,
      `believes it's five o'clock somewhere! Breakfast pint! 🍳🍺`,
      `is beating the sun with an early doors pint! 🐓🍻`
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  // High ABV (>= 8%)
  if (abv >= 8) {
    const options = [
      `is playing with fire! Sinking a heavy pint (${abv}% ABV)! 🔥🥴`,
      `is tackling an absolute unit of a pint at ${abv}% ABV! 🥊🍺`,
      `is cruising in the fast lane with a strong pint (${abv}%)! 🚀🍻`
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  // Low ABV (<= 0.5% and > 0)
  if (abv <= 0.5 && abv > 0) {
    const options = [
      `is staying responsible with a sober-safe pint (${abv}% ABV)! 😇🌱`,
      `is pacing themselves with a clear-headed pint (${abv}%)! 🧠🍻`
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  // Lunch pint (between 12 PM and 2 PM, i.e. 12 and 13)
  if (hour >= 12 && hour < 14) {
    const options = [
      `is enjoying a sneaky lunch pint! Shhh... 🤫🍔🍺`,
      `is taking a very productive 'working lunch' with a cold pint! 💼🍻`,
      `is supplementing their diet with a liquid lunch! 🥗🍺`
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  // Late Night (after 11 PM or before 4 AM)
  if (hour >= 23 || hour < 4) {
    const options = [
      `is howling at the moon with a late-night pint! 🌕🐺`,
      `is refusing to let the night end! Sinking a midnight pint! 🦉🍻`,
      `is burning the midnight oil with a dark-hours pint! 🕯️🍺`
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  // Standard but creative notifications for general logs
  const generalOptions = [
    `is sinking a crisp pint! 🍺`,
    `is wetting their whistle with a lovely pint! 🍻`,
    `just poured a cold one! Down the hatch! ✨🍺`,
    `is absolutely demolishing a cold pint! 🦖🍻`,
    `is taking a big pull! Down the hatch! 🌊🍺`,
    `is treating themselves to a well-earned pint! 🎯🍻`,
    `is enjoying the nectar of the gods! 🍯🍺`,
    `is keeping the good times rolling with a cold pint! 🔄🍻`,
    `is having some quality pub chat over a cold pint! 🗣️🍺`,
    `is sinking a majestic pint! 🏰🍺`
  ];
  return generalOptions[Math.floor(Math.random() * generalOptions.length)];
}

async function saveNotification(notif: AppNotification): Promise<AppNotification> {
  const firestore = getFirestoreInstance();
  if (firestore && useFirestore) {
    try {
      await setDoc(doc(firestore, "notifications", notif.id), sanitizeForFirestore(notif));
    } catch (err) {
      handleFirestoreError(err, "save notification");
    }
  }

  // Always dispatch FCM push notification asynchronously in background
  sendFcmPushForNotification(notif).catch((pushErr) => {
    console.error("[FCM Server] Error sending push notification:", pushErr);
  });

  return notif;
}

interface CreateNotificationOptions {
  user: string;
  text: string;
  targetUser?: string;
  type?: "post" | "comment" | "cheer" | "reaction" | "bender" | "first_pour" | "invite" | "tag" | "imposter" | "beacon" | "chat" | "friend_request" | "friend_accept";
  date?: string;
  idPrefix?: string;
}

async function createAndDispatchNotification(options: CreateNotificationOptions): Promise<AppNotification | null> {
  try {
    const prefix = options.idPrefix || "notif";
    const notifId = `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const notif: AppNotification = {
      id: notifId,
      user: options.user,
      text: options.text,
      date: options.date || new Date().toISOString(),
      readBy: [],
      ...(options.targetUser ? { targetUser: options.targetUser } : {}),
      ...(options.type ? { type: options.type } : {}),
    };

    return await saveNotification(notif);
  } catch (err) {
    console.error("Failed to create and dispatch notification:", err);
    return null;
  }
}

// Fans a "community activity" notification (first pour of the day, imposter pint
// outed, etc.) out to friends only, one targeted record per friend - these used to
// be dispatched as a single untargeted record, which both the client's bell filter
// and the FCM push path treat as "show/buzz literally everyone," friend or total
// stranger alike. Whose friends to notify defaults to options.user (the person the
// activity is about), but can be overridden - e.g. an imposter-outed notification is
// about the outed poster, not whoever's reaction happened to tip the vote count.
async function notifyFriendsOfActivity(
  options: Omit<CreateNotificationOptions, "targetUser">,
  friendsOf: string = options.user
): Promise<void> {
  const allUsers = await getAllUsers();
  const lookupLower = friendsOf.toLowerCase().trim();
  const subject = allUsers.find((u) => u.username.toLowerCase() === lookupLower);
  const friends = subject?.friends || [];
  for (const friend of friends) {
    await createAndDispatchNotification({ ...options, targetUser: friend });
  }
}

// Helper to get all pubs
async function getAllPubs(): Promise<Pub[]> {
  const firestore = getFirestoreInstance();
  let list: Pub[] = [];
  if (firestore && useFirestore) {
    try {
      const snap = await getDocs(collection(firestore, "pubs"));
      snap.forEach((docSnap) => {
        list.push(docSnap.data() as Pub);
      });
    } catch (err) {
      handleFirestoreError(err, "get pubs");
    }
  }
  return list;
}

// Helper to save/update pub
async function savePub(pub: Pub): Promise<Pub> {
  const firestore = getFirestoreInstance();
  if (firestore && useFirestore) {
    try {
      await setDoc(doc(firestore, "pubs", pub.id), sanitizeForFirestore(pub));
    } catch (err) {
      handleFirestoreError(err, "save pub");
    }
  }
  return pub;
}

// Helper to delete a pub
async function deletePub(pubId: string): Promise<boolean> {
  const firestore = getFirestoreInstance();
  if (firestore && useFirestore) {
    try {
      await deleteDoc(doc(firestore, "pubs", pubId));
      return true;
    } catch (err) {
      handleFirestoreError(err, "delete pub");
      return false;
    }
  }
  return false;
}

// Helper to get pub chat messages
async function getPubMessages(pubId: string): Promise<PubChatMessage[]> {
  const firestore = getFirestoreInstance();
  const list: PubChatMessage[] = [];
  if (firestore && useFirestore) {
    try {
      const snap = await getDocs(collection(firestore, "pub_messages"));
      snap.forEach((docSnap) => {
        const msg = docSnap.data() as PubChatMessage;
        if (msg.pubId === pubId) {
          list.push(msg);
        }
      });
    } catch (err) {
      console.error("Firestore error reading pub_messages:", err);
    }
  }
  return list.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

// Helper to save pub chat message
async function savePubChatMessage(msg: PubChatMessage): Promise<PubChatMessage> {
  const firestore = getFirestoreInstance();
  if (firestore && useFirestore) {
    try {
      await setDoc(doc(firestore, "pub_messages", msg.id), sanitizeForFirestore(msg));
    } catch (err) {
      console.error("Firestore error saving pub_message:", err);
    }
  }
  return msg;
}

// Helper to get all content reports (newest first)
async function getAllReports(): Promise<ContentReport[]> {
  const firestore = getFirestoreInstance();
  const list: ContentReport[] = [];
  if (firestore && useFirestore) {
    try {
      const snap = await getDocs(collection(firestore, "reports"));
      snap.forEach((docSnap) => {
        list.push(docSnap.data() as ContentReport);
      });
    } catch (err) {
      console.error("Firestore error reading reports:", err);
    }
  }
  return list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

// Helper to save a content report
async function saveReport(report: ContentReport): Promise<ContentReport> {
  const firestore = getFirestoreInstance();
  if (firestore && useFirestore) {
    try {
      await setDoc(doc(firestore, "reports", report.id), sanitizeForFirestore(report));
    } catch (err) {
      console.error("Firestore error saving report:", err);
    }
  }
  return report;
}

// Helper to get notifications
async function getAllNotifications(): Promise<AppNotification[]> {
  const firestore = getFirestoreInstance();
  let list: AppNotification[] = [];
  if (firestore && useFirestore) {
    try {
      const coll = collection(firestore, "notifications");
      const q = query(coll, orderBy("date", "desc"), limit(100));
      const snap = await getDocs(q);
      snap.forEach((docSnap) => {
        list.push(docSnap.data() as AppNotification);
      });
    } catch (err) {
      handleFirestoreError(err, "get notifications");
    }
  }
  return list;
}

// Helper to mark notifications as read for a specific user
async function markNotificationsRead(username: string): Promise<boolean> {
  const userLower = username.toLowerCase().trim();
  const firestore = getFirestoreInstance();
  if (firestore && useFirestore) {
    try {
      const allNotifs = await getAllNotifications();
      const batch = writeBatch(firestore);
      let count = 0;
      for (const n of allNotifs) {
        const readSet = new Set((n.readBy || []).map(r => r.toLowerCase().trim()));
        if (!readSet.has(userLower)) {
          const newReadBy = [...(n.readBy || []), userLower];
          batch.update(doc(firestore, "notifications", n.id), {
            readBy: newReadBy
          });
          count++;
        }
      }
      if (count > 0) {
        await batch.commit();
        console.log(`[Firestore] Marked ${count} notifications as read for ${username}.`);
      }
    } catch (err) {
      handleFirestoreError(err, "batch-update notifications readBy");
    }
  }
  return true;
}

// Helper to find a beer log by ID
async function findBeerLogById(id: string): Promise<BeerLog | null> {
  if (!id) return null;
  const inMem = inMemoryBeers.find((b) => b.id === id);
  if (inMem) return inMem;

  const firestore = getFirestoreInstance();
  if (firestore && useFirestore) {
    try {
      const docSnap = await getDoc(doc(firestore, "beers", id));
      if (docSnap.exists()) {
        const log = docSnap.data() as BeerLog;
        inMemoryBeers.unshift(log);
        return log;
      }
    } catch (err) {
      handleFirestoreError(err, "findBeerLogById");
    }
  }
  return null;
}

// Per-log mutex lock to prevent concurrent HTTP request race conditions
const logLocks = new Map<string, Promise<any>>();

function withLogLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const currentLock = logLocks.get(id) || Promise.resolve();
  const nextLock = currentLock.then(fn, fn);
  logLocks.set(id, nextLock);
  return nextLock;
}

// Helper to update/toggle cheers on a beer log
async function toggleBeerCheers(id: string, username: string): Promise<BeerLog | null> {
  return toggleBeerReaction(id, username, "cheers");
}

// Helper to update/toggle any reaction on a beer log
async function toggleBeerReaction(id: string, username: string, reactionType: string): Promise<BeerLog | null> {
  return withLogLock(id, async () => {
    const firestore = getFirestoreInstance();
    let updatedLog: BeerLog | null = null;

    if (firestore && useFirestore) {
      try {
        updatedLog = await runTransaction(firestore, async (transaction) => {
          const beerRef = doc(firestore, "beers", id);
          const snap = await transaction.get(beerRef);
          if (!snap.exists()) {
            return null;
          }
          const log = snap.data() as BeerLog;

          if (!log.cheers || !Array.isArray(log.cheers)) {
            log.cheers = [];
          }
          if (!log.reactions || typeof log.reactions !== "object" || Array.isArray(log.reactions)) {
            log.reactions = {};
          }

          if (reactionType === "cheers") {
            const cheerIndex = log.cheers.indexOf(username);
            if (cheerIndex === -1) {
              log.cheers.push(username);
            } else {
              log.cheers.splice(cheerIndex, 1);
            }
          }

          if (!log.reactions[reactionType] || !Array.isArray(log.reactions[reactionType])) {
            log.reactions[reactionType] = [];
          }

          const userIndex = log.reactions[reactionType].indexOf(username);
          if (userIndex === -1) {
            log.reactions[reactionType].push(username);
          } else {
            log.reactions[reactionType].splice(userIndex, 1);
          }

          if (reactionType === "cheers") {
            log.reactions["cheers"] = [...log.cheers];
          }

          transaction.set(beerRef, log);
          return log;
        });
      } catch (err) {
        handleFirestoreError(err, "toggle reaction transaction");
      }
    }

    if (!updatedLog) {
      // Local in-memory fallback
      const log = inMemoryBeers.find((b) => b.id === id);
      if (log) {
        if (!log.cheers || !Array.isArray(log.cheers)) log.cheers = [];
        if (!log.reactions || typeof log.reactions !== "object" || Array.isArray(log.reactions)) log.reactions = {};

        if (reactionType === "cheers") {
          const cheerIndex = log.cheers.indexOf(username);
          if (cheerIndex === -1) log.cheers.push(username);
          else log.cheers.splice(cheerIndex, 1);
        }

        if (!log.reactions[reactionType] || !Array.isArray(log.reactions[reactionType])) {
          log.reactions[reactionType] = [];
        }

        const userIndex = log.reactions[reactionType].indexOf(username);
        if (userIndex === -1) log.reactions[reactionType].push(username);
        else log.reactions[reactionType].splice(userIndex, 1);

        if (reactionType === "cheers") log.reactions["cheers"] = [...log.cheers];

        await saveBeerLog(log);
        updatedLog = log;
      }
    } else {
      // Sync transaction result to inMemoryBeers
      const idx = inMemoryBeers.findIndex((b) => b.id === id);
      if (idx !== -1) inMemoryBeers[idx] = updatedLog;
      else inMemoryBeers.unshift(updatedLog);
    }

    return updatedLog;
  });
}

// Helper to delete a beer log
async function deleteBeerLog(id: string): Promise<boolean> {
  inMemoryBeers = inMemoryBeers.filter((b) => b.id !== id);
  const firestore = getFirestoreInstance();
  if (firestore && useFirestore) {
    try {
      await deleteDoc(doc(firestore, "beers", id));
      return true;
    } catch (err) {
      handleFirestoreError(err, "delete beer log");
      return false;
    }
  }
  return true;
}

// Helper to add a comment to a beer log
async function addBeerComment(id: string, user: string, text: string): Promise<BeerLog | null> {
  const log = await findBeerLogById(id);
  if (!log) {
    return null;
  }

  if (!log.comments) {
    log.comments = [];
  }

  const newComment = {
    id: `comment-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    user,
    text,
    date: new Date().toISOString()
  };

  log.comments.push(newComment);

  const firestore = getFirestoreInstance();
  if (firestore && useFirestore) {
    try {
      await setDoc(doc(firestore, "beers", id), sanitizeForFirestore(log));
    } catch (err) {
      handleFirestoreError(err, "save comment");
    }
  }
  return log;
}

// Helper to delete a comment from a beer log
async function deleteBeerComment(id: string, commentId: string): Promise<BeerLog | null> {
  const log = await findBeerLogById(id);
  if (!log) {
    return null;
  }

  if (!log.comments) {
    return log;
  }

  log.comments = log.comments.filter((c) => c.id !== commentId);

  const firestore = getFirestoreInstance();
  if (firestore && useFirestore) {
    try {
      await setDoc(doc(firestore, "beers", id), sanitizeForFirestore(log));
    } catch (err) {
      handleFirestoreError(err, "delete comment");
    }
  }
  return log;
}

// Helper to toggle a reaction on a comment
async function toggleCommentReaction(
  id: string,
  commentId: string,
  user: string,
  reaction: string
): Promise<BeerLog | null> {
  const log = await findBeerLogById(id);
  if (!log || !log.comments) {
    return null;
  }

  const commentIndex = log.comments.findIndex((c) => c.id === commentId);
  if (commentIndex === -1) {
    return null;
  }

  const comment = { ...log.comments[commentIndex] };
  if (!comment.reactions || typeof comment.reactions !== "object" || Array.isArray(comment.reactions)) {
    comment.reactions = {};
  } else {
    comment.reactions = { ...comment.reactions };
  }

  if (!comment.reactions[reaction] || !Array.isArray(comment.reactions[reaction])) {
    comment.reactions[reaction] = [];
  } else {
    comment.reactions[reaction] = [...comment.reactions[reaction]];
  }

  const userIdx = comment.reactions[reaction].indexOf(user);
  if (userIdx !== -1) {
    comment.reactions[reaction].splice(userIdx, 1);
  } else {
    comment.reactions[reaction].push(user);
  }

  if (comment.reactions[reaction].length === 0) {
    delete comment.reactions[reaction];
  }

  log.comments[commentIndex] = comment;

  const firestore = getFirestoreInstance();
  if (firestore && useFirestore) {
    try {
      await setDoc(doc(firestore, "beers", id), sanitizeForFirestore(log));
    } catch (err) {
      handleFirestoreError(err, "toggle comment reaction");
    }
  }
  return log;
}

function isSeymoreBeers(username: any): boolean {
  if (!username || typeof username !== "string") return false;
  const normalized = username.toLowerCase().trim().replace(/\s+/g, "");
  return normalized === "seymorebeers" || normalized === "seymorebeerz" || normalized === "seymore";
}

function findTags(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/@([a-zA-Z0-9_-]+)/g);
  if (!matches) return [];
  const usernames = matches.map(m => m.substring(1));
  return Array.from(new Set(usernames));
}

async function getValidTags(text: string): Promise<string[]> {
  const tags = findTags(text);
  if (tags.length === 0) return [];
  try {
    const allUsers = await getAllUsers();
    const existingUsernames = new Set(allUsers.map(u => u.username.toLowerCase().trim()));
    return tags.filter(t => existingUsernames.has(t.toLowerCase().trim())).map(t => {
      const match = allUsers.find(u => u.username.toLowerCase().trim() === t.toLowerCase().trim());
      return match ? match.username : t;
    });
  } catch (err) {
    console.error("Error checking valid tags:", err);
    return tags;
  }
}

// --- API ROUTES ---

// GET Firestore Debug Info
app.get("/api/firestore-debug", async (req, res) => {
  const firestore = getFirestoreInstance();
  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  const configExists = fs.existsSync(configPath);
  let configContent: any = null;
  if (configExists) {
    try {
      configContent = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (e: any) {
      configContent = { error: e.message };
    }
  }

  let testResult: any = null;
  if (firestore) {
    try {
      const snap = await getDocs(query(collection(firestore, "users"), limit(1)));
      testResult = { success: true, empty: snap.empty, size: snap.size };
    } catch (e: any) {
      testResult = {
        success: false,
        message: e.message,
        code: e.code,
        details: e.details,
        stack: e.stack
      };
    }
  } else {
    testResult = { success: false, message: "Firestore instance is null" };
  }

  res.json({
    useFirestore,
    configExists,
    configContent: configContent ? { projectId: configContent.projectId, databaseId: configContent.firestoreDatabaseId } : null,
    testResult
  });
});

// POST Firestore Reconnect / Retry
app.post("/api/firestore-reconnect", async (req, res) => {
  console.log("[Firestore] Reconnection requested by client.");
  const firestore = getFirestoreInstance();
  if (!firestore) {
    res.status(500).json({ success: false, message: "Firestore instance could not be initialized." });
    return;
  }

  // Set useFirestore back to true and test the connection
  useFirestore = true;
  try {
    const snap = await getDocs(query(collection(firestore, "users"), limit(1)));
    console.log("[Firestore] Reconnection successful! Found users:", snap.size);
    // Call seed if empty just in case
    await seedFirestoreIfEmpty();
    res.json({ success: true, message: "Firestore connection restored successfully!", useFirestore: true });
  } catch (e: any) {
    const errMsg = e?.message || e?.toString() || "";
    const isQuota = 
      e?.code === "resource-exhausted" || 
      e?.code === "quota-exceeded" ||
      errMsg.toLowerCase().includes("quota") ||
      errMsg.toLowerCase().includes("exhausted");
    
    if (isQuota) {
      console.warn("[Firestore] Reconnection test failed due to quota limit:", errMsg);
      useFirestore = false;
      res.status(429).json({
        success: false,
        message: "Firestore connection failed. Project is still reporting quota exhaustion: " + errMsg,
        useFirestore: false
      });
    } else {
      console.error("[Firestore] Reconnection test failed:", e);
      res.status(500).json({
        success: false,
        message: "Firestore connection failed: " + errMsg,
        useFirestore: false
      });
    }
  }
});

// Helper function to push local JSON files back up to Firestore
async function pushLocalToFirestore(): Promise<{ usersCount: number; beersCount: number; pubsCount: number; notificationsCount: number }> {
  const firestore = getFirestoreInstance();
  if (!firestore) throw new Error("Firestore not initialized");

  const usersSnap = await getDocs(collection(firestore, "users"));
  const beersSnap = await getDocs(collection(firestore, "beers"));
  const pubsSnap = await getDocs(collection(firestore, "pubs"));
  const notifsSnap = await getDocs(collection(firestore, "notifications"));

  if (usersSnap.empty) {
    const batch = writeBatch(firestore);
    for (const u of DEFAULT_USERS) {
      batch.set(doc(firestore, "users", u.username.toLowerCase()), sanitizeForFirestore(u));
    }
    await batch.commit();
  }

  if (beersSnap.empty) {
    const batch = writeBatch(firestore);
    for (const b of DEFAULT_BEERS) {
      batch.set(doc(firestore, "beers", b.id), sanitizeForFirestore(b));
    }
    await batch.commit();
  }

  return {
    usersCount: usersSnap.size || DEFAULT_USERS.length,
    beersCount: beersSnap.size || DEFAULT_BEERS.length,
    pubsCount: pubsSnap.size,
    notificationsCount: notifsSnap.size
  };
}

// POST Sync Local Offline Data to Cloud Firestore
app.post("/api/firestore-sync-local-to-cloud", async (req, res) => {
  console.log("[Sync] Request to push local offline backup data to Firestore.");
  const firestore = getFirestoreInstance();
  if (!firestore) {
    res.status(500).json({ success: false, message: "Firestore instance could not be initialized." });
    return;
  }

  try {
    useFirestore = true;
    await getDocs(query(collection(firestore, "users"), limit(1)));
    const counts = await pushLocalToFirestore();
    
    res.json({
      success: true,
      message: `Firestore is active as single source of truth. ${counts.usersCount} users, ${counts.beersCount} logs, ${counts.pubsCount} pubs, and ${counts.notificationsCount} notifications verified.`,
      counts
    });
  } catch (e: any) {
    console.error("[Sync] Push failed:", e);
    const errMsg = e?.message || e?.toString() || "";
    res.status(500).json({
      success: false,
      message: "Push failed. Make sure your Billing is active and Firestore permissions allow writing: " + errMsg
    });
  }
});

// Helper function to pull all active data from Firestore
async function pullFirestoreToLocal(): Promise<{ usersCount: number; beersCount: number; pubsCount: number; notificationsCount: number }> {
  const usersList = await getAllUsers();
  const beersList = await getAllBeers();
  const pubsList = await getAllPubs();
  const notifsList = await getAllNotifications();

  return {
    usersCount: usersList.length,
    beersCount: beersList.length,
    pubsCount: pubsList.length,
    notificationsCount: notifsList.length
  };
}

// POST Pull Cloud Firestore Data to Local Offline Storage
app.post("/api/firestore-pull-to-local", async (req, res) => {
  console.log("[Sync] Request to pull Cloud Firestore data to local backup files.");
  const firestore = getFirestoreInstance();
  if (!firestore) {
    res.status(500).json({ success: false, message: "Firestore instance could not be initialized." });
    return;
  }

  try {
    // Make sure useFirestore is set to true
    useFirestore = true;
    
    // Test connection first
    await getDocs(query(collection(firestore, "users"), limit(1)));
    
    // Pull and update local backup files
    const counts = await pullFirestoreToLocal();
    
    res.json({
      success: true,
      message: `Cloud database data successfully retrieved and restored! Synced ${counts.usersCount} users, ${counts.beersCount} logs, ${counts.pubsCount} pubs, and ${counts.notificationsCount} notifications to the app.`,
      counts
    });
  } catch (e: any) {
    console.error("[Sync] Pull failed:", e);
    const errMsg = e?.message || e?.toString() || "";
    res.status(500).json({
      success: false,
      message: "Pull failed. Make sure your Billing is active and Firestore is accessible: " + errMsg
    });
  }
});

// GET Leaderboard Beers (scoped by date range)
app.get("/api/leaderboard-beers", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const list = await getAllBeers();

    if (!startDate || !endDate) {
      res.json(list || []);
      return;
    }

    const start = new Date(startDate as string).getTime();
    const end = new Date(endDate as string).getTime();

    const filtered = (list || []).filter((log) => {
      const logTime = new Date(log.date).getTime();
      return logTime >= start && logTime <= end;
    });

    res.json(filtered);
  } catch (err) {
    console.error("Error fetching leaderboard beers:", err);
    res.status(500).json({ error: "Failed to fetch leaderboard beers" });
  }
});

// GET Beers
app.get("/api/beers", async (req, res) => {
  let list = await getAllBeers();
  const userParam = req.query.user as string;
  const pubParam = req.query.pubId as string;
  const styleParam = req.query.beerStyle as string;
  const searchParam = (req.query.search || req.query.q) as string;

  if (userParam && userParam !== "all") {
    list = list.filter((b) => b.user === userParam);
  }
  if (pubParam && pubParam !== "global" && pubParam !== "all") {
    list = list.filter((b) => b.pubId === pubParam);
  }
  if (styleParam && styleParam !== "all") {
    list = list.filter((b) => b.beerStyle === styleParam);
  }
  if (searchParam && searchParam.trim()) {
    const term = searchParam.trim().toLowerCase();
    list = list.filter((b) =>
      (b.beerName && b.beerName.toLowerCase().includes(term)) ||
      (b.beerStyle && b.beerStyle.toLowerCase().includes(term)) ||
      (b.comment && b.comment.toLowerCase().includes(term)) ||
      (b.user && b.user.toLowerCase().includes(term))
    );
  }

  const limitVal = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const offsetVal = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

  if (limitVal !== undefined) {
    const paginatedBeers = list.slice(offsetVal, offsetVal + limitVal);
    res.json({
      beers: paginatedBeers,
      hasMore: offsetVal + limitVal < list.length,
      totalCount: list.length
    });
  } else {
    res.json(list);
  }
});

// GET User Stats from cached profile (with automatic recalculation fallback)
app.get("/api/users/:username/stats", async (req, res) => {
  const { username } = req.params;
  try {
    const allUsersList = await getAllUsers();
    const existingUser = allUsersList.find(
      (u) => u.username.toLowerCase() === username.toLowerCase()
    );

    if (existingUser && existingUser.stats) {
      res.json(existingUser.stats);
      return;
    }

    // Recalculate, cache, and return
    const stats = await recalculateAndCacheUserStats(username);
    res.json(stats);
  } catch (err: any) {
    console.error(`Failed to get stats for ${username}:`, err);
    res.status(500).json({ error: "Failed to load user stats" });
  }
});

// GET Weekly Recap - a fun, on-demand summary of the user's last 7 days. Deliberately
// does NOT lead with volume: favorite beer and highest-rated pint come first, the raw
// post count is secondary, and a quiet/dry week gets just as positive a framing as a
// busy one (no week-over-week comparisons, no "you drank more" language anywhere).
app.get("/api/users/:username/weekly-recap", async (req, res) => {
  const { username } = req.params;
  try {
    const allBeersList = await getAllBeers();
    const allUsersList = await getAllUsers();
    const allPubsList = await getAllPubs();
    const user = allUsersList.find((u) => u.username.toLowerCase() === username.toLowerCase());

    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const myLogsThisWeek = allBeersList.filter(
      (l) =>
        l.user.toLowerCase() === username.toLowerCase() &&
        !isImposterLog(l) &&
        now - new Date(l.date).getTime() <= weekMs &&
        new Date(l.date).getTime() <= now
    );

    const postsThisWeek = myLogsThisWeek.length;

    // Top beer this week
    const beerCounts: Record<string, number> = {};
    myLogsThisWeek.forEach((l) => {
      const name = (l.beerName || "").trim();
      if (name) beerCounts[name] = (beerCounts[name] || 0) + 1;
    });
    let topBeer: { name: string; count: number } | null = null;
    Object.entries(beerCounts).forEach(([name, count]) => {
      if (!topBeer || count > topBeer.count) topBeer = { name, count };
    });

    // Top pub this week
    const pubCounts: Record<string, number> = {};
    myLogsThisWeek.forEach((l) => {
      if (l.pubId) pubCounts[l.pubId] = (pubCounts[l.pubId] || 0) + 1;
    });
    let topPub: { name: string; count: number } | null = null;
    Object.entries(pubCounts).forEach(([pubId, count]) => {
      if (!topPub || count > topPub.count) {
        const pub = allPubsList.find((p) => p.id === pubId);
        topPub = { name: pub?.name || "Unknown Pub", count };
      }
    });
    const distinctPubsCount = Object.keys(pubCounts).length;

    // Highest-rated pint this week
    const rated = myLogsThisWeek.filter((l) => l.rating > 0);
    const highestRated = rated.length
      ? rated.reduce((best, l) => (l.rating > best.rating ? l : best))
      : null;
    const avgRating = rated.length
      ? (rated.reduce((acc, l) => acc + l.rating, 0) / rated.length).toFixed(1)
      : null;

    const cheersReceived = myLogsThisWeek.reduce((acc, l) => acc + (l.cheers?.length || 0), 0);
    const firstPourCount = myLogsThisWeek.filter((l) => l.isFirstOfDay).length;
    const newStyleCount = myLogsThisWeek.filter((l) => l.isNewStyle).length;
    const goblinModeCount = myLogsThisWeek.filter((l) => {
      const hour = getLocalHour(l.date, l.timezone || "America/Los_Angeles");
      return hour >= 0 && hour < 5;
    }).length;
    const dartComboCount = myLogsThisWeek.filter((l) => l.hadCig).length;
    const totalBadges = firstPourCount + newStyleCount + goblinModeCount + dartComboCount;

    const currentDryStreak = user?.stats?.currentDryStreak || 0;
    const longestDryStreak = user?.stats?.longestDryStreak || 0;

    // Week Archetype - a fun, single-line personality read on the week, picked by
    // priority (most specific/notable pattern wins). None of these reward volume for
    // its own sake - "The Regular" is about showing up, not drinking the most.
    let archetype: { emoji: string; title: string; tagline: string };
    if (postsThisWeek === 0) {
      archetype = currentDryStreak >= 3
        ? { emoji: "🧘", title: "The Monk", tagline: "Not a drop this week. Just vibes and hydration." }
        : { emoji: "😌", title: "Taking It Easy", tagline: "A quiet week. No pints, no drama - sometimes that's the whole vibe." };
    } else if (newStyleCount >= 2) {
      archetype = { emoji: "🧭", title: "The Explorer", tagline: "Never the same pint twice. You tried something new every time you sat down." };
    } else if (goblinModeCount >= 2) {
      archetype = { emoji: "👺", title: "The Goblin", tagline: "The sun went down and so did your bedtime standards. Feral after midnight." };
    } else if (cheersReceived >= 5 && cheersReceived >= postsThisWeek * 2) {
      archetype = { emoji: "🦋", title: "The Crowd Favorite", tagline: "Every pint you posted got the crowd going. Basically a hype machine." };
    } else if (avgRating && Number(avgRating) >= 4.5 && postsThisWeek >= 2) {
      archetype = { emoji: "🍷", title: "The Connoisseur", tagline: "Nothing but 5-star pours this week. Discerning palate, zero regrets." };
    } else if (firstPourCount >= 2) {
      archetype = { emoji: "🌅", title: "The Early Bird", tagline: "First to check in, every time. The early pint gets the worm." };
    } else if (distinctPubsCount >= 2) {
      archetype = { emoji: "🗺️", title: "The Wanderer", tagline: "You made the rounds this week. No single pub could hold you." };
    } else if (postsThisWeek >= 5) {
      archetype = { emoji: "🍻", title: "The Regular", tagline: "You showed up, again and again. Your friends know exactly where to find you." };
    } else {
      archetype = { emoji: "🍺", title: "The Casual Sipper", tagline: "A balanced week. Nothing wild, nothing dry - just pints, at a reasonable pace." };
    }

    res.json({
      windowDays: 7,
      postsThisWeek,
      topBeer,
      topPub,
      avgRating,
      highestRated: highestRated
        ? {
            beerName: highestRated.beerName,
            rating: highestRated.rating,
            imageUrl: highestRated.imageUrl,
            date: highestRated.date,
          }
        : null,
      cheersReceived,
      firstPourCount,
      newStyleCount,
      goblinModeCount,
      dartComboCount,
      totalBadges,
      currentDryStreak,
      longestDryStreak,
      archetype,
    });
  } catch (err: any) {
    console.error(`Failed to build weekly recap for ${username}:`, err);
    res.status(500).json({ error: "Failed to build weekly recap" });
  }
});

// POST Register FCM Token
app.post("/api/register-fcm-token", async (req, res) => {
  const { token, user } = req.body;
  if (!token || !user) {
    res.status(400).json({ error: "token and user are required" });
    return;
  }

  try {
    // If Admin SDK app is present and permission has not failed, re-enable FCM dispatch attempt
    if (getAdminApps().length > 0 && !fcmPermissionDenied) {
      fcmAvailable = true;
    }

    // 1. Save to local JSON file
    const TOKENS_FILE = path.join(process.cwd(), "fcm_tokens.json");
    let localTokens: { token: string; user: string; userLower: string; updatedAt: string }[] = [];
    if (fs.existsSync(TOKENS_FILE)) {
      try {
        localTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
      } catch (e) {}
    }
    // Remove old registration of this token
    localTokens = localTokens.filter(t => t.token !== token);
    localTokens.push({
      token,
      user,
      userLower: user.toLowerCase().trim(),
      updatedAt: new Date().toISOString()
    });
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(localTokens, null, 2));

    // 2. Save to Firestore
    const firestore = getFirestoreInstance();
    if (firestore && useFirestore) {
      const docId = Buffer.from(token).toString("base64").substring(0, 50).replace(/[^a-zA-Z0-9]/g, "");
      await setDoc(doc(firestore, "fcm_tokens", docId), {
        token,
        user,
        userLower: user.toLowerCase().trim(),
        updatedAt: new Date().toISOString()
      });
      console.log(`[FCM Server] Registered token for user ${user} (lower: ${user.toLowerCase().trim()}) in Firestore.`);
    }

    res.json({ success: true, message: "Token registered successfully" });
  } catch (err) {
    console.error("[FCM Server] Failed to register token:", err);
    res.status(500).json({ error: "Failed to register token" });
  }
});

// POST Unregister an old/rotated FCM token (called by the client right before it registers a
// freshly-rotated token for the same device, so stale tokens don't pile up and cause duplicate
// push notifications - a device's old token stays valid until explicitly removed, it does not
// automatically stop working just because a newer token was issued for the same install).
app.post("/api/unregister-fcm-token", async (req, res) => {
  const { token } = req.body;
  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }
  try {
    await removeFcmToken(token);
    res.json({ success: true });
  } catch (err) {
    console.error("[FCM Server] Failed to unregister token:", err);
    res.status(500).json({ error: "Failed to unregister token" });
  }
});

// POST Send Test Push
app.post("/api/send-test-push", async (req, res) => {
  const { user } = req.body;
  if (!user) {
    res.status(400).json({ error: "User is required" });
    return;
  }
  try {
    await sendFCMNotification(
      user,
      "BeerReel System 🍻",
      "A cold beer is calling your name! Everything's working through background FCM push."
    );
    res.json({ success: true, message: "Test push initiated" });
  } catch (err) {
    console.error("[FCM Server] Failed to send test push:", err);
    res.status(500).json({ error: "Failed to send test push" });
  }
});

// POST Beer Log
app.post("/api/beers", async (req, res) => {
  try {
    const rawUser = (req.body.user || "Anonymous").toString().trim();
    const user = rawUser || "Anonymous";
    const { beerName, beerStyle, abv, date, rating, comment, imageUrl, hadCig, pubId, timezone, location } = req.body;

    if (!user || !beerName || !beerStyle || abv === undefined || !date || rating === undefined) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    const normalized = normalizeBeerName(beerName);
    const cleanedBeerName = normalized.name || beerName;
    const cleanedStyle = (beerStyle && beerStyle !== "Other") ? beerStyle : (normalized.style || beerStyle || "Lager");
    const cleanedAbv = clampAbv(Number(abv) || (normalized.abv || 5.0));

    let processedImageUrl = imageUrl || undefined;
    if (processedImageUrl && typeof processedImageUrl === "string" && processedImageUrl.startsWith("data:image/")) {
      processedImageUrl = await saveBase64ToStorage(processedImageUrl);
    }

    const newLog: BeerLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      user,
      beerName: cleanedBeerName,
      beerStyle: cleanedStyle,
      abv: cleanedAbv,
      date,
      rating: clampRating(Number(rating)),
      cheers: [],
      comment: comment || "",
      imageUrl: processedImageUrl,
      hadCig: !!hadCig,
      pubId: pubId || undefined,
      timezone: isValidTimeZone(timezone) ? timezone : undefined,
      location: (typeof location === "string" && location.trim()) ? location.trim().slice(0, 100) : undefined
    };

    const saved = await saveBeerLog(newLog);

    // Send HTTP response immediately so the client UI unblocks instantly!
    res.status(201).json(saved);

    // Run notifications & user stats calculation in background
    (async () => {
      try {
        const allBeersList = await getAllBeers();
        const checkInDateStr = saved.date.split("T")[0]; // YYYY-MM-DD
        const userLogsToday = allBeersList.filter(
          (l) => l.user === saved.user && l.date.split("T")[0] === checkInDateStr
        );

        // 1. Only send a post notification for the FIRST beer of the day for that user -
        // friends only, not the whole user base.
        if (userLogsToday.length === 1) {
          const notificationText = generateCreativeBeerNotificationText(
            saved.beerName,
            Number(saved.abv),
            saved.date,
            userLogsToday.length
          );

          await notifyFriendsOfActivity({
            user: saved.user,
            text: notificationText,
            date: saved.date,
            type: "post",
          });
        }

        // Trigger tag notifications if any valid users are tagged
        if (saved.comment) {
          const tags = await getValidTags(saved.comment);
          for (const taggedUser of tags) {
            if (taggedUser.toLowerCase().trim() !== saved.user.toLowerCase().trim()) {
              const rawSnippet = saved.comment.length > 40 ? saved.comment.substring(0, 40) + "..." : saved.comment;
              const snippet = escapeHtml(rawSnippet);
              await createAndDispatchNotification({
                idPrefix: "notif-tag",
                user: saved.user,
                targetUser: taggedUser,
                text: `tagged you in a post: "${snippet}" 🏷️`,
                date: saved.date,
                type: "tag",
              });
            }
          }
        }

        // 2. First Pour of the Day - whoever is first (across ALL users) to check
        // in each calendar day gets a fun, positive callout. Unlike the old
        // "bender alert" this rewards being early, not drinking a lot. Posts
        // the community has flagged as fake (3+ Imposter Pint votes) don't
        // count toward this - or anything else below.
        const legitBeersList = allBeersList.filter((l) => !isImposterLog(l));
        const otherLogsSameDay = legitBeersList.filter(
          (l) => l.id !== saved.id && l.date.split("T")[0] === checkInDateStr
        );
        const isFirstOfDay = otherLogsSameDay.every(
          (l) => new Date(l.date).getTime() >= new Date(saved.date).getTime()
        );

        // 3. New Style Unlocked - first time this user has logged this beer style.
        const priorStyleLogs = legitBeersList.filter(
          (l) => l.id !== saved.id &&
            l.user === saved.user &&
            (l.beerStyle || "").toLowerCase() === (saved.beerStyle || "").toLowerCase()
        );
        const isNewStyle = priorStyleLogs.length === 0;

        if (isFirstOfDay || isNewStyle) {
          await saveBeerLog({ ...saved, isFirstOfDay, isNewStyle });
        }

        if (isFirstOfDay) {
          await notifyFriendsOfActivity({
            idPrefix: "notif-first-pour",
            user: saved.user,
            text: `🌅 <strong>${escapeHtml(saved.user)}</strong> poured the first pint of the day! Who's next?`,
            date: saved.date,
            type: "first_pour",
          });
        }
      } catch (err) {
        console.error("Failed to generate notifications:", err);
      }

      try {
        await recalculateAndCacheUserStats(saved.user);
      } catch (err) {
        console.error("Failed to recalculate user stats:", err);
      }
    })();
  } catch (err: any) {
    console.error("Error in POST /api/beers:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || "Failed to post beer log" });
    }
  }
});

// POST Update/Enrich Beer Log
app.post("/api/beers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { beerName, beerStyle, abv, rating, comment, hadCig, currentUser, location } = req.body;
    const requester = (currentUser || req.query.currentUser || req.headers["x-current-user"] || "").toString();

    let log = await findBeerLogById(id);
    if (!log) {
      const allBeersList = await getAllBeers();
      log = allBeersList.find((b) => b.id === id) || null;
    }

    if (!log) {
      res.status(404).json({ error: "Beer log not found" });
      return;
    }

    const isOwner = requester.toLowerCase().trim() === (log.user || "").toLowerCase().trim();
    const isAdmin = isSeymoreBeers(requester);
    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: "Unauthorized. You can only edit your own posts." });
      return;
    }

    if (beerName !== undefined) log.beerName = beerName;
    if (beerStyle !== undefined) log.beerStyle = beerStyle;
    if (abv !== undefined) log.abv = clampAbv(Number(abv));
    if (rating !== undefined) log.rating = clampRating(Number(rating));
    if (comment !== undefined) log.comment = comment;
    if (hadCig !== undefined) log.hadCig = !!hadCig;
    if (location !== undefined) log.location = (typeof location === "string" && location.trim()) ? location.trim().slice(0, 100) : undefined;

    await saveBeerLog(log);

    // Return updated log immediately to unblock client
    res.json(log);

    // Background recalculate user stats
    recalculateAndCacheUserStats(log.user).catch((err) => {
      console.error("Failed to recalculate user stats on enrich:", err);
    });
  } catch (err: any) {
    console.error("Error in POST /api/beers/:id:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to update beer log" });
    }
  }
});

// POST Toggle Cheers on a Log
app.post("/api/beers/:id/cheers", async (req, res) => {
  const { id } = req.params;
  const username = (req.body.username || req.body.user || "").toString().trim();

  if (!username) {
    res.status(400).json({ error: "Username is required to cheer" });
    return;
  }

  try {
    const updated = await toggleBeerCheers(id, username);
    if (!updated) {
      res.status(404).json({ error: "Beer log not found" });
      return;
    }

    // Trigger Notification if cheering someone else's post (and adding a cheer)
    try {
      if (updated.user && updated.user.toLowerCase() !== username.toLowerCase() && (updated.cheers || []).includes(username)) {
        const beerNameStr = updated.beerName ? String(updated.beerName) : "";
        const isGuinness = isGuinnessBeerName(beerNameStr);
        const notifText = isGuinness
          ? `cheered your pint of <strong>Guinness</strong>! 🍻`
          : `cheered your pint! 🍻`;
        await createAndDispatchNotification({
          user: username,
          targetUser: updated.user,
          text: notifText,
          type: "cheer",
        });
      }
    } catch (err) {
      console.error("Failed to generate cheer notification:", err);
    }

    // Recalculate stats for the post creator so that their totalCheers is perfectly accurate in the cache
    if (updated.user) {
      try {
        await recalculateAndCacheUserStats(updated.user);
      } catch (err) {
        console.error("Failed to recalculate user stats on cheers:", err);
      }
    }

    res.json(updated);
  } catch (err) {
    console.error(`Error in /api/beers/${id}/cheers:`, err);
    res.status(500).json({ error: "Failed to toggle cheers" });
  }
});

// POST Toggle Reaction on a Log
app.post("/api/beers/:id/react", async (req, res) => {
  const { id } = req.params;
  const username = (req.body.username || req.body.user || "").toString().trim();
  const { reactionType } = req.body;

  if (!username) {
    res.status(400).json({ error: "Username is required to react" });
    return;
  }
  if (!reactionType) {
    res.status(400).json({ error: "Reaction type is required" });
    return;
  }

  try {
    const updated = await toggleBeerReaction(id, username, reactionType);
    if (!updated) {
      res.status(404).json({ error: "Beer log not found" });
      return;
    }

    // Trigger Notification if reacting to someone else's post
    try {
      if (updated.user && updated.user.toLowerCase() !== username.toLowerCase()) {
        // reactionType is client-supplied and unvalidated - only ever use it verbatim
        // when it matches a known reaction; otherwise escape it before it can reach
        // notification HTML (the client won't normally send anything outside this
        // list, but nothing stops a direct API call from trying to).
        let reactionLabel = escapeHtml(reactionType);
        if (reactionType === "creamy") reactionLabel = "Creamy 🍺";
        else if (reactionType === "cheers") reactionLabel = "Cheers 🍻";
        else if (reactionType === "fomo") reactionLabel = "FOMO Alert 🚨";
        else if (reactionType === "nightnight") reactionLabel = "Night night 🌙";
        else if (reactionType === "drunk") reactionLabel = "Drunk 🥴";
        else if (reactionType === "juicy") reactionLabel = "Juicy 🍑";
        else if (reactionType === "dislike") reactionLabel = "Imposter Pint! 🕵️";

        const beerNameStr = updated.beerName ? String(updated.beerName) : "";
        const isGuinness = isGuinnessBeerName(beerNameStr);
        const notifText = isGuinness
          ? `reacted with <strong>${reactionLabel}</strong> to your pint of <strong>Guinness</strong>!`
          : `reacted with <strong>${reactionLabel}</strong> to your pint!`;

        await createAndDispatchNotification({
          user: username,
          targetUser: updated.user,
          text: notifText,
          type: "reaction",
        });

        // 3. Notify the outed poster's friends ONLY when a pint is officially outed as an
        // imposter (reaches 3 dislike/imposter votes) - not the whole user base.
        if (reactionType === "dislike") {
          const dislikeCount = (updated.reactions?.["dislike"]?.length || 0) + (updated.reactions?.["imposter"]?.length || 0);
          if (dislikeCount === 3) {
            const safeUpdatedUser = escapeHtml(updated.user);
            const imposterNotifText = isGuinness
              ? `🚨 IMPOSTER PINT OUTED! 🕵️ caught <strong>${safeUpdatedUser}</strong> logging a fake pint of <strong>Guinness</strong>!`
              : `🚨 IMPOSTER PINT OUTED! 🕵️ caught <strong>${safeUpdatedUser}</strong> logging a fake pint!`;
            await notifyFriendsOfActivity({
              idPrefix: "imposter",
              user: username,
              text: imposterNotifText,
              type: "imposter",
            }, updated.user);
          }
        }
      }

      // Recalculate stats for the post creator so stats remain up to date when voted imposter
      if (updated.user) {
        recalculateAndCacheUserStats(updated.user).catch((e) =>
          console.error("Error recalculating stats after reaction toggle:", e)
        );
      }
    } catch (err) {
      console.error("Failed to generate reaction notification:", err);
    }

    res.json(updated);
  } catch (err) {
    console.error(`Error in /api/beers/${id}/react:`, err);
    res.status(500).json({ error: "Failed to toggle reaction" });
  }
});

// DELETE a log
app.delete("/api/beers/:id", async (req, res) => {
  const { id } = req.params;
  const currentUser = (req.query.currentUser || req.headers["x-current-user"] || "").toString().trim();

  const log = await findBeerLogById(id);

  if (!log) {
    res.status(404).json({ error: "Post not found." });
    return;
  }

  const beerUser = log.user || "";
  const isOwner = currentUser.toLowerCase().trim() === beerUser.toLowerCase().trim();
  const isAdmin = isSeymoreBeers(currentUser);

  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: "Unauthorized. You can only delete your own posts." });
    return;
  }

  const beerUserToUpdate = log.user;

  await deleteBeerLog(id);

  if (log.imageUrl) {
    deleteStorageObjectForImageUrl(log.imageUrl).catch((e) =>
      console.warn("Error deleting Storage object after post delete:", e)
    );
  }

  if (beerUserToUpdate) {
    // Recalculate user statistics asynchronously
    recalculateAndCacheUserStats(beerUserToUpdate).catch((e) =>
      console.error("Error recalculating stats after delete:", e)
    );
  }

  res.json({ success: true });
});

// POST Comment to a Log
app.post("/api/beers/:id/comments", async (req, res) => {
  const { id } = req.params;
  const { user, text } = req.body;

  if (!user || !text) {
    res.status(400).json({ error: "User and comment text are required" });
    return;
  }

  const updated = await addBeerComment(id, user, text);
  if (!updated) {
    res.status(404).json({ error: "Beer log not found" });
    return;
  }

  // Trigger Notification if commenting on someone else's post
  try {
    if (updated.user !== user) {
      const snippet = escapeHtml(text.length > 30 ? text.substring(0, 30) + "..." : text);
      const isGuinness = isGuinnessBeerName(updated.beerName);
      const notifText = isGuinness
        ? `commented on your pint of <strong>Guinness</strong>: "${snippet}" 💬`
        : `commented on your pint: "${snippet}" 💬`;

      await createAndDispatchNotification({
        user: user,
        targetUser: updated.user,
        text: notifText,
        type: "comment",
      });
    }

    // Trigger tag notifications if any valid users are tagged in the comment
    const tags = await getValidTags(text);
    for (const taggedUser of tags) {
      if (
        taggedUser.toLowerCase().trim() !== user.toLowerCase().trim() &&
        taggedUser.toLowerCase().trim() !== updated.user.toLowerCase().trim()
      ) {
        const snippet = escapeHtml(text.length > 30 ? text.substring(0, 30) + "..." : text);
        await createAndDispatchNotification({
          idPrefix: "notif-tag",
          user: user,
          targetUser: taggedUser,
          text: `tagged you in a comment: "${snippet}" 🏷️`,
          type: "tag",
        });
      }
    }
  } catch (err) {
    console.error("Failed to generate comment notification:", err);
  }

  res.status(201).json(updated);
});

// DELETE Comment from a Log
app.delete("/api/beers/:id/comments/:commentId", async (req, res) => {
  const { id, commentId } = req.params;
  const currentUser = (req.query.currentUser || req.headers["x-current-user"] || "").toString();

  const allBeersList = await getAllBeers();
  const log = allBeersList.find((b) => b.id === id);
  if (log) {
    const comment = (log.comments || []).find((c) => c.id === commentId);
    if (comment) {
      const isOwner = currentUser.toLowerCase().trim() === comment.user.toLowerCase().trim();
      const isAdmin = isSeymoreBeers(currentUser);
      if (!isOwner && !isAdmin) {
        res.status(403).json({ error: "Unauthorized. You can only delete your own comments." });
        return;
      }
    }
  }

  const updated = await deleteBeerComment(id, commentId);
  if (!updated) {
    res.status(404).json({ error: "Beer log not found" });
    return;
  }

  res.json(updated);
});

// POST Reaction to a Comment
app.post("/api/beers/:id/comments/:commentId/reactions", async (req, res) => {
  const { id, commentId } = req.params;
  const { user, reaction } = req.body;

  if (!user || !reaction) {
    res.status(400).json({ error: "User and reaction are required" });
    return;
  }

  const updated = await toggleCommentReaction(id, commentId, user, reaction);
  if (!updated) {
    res.status(404).json({ error: "Beer log or comment not found" });
    return;
  }

  // Trigger notification if reacting to someone else's comment
  try {
    const comment = (updated.comments || []).find((c) => c.id === commentId);
    if (comment && comment.user !== user) {
      const snippet = escapeHtml(comment.text.length > 25 ? comment.text.substring(0, 25) + "..." : comment.text);
      const safeReaction = escapeHtml(reaction);
      await createAndDispatchNotification({
        idPrefix: "notif-comment-react",
        user: user,
        targetUser: comment.user,
        text: `reacted ${safeReaction} to your comment: "${snippet}"`,
        type: "reaction",
      });
    }
  } catch (err) {
    console.error("Failed to generate comment reaction notification:", err);
  }

  res.json(updated);
});

// GET Notifications
app.get("/api/notifications", async (req, res) => {
  const list = await getAllNotifications();
  res.json(list);
});

// POST Mark Notifications as Read
app.post("/api/notifications/read", async (req, res) => {
  const { username } = req.body;
  if (!username) {
    res.status(400).json({ error: "Username is required to mark notifications as read" });
    return;
  }
  await markNotificationsRead(username);
  res.json({ success: true });
});

// POST Login
app.post("/api/login", async (req, res) => {
  const { username, email, identifier, password } = req.body;
  const inputIdentifier = (identifier || username || email || "").toString().trim();
  if (!inputIdentifier || !password) {
    res.status(400).json({ error: "Username/Email and password are required" });
    return;
  }

  const allUsers = await getAllUsers();
  const user = allUsers.find(
    (u) =>
      u.username.toLowerCase() === inputIdentifier.toLowerCase() ||
      (u.email && u.email.toLowerCase() === inputIdentifier.toLowerCase())
  );

  if (!user) {
    res.status(401).json({ error: "User profile not found. Please check your username/email or create an account." });
    return;
  }

  const userPassword = user.password || "Pints!";
  if (!verifyPassword(password, userPassword)) {
    res.status(401).json({ error: "Incorrect password. (The default is 'Pints!' for existing users)." });
    return;
  }

  // Lazily migrate legacy plaintext passwords to a salted hash now that we know it's correct.
  if (!isHashedPassword(userPassword)) {
    user.password = hashPassword(password);
    await saveUser(user);
  }

  const { password: _pw, recoveryCodeHash: _rch, ...safeUser } = user;
  res.json({ success: true, user: safeUser });
});

// GET Users
app.get("/api/users", async (req, res) => {
  const list = await getAllUsers();
  const viewerUsername = (req.query.viewerUsername || "").toString().trim().toLowerCase();
  // Never send password hashes to clients - nothing client-side needs to read this back.
  // Email is likewise stripped from this bulk listing - it's not displayed anywhere in the
  // app, so the only legitimate reason to see one is a user loading their own profile to
  // edit it, which is why the requesting user's own email (if identified) is kept.
  res.json(
    list.map(({ password, email, recoveryCodeHash, ...rest }) => ({
      ...rest,
      ...(viewerUsername && rest.username.toLowerCase() === viewerUsername ? { email } : {}),
    }))
  );
});

// POST User Profile
app.post("/api/users", async (req, res) => {
  const { username, favoriteStyle, avatar, bio, password, currentPassword, realName, photoUrl, email } = req.body;

  if (!username || !favoriteStyle || !avatar) {
    res.status(400).json({ error: "Missing required profile fields" });
    return;
  }

  const allUsersList = await getAllUsers();
  const existingIndex = allUsersList.findIndex(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );

  const existingUser = existingIndex !== -1 ? allUsersList[existingIndex] : null;

  // New accounts only: usernames can't contain whitespace, since the @mention parser
  // (both while typing and when rendering existing text) only matches [a-zA-Z0-9_-] -
  // a username with a space would be unmentionable/mis-linked everywhere in the app.
  if (!existingUser && /\s/.test(username)) {
    res.status(400).json({ error: "Usernames can't contain spaces - try an underscore or just squish it together." });
    return;
  }

  // New passwords (new account, or an existing account changing its password) need a
  // sane minimum length - there was previously no floor at all, so a 1-character
  // password was accepted.
  if (password && password.length < 4) {
    res.status(400).json({ error: "Password must be at least 4 characters." });
    return;
  }

  // Require proof of identity before an EXISTING account's PASSWORD changes - getting
  // this wrong could lock the real owner out or hand the account to someone else, so
  // it stays gated even though routine profile edits (name/bio/avatar/photo/email)
  // below no longer are.
  if (existingUser && password) {
    const storedPassword = existingUser.password || "Pints!";
    if (!verifyPassword((currentPassword || "").toString(), storedPassword)) {
      res.status(401).json({ error: "Incorrect current password. Re-enter your current password to change it." });
      return;
    }
  }

  // Check duplicate email if provided
  if (email && email.trim()) {
    const emailDup = allUsersList.find(
      (u) =>
        u.email &&
        u.email.toLowerCase() === email.trim().toLowerCase() &&
        u.username.toLowerCase() !== username.toLowerCase()
    );
    if (emailDup) {
      res.status(400).json({ error: "This email address is already associated with another account." });
      return;
    }
  }

  // New accounts get a one-time recovery code (this app has no email infra to send a
  // reset link through, so this is the self-service account-recovery mechanism). It's
  // generated here, hashed at rest, and the ONLY plaintext copy is returned once below.
  const newRecoveryCode = !existingUser ? generateRecoveryCode() : undefined;

  // Profile photos arrive from the client as a raw base64 data URL (the crop step never
  // uploads it itself) and need converting to a real Storage-backed URL before they can
  // be saved - exactly like POST /api/beers already does for post photos. Skipping this
  // was the actual bug: sanitizeForFirestore()'s base64 safeguard only recognizes the
  // "imageUrl"/"avatar" keys by name, so a raw base64 photoUrl slipped past it and hit
  // the 50KB field-size safeguard instead, which silently strips it to an empty string -
  // every profile photo upload was quietly discarded with no error ever shown.
  let resolvedPhotoUrl = photoUrl;
  if (typeof resolvedPhotoUrl === "string" && resolvedPhotoUrl.startsWith("data:image/")) {
    resolvedPhotoUrl = await saveBase64ToStorage(resolvedPhotoUrl);
  }

  const profile: UserProfile = {
    username,
    favoriteStyle,
    avatar,
    bio: bio || "",
    joinedDate: existingUser ? existingUser.joinedDate : new Date().toISOString().split("T")[0],
    password: password
      ? hashPassword(password)
      : (existingUser ? existingUser.password : hashPassword("Pints!")),
    recoveryCodeHash: newRecoveryCode ? hashPassword(newRecoveryCode) : (existingUser ? existingUser.recoveryCodeHash : undefined),
    realName: realName || (existingUser ? existingUser.realName : undefined),
    photoUrl: resolvedPhotoUrl !== undefined ? (resolvedPhotoUrl || undefined) : (existingUser ? existingUser.photoUrl : undefined),
    email: email !== undefined ? (email.trim() || undefined) : (existingUser ? existingUser.email : undefined),
    friends: existingUser ? (existingUser.friends || []) : [],
    friendRequests: existingUser ? (existingUser.friendRequests || []) : []
  };

  const isNewUser = !existingUser;
  const saved = await saveUser(profile);

  if (isNewUser) {
    try {
      const notif: AppNotification = {
        id: "newuser-" + username + "-" + Date.now(),
        user: username,
        text: `🎉 A new user, <strong>${escapeHtml(realName || username)}</strong>, just joined BeerReel! Give them a warm welcome! 🍻`,
        date: new Date().toISOString(),
        readBy: [],
        type: "post"
      };
      await saveNotification(notif);
      console.log(`[Notification] Created new user notification for ${username}`);
    } catch (err) {
      console.error("Failed to generate new user notification:", err);
    }
  }

  const { password: _savedPw, recoveryCodeHash: _savedRch, ...safeSaved } = saved;
  res.json(newRecoveryCode ? { ...safeSaved, recoveryCode: newRecoveryCode } : safeSaved);
});

// POST Reset Password via Recovery Code (no email infra in this app - the recovery
// code shown once at signup/regeneration is the self-service account-recovery path)
app.post("/api/users/:username/reset-password", async (req, res) => {
  const username = (req.params.username || "").toString();
  const recoveryCode = normalizeRecoveryCode(req.body.recoveryCode);
  const newPassword = (req.body.newPassword || "").toString();

  if (!recoveryCode || !newPassword) {
    res.status(400).json({ error: "Recovery code and new password are required." });
    return;
  }
  if (newPassword.length < 4) {
    res.status(400).json({ error: "Password must be at least 4 characters." });
    return;
  }

  const allUsers = await getAllUsers();
  const user = allUsers.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  if (!user.recoveryCodeHash || !verifyPassword(recoveryCode, user.recoveryCodeHash)) {
    res.status(401).json({ error: "That recovery code doesn't match. Double-check it or contact support if you've lost it." });
    return;
  }

  // Rotate the recovery code on every successful use, same principle as a single-use
  // token - a leaked-then-used code shouldn't keep working afterward.
  const nextRecoveryCode = generateRecoveryCode();
  user.password = hashPassword(newPassword);
  user.recoveryCodeHash = hashPassword(nextRecoveryCode);
  await saveUser(user);

  res.json({ success: true, recoveryCode: nextRecoveryCode });
});

// POST Regenerate Recovery Code (for already-logged-in users, including accounts
// created before this feature existed and therefore have no recovery code yet)
app.post("/api/users/:username/recovery-code", async (req, res) => {
  const username = (req.params.username || "").toString();
  const currentPassword = (req.body.currentPassword || "").toString();

  const allUsers = await getAllUsers();
  const user = allUsers.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  const storedPassword = user.password || "Pints!";
  if (!verifyPassword(currentPassword, storedPassword)) {
    res.status(401).json({ error: "Incorrect current password." });
    return;
  }

  const recoveryCode = generateRecoveryCode();
  user.recoveryCodeHash = hashPassword(recoveryCode);
  await saveUser(user);

  res.json({ success: true, recoveryCode });
});

// POST Send Friend Request
app.post("/api/friends/request", async (req, res) => {
  const from = (req.body.from || "").toString().trim();
  const to = (req.body.to || "").toString().trim();

  if (!from || !to) {
    res.status(400).json({ error: "Both 'from' and 'to' usernames are required." });
    return;
  }
  if (from.toLowerCase() === to.toLowerCase()) {
    res.status(400).json({ error: "You can't friend request yourself." });
    return;
  }

  const allUsers = await getAllUsers();
  const fromUser = allUsers.find((u) => u.username.toLowerCase() === from.toLowerCase());
  const toUser = allUsers.find((u) => u.username.toLowerCase() === to.toLowerCase());

  if (!fromUser || !toUser) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  const fromFriends = fromUser.friends || [];
  if (fromFriends.some((f) => f.toLowerCase() === to.toLowerCase())) {
    res.status(400).json({ error: "You're already friends." });
    return;
  }

  const fromBlockedTo = (fromUser.blockedUsers || []).some((b) => b.toLowerCase() === to.toLowerCase());
  const toBlockedFrom = (toUser.blockedUsers || []).some((b) => b.toLowerCase() === from.toLowerCase());
  if (fromBlockedTo || toBlockedFrom) {
    res.status(403).json({ error: "Unable to send friend request." });
    return;
  }

  // If the other user already sent us a request, auto-accept instead of leaving two pending requests
  const toAlreadyRequestedUs = (fromUser.friendRequests || []).some((r) => r.toLowerCase() === to.toLowerCase());
  if (toAlreadyRequestedUs) {
    fromUser.friends = [...fromFriends, toUser.username];
    fromUser.friendRequests = (fromUser.friendRequests || []).filter((r) => r.toLowerCase() !== to.toLowerCase());
    toUser.friends = [...(toUser.friends || []), fromUser.username];
    await saveUser(fromUser);
    await saveUser(toUser);
    await createAndDispatchNotification({
      idPrefix: "notif-friend-accept",
      user: fromUser.username,
      targetUser: toUser.username,
      text: `is now friends with you! 🍻`,
      type: "friend_accept",
    });
    res.json({ status: "friends", users: stripPasswords([fromUser, toUser]) });
    return;
  }

  const toRequests = toUser.friendRequests || [];
  if (toRequests.some((r) => r.toLowerCase() === from.toLowerCase())) {
    res.json({ status: "already_requested", users: stripPasswords([toUser]) });
    return;
  }

  toUser.friendRequests = [...toRequests, fromUser.username];
  await saveUser(toUser);

  await createAndDispatchNotification({
    idPrefix: "notif-friend-request",
    user: fromUser.username,
    targetUser: toUser.username,
    text: `wants to be your friend!`,
    type: "friend_request",
  });

  res.json({ status: "requested", users: stripPasswords([toUser]) });
});

// POST Accept Friend Request
app.post("/api/friends/accept", async (req, res) => {
  const user = (req.body.user || "").toString().trim();
  const requester = (req.body.requester || "").toString().trim();

  if (!user || !requester) {
    res.status(400).json({ error: "Both 'user' and 'requester' usernames are required." });
    return;
  }

  const allUsers = await getAllUsers();
  const userProfile = allUsers.find((u) => u.username.toLowerCase() === user.toLowerCase());
  const requesterProfile = allUsers.find((u) => u.username.toLowerCase() === requester.toLowerCase());

  if (!userProfile || !requesterProfile) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  const hasRequest = (userProfile.friendRequests || []).some((r) => r.toLowerCase() === requester.toLowerCase());
  if (!hasRequest) {
    res.status(400).json({ error: "No pending friend request from this user." });
    return;
  }

  userProfile.friendRequests = (userProfile.friendRequests || []).filter((r) => r.toLowerCase() !== requester.toLowerCase());
  userProfile.friends = [...(userProfile.friends || []), requesterProfile.username];
  requesterProfile.friends = [...(requesterProfile.friends || []), userProfile.username];

  await saveUser(userProfile);
  await saveUser(requesterProfile);

  await createAndDispatchNotification({
    idPrefix: "notif-friend-accept",
    user: userProfile.username,
    targetUser: requesterProfile.username,
    text: `accepted your friend request! 🍻`,
    type: "friend_accept",
  });

  res.json({ status: "friends", users: stripPasswords([userProfile, requesterProfile]) });
});

// POST Decline Friend Request
app.post("/api/friends/decline", async (req, res) => {
  const user = (req.body.user || "").toString().trim();
  const requester = (req.body.requester || "").toString().trim();

  if (!user || !requester) {
    res.status(400).json({ error: "Both 'user' and 'requester' usernames are required." });
    return;
  }

  const allUsers = await getAllUsers();
  const userProfile = allUsers.find((u) => u.username.toLowerCase() === user.toLowerCase());
  if (!userProfile) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  userProfile.friendRequests = (userProfile.friendRequests || []).filter((r) => r.toLowerCase() !== requester.toLowerCase());
  await saveUser(userProfile);

  res.json({ status: "declined", users: stripPasswords([userProfile]) });
});

// POST Cancel a Friend Request I Sent
app.post("/api/friends/cancel", async (req, res) => {
  const user = (req.body.user || "").toString().trim();
  const target = (req.body.target || "").toString().trim();

  if (!user || !target) {
    res.status(400).json({ error: "Both 'user' and 'target' usernames are required." });
    return;
  }

  const allUsers = await getAllUsers();
  const targetProfile = allUsers.find((u) => u.username.toLowerCase() === target.toLowerCase());
  if (!targetProfile) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  targetProfile.friendRequests = (targetProfile.friendRequests || []).filter((r) => r.toLowerCase() !== user.toLowerCase());
  await saveUser(targetProfile);

  res.json({ status: "cancelled", users: stripPasswords([targetProfile]) });
});

// POST Remove Friend
app.post("/api/friends/remove", async (req, res) => {
  const user = (req.body.user || "").toString().trim();
  const friend = (req.body.friend || "").toString().trim();

  if (!user || !friend) {
    res.status(400).json({ error: "Both 'user' and 'friend' usernames are required." });
    return;
  }

  const allUsers = await getAllUsers();
  const userProfile = allUsers.find((u) => u.username.toLowerCase() === user.toLowerCase());
  const friendProfile = allUsers.find((u) => u.username.toLowerCase() === friend.toLowerCase());

  if (!userProfile) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  userProfile.friends = (userProfile.friends || []).filter((f) => f.toLowerCase() !== friend.toLowerCase());
  await saveUser(userProfile);

  if (friendProfile) {
    friendProfile.friends = (friendProfile.friends || []).filter((f) => f.toLowerCase() !== user.toLowerCase());
    await saveUser(friendProfile);
  }

  res.json({ status: "removed", users: stripPasswords(friendProfile ? [userProfile, friendProfile] : [userProfile]) });
});

// POST Ping - a lightweight "the app was just opened" heartbeat, used to distinguish
// genuinely inactive accounts from active ones on the dry-streak leaderboard (see
// Statistics.tsx TEMPLE_INACTIVITY_DAYS) without requiring a fresh beer post. Cheap,
// low-stakes, fire-and-forget - deliberately no auth beyond the username existing.
app.post("/api/users/:username/ping", async (req, res) => {
  const { username } = req.params;
  try {
    const allUsers = await getAllUsers();
    const userProfile = allUsers.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!userProfile) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    userProfile.lastActiveDate = new Date().toISOString();
    await saveUser(userProfile);
    res.json({ success: true });
  } catch (err) {
    console.error(`Failed to record ping for ${username}:`, err);
    res.status(500).json({ error: "Failed to record activity." });
  }
});

// POST Block User - hides the target's content from the blocker and severs any friendship
app.post("/api/users/:username/block", async (req, res) => {
  const { username } = req.params;
  const targetUsername = (req.body.targetUsername || "").toString().trim();
  const requester = (req.body.currentUser || req.query.currentUser || req.headers["x-current-user"] || "").toString();

  if (requester.toLowerCase().trim() !== username.toLowerCase().trim() && !isSeymoreBeers(requester)) {
    res.status(403).json({ error: "Unauthorized. You can only manage your own block list." });
    return;
  }

  if (!targetUsername) {
    res.status(400).json({ error: "'targetUsername' is required." });
    return;
  }
  if (targetUsername.toLowerCase() === username.toLowerCase()) {
    res.status(400).json({ error: "You can't block yourself." });
    return;
  }

  const allUsers = await getAllUsers();
  const userProfile = allUsers.find((u) => u.username.toLowerCase() === username.toLowerCase());
  const targetProfile = allUsers.find((u) => u.username.toLowerCase() === targetUsername.toLowerCase());

  if (!userProfile) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  const blocked = new Set((userProfile.blockedUsers || []).map((b) => b.toLowerCase()));
  blocked.add(targetUsername.toLowerCase());
  userProfile.blockedUsers = Array.from(blocked);

  // Blocking severs any existing friendship in both directions, and clears
  // any pending request either side sent so blocking can't be worked around.
  userProfile.friends = (userProfile.friends || []).filter((f) => f.toLowerCase() !== targetUsername.toLowerCase());
  userProfile.friendRequests = (userProfile.friendRequests || []).filter((f) => f.toLowerCase() !== targetUsername.toLowerCase());
  await saveUser(userProfile);

  if (targetProfile) {
    targetProfile.friends = (targetProfile.friends || []).filter((f) => f.toLowerCase() !== username.toLowerCase());
    targetProfile.friendRequests = (targetProfile.friendRequests || []).filter((f) => f.toLowerCase() !== username.toLowerCase());
    await saveUser(targetProfile);
  }

  res.json({ status: "blocked", users: stripPasswords(targetProfile ? [userProfile, targetProfile] : [userProfile]) });
});

// POST Unblock User
app.post("/api/users/:username/unblock", async (req, res) => {
  const { username } = req.params;
  const targetUsername = (req.body.targetUsername || "").toString().trim();
  const requester = (req.body.currentUser || req.query.currentUser || req.headers["x-current-user"] || "").toString();

  if (requester.toLowerCase().trim() !== username.toLowerCase().trim() && !isSeymoreBeers(requester)) {
    res.status(403).json({ error: "Unauthorized. You can only manage your own block list." });
    return;
  }

  if (!targetUsername) {
    res.status(400).json({ error: "'targetUsername' is required." });
    return;
  }

  const allUsers = await getAllUsers();
  const userProfile = allUsers.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!userProfile) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  userProfile.blockedUsers = (userProfile.blockedUsers || []).filter((b) => b.toLowerCase() !== targetUsername.toLowerCase());
  await saveUser(userProfile);

  res.json({ status: "unblocked", users: stripPasswords([userProfile]) });
});

// POST Submit a content/user report
app.post("/api/reports", async (req, res) => {
  const reporterUsername = (req.body.reporterUsername || "").toString().trim();
  const targetType = (req.body.targetType || "").toString().trim();
  const targetId = (req.body.targetId || "").toString().trim();
  const targetUsername = req.body.targetUsername ? req.body.targetUsername.toString().trim() : undefined;
  const reason = (req.body.reason || "").toString().trim();
  const note = req.body.note ? req.body.note.toString().trim().slice(0, 500) : undefined;

  if (!reporterUsername || !targetType || !targetId || !reason) {
    res.status(400).json({ error: "reporterUsername, targetType, targetId, and reason are required." });
    return;
  }
  if (!["user", "post", "comment"].includes(targetType)) {
    res.status(400).json({ error: "targetType must be 'user', 'post', or 'comment'." });
    return;
  }

  const report: ContentReport = {
    id: `report-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    reporterUsername,
    targetType: targetType as ContentReport["targetType"],
    targetId,
    targetUsername,
    reason,
    note,
    date: new Date().toISOString(),
    status: "open",
  };

  await saveReport(report);
  res.json({ status: "submitted", report });
});

// GET all reports (admin only)
app.get("/api/reports", async (req, res) => {
  const currentUser = (req.query.currentUser || req.headers["x-current-user"] || "").toString();
  if (!isSeymoreBeers(currentUser)) {
    res.status(403).json({ error: "Unauthorized. Admin access required." });
    return;
  }
  const reports = await getAllReports();
  res.json(reports);
});

// POST resolve a report (admin only)
app.post("/api/reports/:id/resolve", async (req, res) => {
  const currentUser = (req.body.currentUser || "").toString();
  if (!isSeymoreBeers(currentUser)) {
    res.status(403).json({ error: "Unauthorized. Admin access required." });
    return;
  }
  const { id } = req.params;
  const reports = await getAllReports();
  const report = reports.find((r) => r.id === id);
  if (!report) {
    res.status(404).json({ error: "Report not found." });
    return;
  }
  report.status = "resolved";
  await saveReport(report);
  res.json({ status: "resolved", report });
});

// DELETE User Profile and clean up their beer logs
app.delete("/api/users/:username", async (req, res) => {
  const { username } = req.params;
  const currentUser = (req.query.currentUser || req.headers["x-current-user"] || "").toString();
  const isAdmin = isSeymoreBeers(currentUser);
  const isSelf = currentUser.toLowerCase() === username.toLowerCase();

  if (!isAdmin && !isSelf) {
    res.status(403).json({ error: "Unauthorized. You can only delete your own profile." });
    return;
  }

  // Self-service deletion requires re-entering the account password, since
  // this app has no real session/auth tokens - the password is the only
  // proof of ownership available.
  if (isSelf && !isAdmin) {
    const password = (req.body && req.body.password ? req.body.password : "").toString();
    const allUsers = await getAllUsers();
    const user = allUsers.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) {
      res.status(404).json({ error: "User profile not found" });
      return;
    }
    const userPassword = user.password || "Pints!";
    if (!verifyPassword(password, userPassword)) {
      res.status(401).json({ error: "Incorrect password. Please re-enter your password to confirm account deletion." });
      return;
    }
  }

  const deleted = await deleteUser(username);
  if (!deleted) {
    res.status(404).json({ error: "User profile not found" });
    return;
  }
  res.json({ success: true, username });
});

// GET Pubs
app.get("/api/pubs", async (req, res) => {
  const list = await getAllPubs();
  res.json(list);
});

// GET Pub Chat Messages
app.get("/api/pubs/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.json([]);
      return;
    }
    const list = await getPubMessages(id);
    res.json(list || []);
  } catch (err) {
    console.error(`Error fetching pub messages for ${req.params.id}:`, err);
    res.status(500).json({ error: "Failed to fetch pub messages" });
  }
});

// POST Pub Chat Message
app.post("/api/pubs/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const user = (req.body.user || req.body.username || "").toString().trim();
    const text = (req.body.text || "").toString().trim();
    const targetUsernames: string[] | undefined = Array.isArray(req.body.targetUsernames)
      ? req.body.targetUsernames.map((u: any) => String(u).trim()).filter(Boolean)
      : undefined;

    if (!user || !text) {
      res.status(400).json({ error: "User and message text are required." });
      return;
    }

    const msg: PubChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      pubId: id,
      user,
      text,
      date: new Date().toISOString(),
    };

    const saved = await savePubChatMessage(msg);

    // Dispatch notifications. A beacon with an explicit invite list notifies exactly
    // those people - which may include friends who aren't pub members, since the
    // point is inviting people out, not just alerting the existing roster. Anything
    // else (an ordinary chat message, or a beacon with no explicit list) notifies the
    // whole pub roster same as before.
    try {
      const allPubsList = await getAllPubs();
      const pub = allPubsList.find((p) => p.id === id);
      if (pub) {
        const isBeacon = text.includes("BEACONS ARE LIT") || text.toLowerCase().includes("beacon");
        const userLower = user.toLowerCase().trim();
        const recipients = isBeacon && targetUsernames && targetUsernames.length > 0
          ? targetUsernames.filter((u) => u.toLowerCase().trim() !== userLower)
          : (pub.members || []).filter((m) => m.toLowerCase().trim() !== userLower);

        const safePubName = escapeHtml(pub.name);
        for (const recipient of recipients) {
          if (isBeacon) {
            let locationStr = `in <strong>${safePubName}</strong>`;
            const match = text.match(/BEACONS ARE LIT AT ([^!]+)!/i) || text.match(/lit the beacons at ([^!]+) for/i);
            if (match && match[1]) {
              locationStr = `at <strong>${escapeHtml(match[1].trim())}</strong> (${safePubName})`;
            }
            await createAndDispatchNotification({
              idPrefix: "notif-beacon",
              user: user,
              targetUser: recipient,
              text: `🚨 BEACON LIT ${locationStr}! Pints call for aid! 🍺⚔️`,
              type: "beacon",
            });
          } else {
            const snippet = escapeHtml(text.length > 40 ? text.substring(0, 40) + "..." : text);
            await createAndDispatchNotification({
              idPrefix: "notif-pub-chat",
              user: user,
              targetUser: recipient,
              text: `posted in <strong>${safePubName}</strong>: "${snippet}" 💬`,
              type: "chat",
            });
          }
        }
      }
    } catch (notifErr) {
      console.error("Failed to generate pub message notifications:", notifErr);
    }

    res.status(201).json(saved);
  } catch (err) {
    console.error(`Error saving pub chat message for ${req.params.id}:`, err);
    res.status(500).json({ error: "Failed to save message" });
  }
});

// POST Toggle a reaction on a pub chat message - built for beacon calls ("I'm coming
// by horse/car/bus/...!") but works on any message in the thread.
app.post("/api/pubs/:pubId/messages/:messageId/react", async (req, res) => {
  const { pubId, messageId } = req.params;
  const username = (req.body.username || req.body.user || "").toString().trim();
  const { reactionType } = req.body;

  if (!username) {
    res.status(400).json({ error: "Username is required to react" });
    return;
  }
  if (!reactionType) {
    res.status(400).json({ error: "Reaction type is required" });
    return;
  }

  const messages = await getPubMessages(pubId);
  const msg = messages.find((m) => m.id === messageId);
  if (!msg) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  if (!msg.reactions || typeof msg.reactions !== "object") msg.reactions = {};
  if (!msg.reactions[reactionType] || !Array.isArray(msg.reactions[reactionType])) {
    msg.reactions[reactionType] = [];
  }

  const idx = msg.reactions[reactionType].indexOf(username);
  const isAdding = idx === -1;
  if (isAdding) {
    msg.reactions[reactionType].push(username);
  } else {
    msg.reactions[reactionType].splice(idx, 1);
  }

  const saved = await savePubChatMessage(msg);

  // Let the message's author know someone's responding, same as reacting to a post -
  // but only on adding a reaction, not removing one (nobody needs a notification for
  // "they changed their mind").
  if (isAdding && msg.user.toLowerCase().trim() !== username.toLowerCase().trim()) {
    try {
      const allPubsList = await getAllPubs();
      const pub = allPubsList.find((p) => p.id === pubId);
      const safePubName = escapeHtml(pub?.name || "the Pub");
      const travelLabels: Record<string, string> = {
        horse: "🐎 Horse",
        car: "🚗 Driving",
        bus: "🚌 Bus",
        taxi: "🚕 Taxi",
        bike: "🚲 Bike",
        running: "🏃 Running",
        walking: "🚶 Walking",
        flying: "✈️ Flying",
        here: "📍 Already Here",
        cant_make_it: "❌ Can't Make It",
      };
      const label = travelLabels[reactionType] || escapeHtml(String(reactionType));
      const isDecline = reactionType === "cant_make_it";
      await createAndDispatchNotification({
        idPrefix: "notif-beacon-react",
        user: username,
        targetUser: msg.user,
        text: isDecline
          ? `won't make it to your call in <strong>${safePubName}</strong>. ${label}`
          : `is coming to your call in <strong>${safePubName}</strong>: <strong>${label}</strong>! 🍻`,
        type: "reaction",
      });
    } catch (notifErr) {
      console.error("Failed to generate beacon reaction notification:", notifErr);
    }
  }

  res.json(saved);
});

// POST Create or Update Pub
app.post("/api/pubs", async (req, res) => {
  // The client's edit flow sends "pubId" (not "id") on an update - accept both so an
  // edit actually targets the existing document instead of silently generating a new
  // one every time (pubId = id || `pub-${Date.now()}` with id always undefined for
  // an edit request meant every "update" was really creating an orphaned duplicate).
  const { id, pubId: bodyPubId, name, owner, members, invited, emblem, isPrivate, currentUser } = req.body;
  const resolvedId = (id || bodyPubId || "").toString().trim() || undefined;

  if (!name || !owner) {
    res.status(400).json({ error: "Pub name and owner are required." });
    return;
  }

  let existingPub: Pub | undefined;
  if (resolvedId) {
    const allPubsList = await getAllPubs();
    existingPub = allPubsList.find((p) => p.id === resolvedId);
    if (!existingPub) {
      res.status(404).json({ error: "Pub not found." });
      return;
    }
    // Only the owner can edit an existing Pub's details.
    const requester = (currentUser || owner || "").toString().trim();
    const isOwner = existingPub.owner.toLowerCase().trim() === requester.toLowerCase().trim();
    if (!isOwner && !isSeymoreBeers(requester)) {
      res.status(403).json({ error: "Only the Pub's owner can edit its details." });
      return;
    }
  }

  const pubId = resolvedId || `pub-${Date.now()}`;
  // On an update, any field this request doesn't explicitly include falls back to the
  // existing Pub's value rather than a bare default - savePub()/setDoc() replaces the
  // whole document, so previously omitting members/invited/widgets here would have
  // silently reset a pub's roster and custom widgets on a simple name/emblem edit.
  const pub: Pub = {
    id: pubId,
    name,
    owner: existingPub ? existingPub.owner : owner,
    members: members || (existingPub ? existingPub.members : [owner]),
    invited: invited || (existingPub ? existingPub.invited : []),
    emblem: emblem !== undefined ? emblem : (existingPub ? existingPub.emblem : ""),
    isPrivate: isPrivate !== undefined ? !!isPrivate : !!existingPub?.isPrivate,
    ...(existingPub?.widgets ? { widgets: existingPub.widgets } : {}),
  };

  const saved = await savePub(pub);

  // If there are new invited members, create notifications
  if (invited && invited.length > 0) {
    for (const invitee of invited) {
      await createAndDispatchNotification({
        idPrefix: "notif-pub",
        user: owner,
        targetUser: invitee,
        text: `invited you to join the Pub: "${escapeHtml(name)}"! 🍻`,
        type: "invite",
      });
    }
  }

  res.json(saved);
});

// POST Join Pub
app.post("/api/pubs/:id/join", async (req, res) => {
  const { id } = req.params;
  const username = (req.body.username || req.body.user || "").toString().trim();

  if (!username) {
    res.status(400).json({ error: "Username is required to join a Pub." });
    return;
  }

  const allPubsList = await getAllPubs();
  const pub = allPubsList.find((p) => p.id === id);

  if (!pub) {
    res.status(404).json({ error: "Pub not found" });
    return;
  }

  const usernameLower = username.toLowerCase().trim();
  const isAlreadyMember = pub.members.some((m) => m.toLowerCase().trim() === usernameLower);
  const isInvited = (pub.invited || []).some((u) => u.toLowerCase().trim() === usernameLower);

  // Private pubs can't be joined by just knowing the ID - an actual invite is required.
  if (pub.isPrivate && !isAlreadyMember && !isInvited) {
    res.status(403).json({ error: "This Pub is private - you need an invite from the owner to join." });
    return;
  }

  // Add to members if not already
  if (!isAlreadyMember) {
    pub.members.push(username);
  }

  // Remove from invited
  pub.invited = pub.invited.filter((u) => u !== username);

  const saved = await savePub(pub);

  // Notify members of the pub only (excluding the person who joined) saying they have entered the pub, who is buying the first round
  for (const member of pub.members) {
    if (member.toLowerCase().trim() === username.toLowerCase().trim()) {
      continue;
    }
    await createAndDispatchNotification({
      idPrefix: `notif-pub-join-${pub.id}-${member.toLowerCase().trim()}`,
      user: username,
      targetUser: member,
      text: `has entered ${escapeHtml(pub.name)}! Who's buying the first round? 🍻`,
    });
  }

  res.json(saved);
});

// POST Decline Pub Invite - the other half of a pub invite acting like a friend
// request: accepting is just joining (above), declining removes the invite without
// ever making the person a member.
app.post("/api/pubs/:id/decline", async (req, res) => {
  const { id } = req.params;
  const username = (req.body.username || req.body.user || "").toString().trim();

  if (!username) {
    res.status(400).json({ error: "Username is required to decline an invite." });
    return;
  }

  const allPubsList = await getAllPubs();
  const pub = allPubsList.find((p) => p.id === id);
  if (!pub) {
    res.status(404).json({ error: "Pub not found" });
    return;
  }

  const usernameLower = username.toLowerCase().trim();
  pub.invited = (pub.invited || []).filter((u) => u.toLowerCase().trim() !== usernameLower);
  const saved = await savePub(pub);
  res.json(saved);
});

// POST Invite to Pub
app.post("/api/pubs/:id/invite", async (req, res) => {
  const { id } = req.params;
  const { invitees, sender } = req.body; // array of usernames

  if (!invitees || !Array.isArray(invitees)) {
    res.status(400).json({ error: "Invitees list is required and must be an array." });
    return;
  }

  const allPubsList = await getAllPubs();
  const pub = allPubsList.find((p) => p.id === id);

  if (!pub) {
    res.status(404).json({ error: "Pub not found" });
    return;
  }

  let updated = false;
  for (const invitee of invitees) {
    if (!pub.members.includes(invitee) && !pub.invited.includes(invitee)) {
      pub.invited.push(invitee);
      updated = true;

      // Send invite notification
      await createAndDispatchNotification({
        idPrefix: "notif-pub-invite",
        user: sender || pub.owner,
        targetUser: invitee,
        text: `invited you to join the Pub: "${escapeHtml(pub.name)}"! 🍻`,
        type: "invite",
      });
    }
  }

  if (updated) {
    await savePub(pub);
  }

  res.json(pub);
});

// POST Leave Pub
// POST Update a Pub's customizable Awards-tab widgets (any member can customize)
const VALID_WIDGET_TYPES: PubWidgetType[] = ["beverage-gauge", "abv-gauge", "rating-gauge", "goblin-mode", "dart-matrix"];
app.post("/api/pubs/:id/widgets", async (req, res) => {
  const { id } = req.params;
  const currentUser = (req.body.currentUser || "").toString().trim();
  const widgetsInput = req.body.widgets;

  if (!currentUser) {
    res.status(400).json({ error: "currentUser is required." });
    return;
  }
  if (!Array.isArray(widgetsInput)) {
    res.status(400).json({ error: "widgets must be an array." });
    return;
  }

  const allPubsList = await getAllPubs();
  const pub = allPubsList.find((p) => p.id === id);
  if (!pub) {
    res.status(404).json({ error: "Pub not found" });
    return;
  }

  const isMember = pub.members.some((m) => m.toLowerCase() === currentUser.toLowerCase());
  if (!isMember && !isSeymoreBeers(currentUser)) {
    res.status(403).json({ error: "Only pub members can customize this Pub's widgets." });
    return;
  }

  if (widgetsInput.length > 6) {
    res.status(400).json({ error: "A Pub can have at most 6 widgets." });
    return;
  }

  const cleanWidgets: PubWidgetConfig[] = [];
  for (const w of widgetsInput) {
    const type = (w?.type || "").toString();
    if (!VALID_WIDGET_TYPES.includes(type as PubWidgetType)) continue;
    const label = (w?.label || "").toString().trim().slice(0, 40) || "Custom Widget";
    const keyword = w?.keyword ? w.keyword.toString().trim().slice(0, 30) : undefined;
    if (type === "beverage-gauge" && !keyword) continue; // beverage gauge requires a keyword
    cleanWidgets.push({
      id: (w?.id || `widget-${Date.now()}-${cleanWidgets.length}`).toString().slice(0, 60),
      type: type as PubWidgetType,
      label,
      ...(keyword ? { keyword } : {}),
    });
  }

  pub.widgets = cleanWidgets;
  const saved = await savePub(pub);
  res.json(saved);
});

// POST Update Pub Privacy - owner only, since this controls who can get in
app.post("/api/pubs/:id/privacy", async (req, res) => {
  const { id } = req.params;
  const currentUser = (req.body.currentUser || "").toString().trim();
  const isPrivate = !!req.body.isPrivate;

  if (!currentUser) {
    res.status(400).json({ error: "currentUser is required." });
    return;
  }

  const allPubsList = await getAllPubs();
  const pub = allPubsList.find((p) => p.id === id);
  if (!pub) {
    res.status(404).json({ error: "Pub not found" });
    return;
  }

  const isOwner = pub.owner.toLowerCase().trim() === currentUser.toLowerCase().trim();
  if (!isOwner && !isSeymoreBeers(currentUser)) {
    res.status(403).json({ error: "Only the Pub's owner can change its privacy setting." });
    return;
  }

  pub.isPrivate = isPrivate;
  const saved = await savePub(pub);
  res.json(saved);
});

app.post("/api/pubs/:id/leave", async (req, res) => {
  const { id } = req.params;
  const username = (req.body.username || req.body.user || "").toString().trim();

  if (!username) {
    res.status(400).json({ error: "Username is required to leave a Pub." });
    return;
  }

  const allPubsList = await getAllPubs();
  const pub = allPubsList.find((p) => p.id === id);

  if (!pub) {
    res.status(404).json({ error: "Pub not found" });
    return;
  }

  // Remove from members
  pub.members = pub.members.filter((u) => u !== username);

  let saved;
  if (pub.members.length === 0) {
    // Delete if no members left
    await deletePub(id);
    saved = { deleted: true, id };
  } else {
    // If owner left, assign new owner
    if (pub.owner === username) {
      pub.owner = pub.members[0];
    }
    saved = await savePub(pub);
  }

  res.json(saved);
});

// DELETE Pub
app.delete("/api/pubs/:id", async (req, res) => {
  const { id } = req.params;
  const currentUser = req.query.currentUser || req.headers["x-current-user"];

  const allPubsList = await getAllPubs();
  const pub = allPubsList.find((p) => p.id === id);

  if (!pub) {
    res.status(404).json({ error: "Pub not found" });
    return;
  }

  // Check permission (owner or Admin Seymore Beers)
  if (pub.owner !== currentUser && !isSeymoreBeers(currentUser as string)) {
    res.status(403).json({ error: "Unauthorized. Only the owner or an Admin can delete a Pub." });
    return;
  }

  await deletePub(id);
  res.json({ success: true, id });
});


// --- VITE INTERFACE HANDLER ---

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    
    // Background seeding if empty
    try {
      getFirestoreInstance();
      if (useFirestore) {
        seedFirestoreIfEmpty().catch((err) => console.error("Error seeding firestore:", err));
      }
    } catch (err) {
      console.error("Failed to seed firestore on start:", err);
    }
  });
}

startServer();
