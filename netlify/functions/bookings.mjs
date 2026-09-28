import { getStore } from "@netlify/blobs";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "paddleground2026admin";
const COURT_COUNT = 3;
// How long a customer's selected slots stay reserved while they check out.
const LOCK_MS = 10 * 60 * 1000;
// Super admin (site owner's billing view). Disabled until SUPER_ADMIN_PASSWORD is set in Netlify.
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || "";
const COMMISSION_PER_HOUR = Number(process.env.COMMISSION_PER_HOUR || 10);
const TEXT_KEYS = ["siteTitle", "phone", "pricePerHour", "heroTitle", "heroSub1", "heroSub2", "heroCta", "heroCtaSub", "heroLocation",
  "topbarName", "topbarSub", "topbarTagline", "rulesTitle", "rulesSubtitle", "rulesIntro",
  "rule1Title", "rule1Body", "rule2Title", "rule2Body", "rule3Title", "rule3Body", "rule4Title", "rule4Body",
  "rule5Title", "rule5Body", "rule6Title", "rule6Body", "bookingHeading", "bookingSubheading", "noticeTitle", "noticeBody",
  "payTitle", "gcashNumber", "gcashName", "payHint", "successTitle", "successMessage", "footerHours", "footerCopyright"];
const SOCIAL_KEYS = ["facebook", "instagram", "tiktok", "messenger", "youtube", "website", "maps"];
const DEFAULT_PRICE_PER_HOUR = 250;

async function getPricePerHour(store) {
  const saved = await store.get("settings_text", { type: "json" });
  const p = Number(saved && saved.text && saved.text.pricePerHour);
  return p > 0 ? p : DEFAULT_PRICE_PER_HOUR;
}

// Where a transaction came from: "online" (customer checkout), "walkin" (admin-added
// customer), "private" (admin internal/private session) or "open_play".
// Older open play bookings were saved as type "customer" with an "[Open Play]" name.
const BILLABLE_SOURCES = ["online", "walkin"];
function bookingSource(b) {
  if (b.type === "open_play" || (b.type === "customer" && b.bookedByAdmin && String(b.name).startsWith("[Open Play]"))) return "open_play";
  if (b.type === "internal") return "private";
  return b.bookedByAdmin ? "walkin" : "online";
}

// "YYYY-MM" in Philippine time
function manilaMonth(iso) {
  return new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 7);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Content-Type": "application/json",
  };
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function normCourt(c) {
  const n = Number(c);
  return Number.isInteger(n) && n >= 1 && n <= COURT_COUNT ? n : null;
}
// Bookings made before courts existed belong to Court 1.
function courtOf(d) {
  return normCourt(d.court) || 1;
}
// A block without a court closes every court.
function courtsOf(d) {
  if (d.type === "block" && !normCourt(d.court)) return Array.from({ length: COURT_COUNT }, (_, i) => i + 1);
  return [courtOf(d)];
}

// Every booking, block and checkout lock, loaded once per request.
async function loadEntries(store) {
  const keys = (await store.list()).blobs.map(b => b.key)
    .filter(k => k.startsWith("booking_") || k.startsWith("block_") || k.startsWith("lock_"));
  const entries = await Promise.all(keys.map(async key => ({ key, data: await store.get(key, { type: "json" }) })));
  return entries.filter(e => e.data);
}

// Lock order: earlier createdAt wins, ties broken by token.
function lockIsEarlier(a, b) {
  return a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.token < b.token);
}

// Time ranges on one date and court that can't be booked: confirmed bookings, blocks,
// and unexpired checkout locks held by other customers. With `lockBefore`, only locks
// created before that lock count, so the earlier of two racing checkouts keeps the slot.
function occupiedRanges(entries, date, court, { excludeKey = null, lockToken = null, lockBefore = null } = {}) {
  const now = Date.now();
  return entries
    .filter(({ key, data: d }) => {
      if (key === excludeKey || d.date !== date) return false;
      if (key.startsWith("lock_")) {
        if (d.court !== court || d.expiresAt <= now || (lockToken && d.token === lockToken)) return false;
        return !lockBefore || lockIsEarlier(d, lockBefore);
      }
      if (d.status === "cancelled" || d.status === "on_hold") return false;
      return courtsOf(d).includes(court);
    })
    .map(({ key, data: d }) => ({ start: d.startHour, end: d.endHour, locked: key.startsWith("lock_") }));
}

function findConflict(ranges, startHour, endHour) {
  return ranges.find(r => startHour < r.end && endHour > r.start) || null;
}

function conflictMessage(conflict, fallback) {
  return conflict.locked
    ? "Another customer is checking out this slot right now. Please pick a different time or court, or try again in a few minutes."
    : fallback;
}

function validRange(startHour, endHour) {
  return Number.isFinite(startHour) && Number.isFinite(endHour) && startHour >= 0 && endHour <= 24 && endHour > startHour;
}

export default async function handler(req, context) {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders() });
  }

  const store = getStore({ name: "bookings", consistency: "strong" });
  const url = new URL(req.url);
  const path = url.pathname
    .replace(/^\/api\/bookings/, "")
    .replace(/^\/.netlify\/functions\/bookings/, "");
  const segments = path.split("/").filter(Boolean);
  const action = segments[0];

  try {

    // GET list
    if (req.method === "GET" && !action) {
      const month = url.searchParams.get("month");
      const allKeys = await store.list();
      const keys = allKeys.blobs
        .map(b => b.key)
        .filter(k => k.startsWith("booking_") || k.startsWith("block_"));
      const items = await Promise.all(keys.map(k => store.get(k, { type: "json" })));
      const bookings = items
        .filter(data => data && (!month || data.date.startsWith(month)))
        .map(data => {
          const { paymentData, ...safeData } = data;
          safeData.hasPayment = !!paymentData;
          return safeData;
        });
      bookings.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.startHour - b.startHour;
      });
      return new Response(JSON.stringify({ bookings }), { headers: corsHeaders() });
    }

    // POST /verify - check admin password
    if (req.method === "POST" && action === "verify") {
      const body = await req.json();
      if (body.adminPassword !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Invalid password" }), { status: 401, headers: corsHeaders() });
      }
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders() });
    }

    // POST /cleanup-storage - admin only - strips stored receipt images to free storage
    // Body options: { olderThanDays: 14 } to age-filter, { ids: ["id1","id2"] } for selective delete,
    // or neither to strip all base64 images (legacy cleanup).
    if (req.method === "POST" && action === "cleanup-storage") {
      const body = await req.json();
      if (body.adminPassword !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const { olderThanDays, ids } = body;
      const cutoffMs = olderThanDays ? olderThanDays * 24 * 60 * 60 * 1000 : null;
      const now = Date.now();
      const allKeys = await store.list();
      const keys = allKeys.blobs.map(b => b.key).filter(k => k.startsWith("booking_") || k.startsWith("block_"));
      let cleaned = 0;
      for (const key of keys) {
        const item = await store.get(key, { type: "json" });
        if (!item || !item.paymentData) continue;
        if (ids && ids.length > 0 && !ids.includes(item.id)) continue;
        if (cutoffMs && (now - new Date(item.createdAt).getTime()) < cutoffMs) continue;
        if (!ids && !cutoffMs && !item.paymentData.startsWith("data:")) continue;
        await store.setJSON(key, { ...item, paymentData: null, paymentDataCleaned: true });
        cleaned++;
      }
      return new Response(JSON.stringify({ success: true, cleaned }), { headers: corsHeaders() });
    }

    // GET /locks?month=YYYY-MM - public. Slots other customers are checking out right now.
    // ?exclude=<token> leaves out the caller's own lock.
    if (req.method === "GET" && action === "locks") {
      const month = url.searchParams.get("month");
      const exclude = url.searchParams.get("exclude");
      const now = Date.now();
      const keys = (await store.list({ prefix: "lock_" })).blobs.map(b => b.key);
      const items = await Promise.all(keys.map(k => store.get(k, { type: "json" })));
      const locks = items
        .filter(l => l && l.expiresAt > now && l.token !== exclude && (!month || l.date.startsWith(month)))
        .map(l => ({ date: l.date, court: l.court, startHour: l.startHour, endHour: l.endHour }));
      return new Response(JSON.stringify({ locks, serverNow: now }), { headers: corsHeaders() });
    }

    // POST /lock/release - customer cancelled checkout, ran out of time, or finished booking.
    if (req.method === "POST" && action === "lock" && segments[1] === "release") {
      const body = await req.json().catch(() => ({}));
      const token = typeof body.token === "string" && /^[a-z0-9]{10,60}$/i.test(body.token) ? body.token : null;
      if (token) {
        const keys = (await store.list({ prefix: `lock_${token}_` })).blobs.map(b => b.key);
        await Promise.all(keys.map(k => store.delete(k)));
      }
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders() });
    }

    // POST /lock - customer clicked "Book Now". Reserves the selected slots for 10 minutes
    // so nobody else can book them during checkout. Body: { items: [{date, court, startHour, endHour}] }
    if (req.method === "POST" && action === "lock" && !segments[1]) {
      const body = await req.json();
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length || items.length > 60) {
        return new Response(JSON.stringify({ error: "Select at least one time slot." }), { status: 400, headers: corsHeaders() });
      }
      const clean = [];
      for (const it of items) {
        const court = normCourt(it.court);
        const startHour = Number(it.startHour), endHour = Number(it.endHour);
        if (!court || typeof it.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(it.date) || !validRange(startHour, endHour)) {
          return new Response(JSON.stringify({ error: "Invalid time slot." }), { status: 400, headers: corsHeaders() });
        }
        clean.push({ date: it.date, court, startHour, endHour });
      }
      let entries = await loadEntries(store);
      // Housekeeping: drop locks that expired more than a minute ago.
      const now = Date.now();
      const stale = entries.filter(e => e.key.startsWith("lock_") && e.data.expiresAt < now - 60000);
      await Promise.all(stale.map(e => store.delete(e.key)));
      entries = entries.filter(e => !stale.includes(e));

      const conflicts = clean.filter(it => findConflict(occupiedRanges(entries, it.date, it.court), it.startHour, it.endHour));
      if (conflicts.length) {
        return new Response(JSON.stringify({ error: "Some of your selected slots were just taken. Please choose again.", conflicts }), { status: 409, headers: corsHeaders() });
      }
      const token = generateId() + generateId();
      const createdAt = Date.now();
      const expiresAt = createdAt + LOCK_MS;
      await Promise.all(clean.map((it, i) => store.setJSON(`lock_${token}_${i}`, { ...it, token, createdAt, expiresAt })));

      // Two customers can pass the check above at the same moment. Re-check against
      // everything saved since: if an earlier lock or a booking overlaps, give way.
      entries = await loadEntries(store);
      const self = { token, createdAt };
      const lost = clean.filter(it => findConflict(
        occupiedRanges(entries, it.date, it.court, { lockToken: token, lockBefore: self }), it.startHour, it.endHour));
      if (lost.length) {
        await Promise.all(clean.map((_, i) => store.delete(`lock_${token}_${i}`)));
        return new Response(JSON.stringify({ error: "Some of your selected slots were just taken. Please choose again.", conflicts: lost }), { status: 409, headers: corsHeaders() });
      }
      return new Response(JSON.stringify({ token, expiresAt, serverNow: Date.now() }), { status: 201, headers: corsHeaders() });
    }

    // POST /block  - admin creates a block. Without a court, it closes all courts.
    if (req.method === "POST" && action === "block") {
      const body = await req.json();
      const { adminPassword, date, startHour, endHour, reason } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      if (!date || startHour === undefined || endHour === undefined) {
        return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: corsHeaders() });
      }
      const court = normCourt(body.court);
      const entries = await loadEntries(store);
      for (const c of court ? [court] : courtsOf({ type: "block" })) {
        const conflict = findConflict(occupiedRanges(entries, date, c), startHour, endHour);
        if (conflict) {
          return new Response(JSON.stringify({ error: conflictMessage(conflict, `Court ${c}: time slot conflict with an existing booking or block.`) }), { status: 409, headers: corsHeaders() });
        }
      }
      const id = generateId();
      const block = {
        id,
        type: "block",
        name: reason ? `[Blocked] ${reason}` : "[Internal Block]",
        phone: "—",
        date,
        court,
        startHour,
        endHour,
        status: "confirmed",
        reason: reason || "",
        createdAt: new Date().toISOString(),
        notes: reason || "",
      };
      await store.setJSON(`block_${id}`, block);
      return new Response(JSON.stringify({ block }), { status: 201, headers: corsHeaders() });
    }

    // DELETE /block/:id  - admin removes a block permanently
    if (req.method === "DELETE" && action === "block") {
      const blockId = segments[1];
      const body = await req.json();
      if (body.adminPassword !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const existing = await store.get(`block_${blockId}`, { type: "json" });
      if (!existing) {
        return new Response(JSON.stringify({ error: "Block not found" }), { status: 404, headers: corsHeaders() });
      }
      await store.delete(`block_${blockId}`);
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders() });
    }

    // POST / - customer creates booking
    if (req.method === "POST" && !action) {
      const body = await req.json();
      const { name, phone, date, startHour, endHour, paymentData, paymentType, type: bookingType, adminPassword, addedByName, txnId: rawTxnId, lockToken } = body;
      if (!name || !phone || !date || startHour === undefined || endHour === undefined) {
        return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers: corsHeaders() });
      }
      const isAdmin = adminPassword === ADMIN_PASSWORD;
      // Admin bookings saved without a court go to Court 1, like bookings from before courts existed.
      const court = normCourt(body.court) || (isAdmin || body.court === undefined ? 1 : null);
      if (!court) {
        return new Response(JSON.stringify({ error: "Please choose a court." }), { status: 400, headers: corsHeaders() });
      }
      // The customer's own checkout lock doesn't count against them.
      const entries = await loadEntries(store);
      const conflict = findConflict(occupiedRanges(entries, date, court, { lockToken: typeof lockToken === "string" ? lockToken : null }), startHour, endHour);
      if (conflict) {
        return new Response(JSON.stringify({ error: conflictMessage(conflict, `Court ${court} is already booked at that time. Please choose different hours.`) }), { status: 409, headers: corsHeaders() });
      }
      const id = generateId();
      // Bookings made in one checkout share a txnId, so the report can group them.
      const txnId = typeof rawTxnId === "string" && /^[a-z0-9]{6,40}$/i.test(rawTxnId) ? rawTxnId : id;
      const rate = await getPricePerHour(store);
      const booking = {
        id,
        type: bookingType === "internal" || bookingType === "open_play" ? bookingType : "customer",
        name: name.trim(),
        phone: phone.trim(),
        email: typeof body.email === "string" ? body.email.trim().slice(0, 120) : "",
        date,
        court,
        startHour,
        endHour,
        paymentData: paymentData || null,
        paymentType: paymentType || null,
        status: "confirmed",
        createdAt: new Date().toISOString(),
        notes: body.notes || "",
        bookedByAdmin: isAdmin,
        addedByName: isAdmin && addedByName ? String(addedByName).trim().slice(0, 80) : null,
        txnId,
        rate,
      };
      await store.setJSON(`booking_${id}`, booking);
      // Commission ledger: a record the client's admin endpoints never edit or delete,
      // so billing still sees transactions whose bookings were later deleted.
      const ledgerKey = `ledger_${txnId}`;
      const ledger = (await store.get(ledgerKey, { type: "json" })) || {
        txnId, createdAt: booking.createdAt, name: booking.name, phone: booking.phone,
        type: booking.type, bookedByAdmin: isAdmin, items: [],
      };
      ledger.items.push({ id, date, court, startHour, endHour, rate });
      await store.setJSON(ledgerKey, ledger);
      const { paymentData: _, ...safeBooking } = booking;
      safeBooking.hasPayment = !!paymentData;
      return new Response(JSON.stringify({ booking: safeBooking }), { status: 201, headers: corsHeaders() });
    }

    // GET /settings - public
    if (req.method === "GET" && action === "settings") {
      let settings = await store.get("settings_main", { type: "json" });
      if (!settings) settings = { customerOpenHour: 13, customerCloseHour: 23 };
      return new Response(JSON.stringify({ settings }), { headers: corsHeaders() });
    }

    // POST /settings - admin only
    if (req.method === "POST" && action === "settings") {
      const body = await req.json();
      if (body.adminPassword !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const { customerOpenHour, customerCloseHour } = body;
      const settings = { customerOpenHour: Number(customerOpenHour), customerCloseHour: Number(customerCloseHour) };
      await store.setJSON("settings_main", settings);
      return new Response(JSON.stringify({ settings }), { headers: corsHeaders() });
    }

    // GET /banner - public
    if (req.method === "GET" && action === "banner") {
      let banner = await store.get("settings_banner", { type: "json" });
      if (!banner) banner = { active: false, imageData: null, link: "" };
      return new Response(JSON.stringify({ banner }), { headers: corsHeaders() });
    }

    // POST /banner - admin only
    if (req.method === "POST" && action === "banner") {
      const body = await req.json();
      if (body.adminPassword !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const { active, imageData, link } = body;
      const banner = { active: !!active, imageData: imageData || null, link: link || "" };
      await store.setJSON("settings_banner", banner);
      return new Response(JSON.stringify({ banner }), { headers: corsHeaders() });
    }

    // GET /hero-settings - public
    if (req.method === "GET" && action === "hero-settings") {
      let settings = await store.get("settings_hero", { type: "json" });
      if (!settings) settings = { mode: "carousel", useCustomImages: false, images: [] };
      return new Response(JSON.stringify({ settings }), { headers: corsHeaders() });
    }

    // POST /hero-settings - admin only
    if (req.method === "POST" && action === "hero-settings") {
      const body = await req.json();
      if (body.adminPassword !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const { mode, images, useCustomImages } = body;
      const settings = { mode: mode || "carousel", images: images || [], useCustomImages: !!useCustomImages };
      await store.setJSON("settings_hero", settings);
      return new Response(JSON.stringify({ settings }), { headers: corsHeaders() });
    }

    // GET /site-images - public
    if (req.method === "GET" && action === "site-images") {
      const images = (await store.get("settings_images", { type: "json" })) || {};
      return new Response(JSON.stringify({ images }), { headers: corsHeaders() });
    }

    // POST /site-images - admin only. Only the keys sent are changed;
    // an image key set to null resets that image to the site default.
    if (req.method === "POST" && action === "site-images") {
      const body = await req.json();
      if (body.adminPassword !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const current = (await store.get("settings_images", { type: "json" })) || {};
      const updates = body.images || {};
      const isImage = v => typeof v === "string" && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);
      for (const key of ["logo", "background", "qr", "ctaIcon"]) {
        if (!(key in updates)) continue;
        if (updates[key] === null) { delete current[key]; continue; }
        if (!isImage(updates[key])) {
          return new Response(JSON.stringify({ error: `Invalid image for ${key}` }), { status: 400, headers: corsHeaders() });
        }
        current[key] = updates[key];
      }
      if ("backgroundHidden" in updates) current.backgroundHidden = !!updates.backgroundHidden;
      if ("backgroundOpacity" in updates) {
        const o = Number(updates.backgroundOpacity);
        if (Number.isFinite(o)) current.backgroundOpacity = Math.min(0.5, Math.max(0, o));
      }
      await store.setJSON("settings_images", current);
      return new Response(JSON.stringify({ images: current }), { headers: corsHeaders() });
    }

    // GET /site-text - public
    if (req.method === "GET" && action === "site-text") {
      const saved = (await store.get("settings_text", { type: "json" })) || {};
      return new Response(JSON.stringify({ text: saved.text || {}, social: saved.social || {} }), { headers: corsHeaders() });
    }

    // POST /site-text - admin only. Replaces all text overrides and social links.
    if (req.method === "POST" && action === "site-text") {
      const body = await req.json();
      if (body.adminPassword !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const text = {};
      for (const key of TEXT_KEYS) {
        const v = body.text && body.text[key];
        if (typeof v === "string") text[key] = v.slice(0, 2000);
      }
      if ("pricePerHour" in text) {
        const p = Number(text.pricePerHour);
        if (!(p > 0 && p < 100000)) {
          return new Response(JSON.stringify({ error: "Price per hour must be a number above 0." }), { status: 400, headers: corsHeaders() });
        }
        text.pricePerHour = String(p);
      }
      const social = {};
      for (const key of SOCIAL_KEYS) {
        const v = body.social && typeof body.social[key] === "string" ? body.social[key].trim() : "";
        if (!v) continue;
        if (!/^https?:\/\/[^\s"'<>]+$/i.test(v)) {
          return new Response(JSON.stringify({ error: `The ${key} link must start with https://` }), { status: 400, headers: corsHeaders() });
        }
        social[key] = v.slice(0, 500);
      }
      await store.setJSON("settings_text", { text, social });
      return new Response(JSON.stringify({ text, social }), { headers: corsHeaders() });
    }

    // POST /super-report - super admin only. Transactions made in a month (Philippine time)
    // with their bookings, and the commission owed.
    if (req.method === "POST" && action === "super-report") {
      const body = await req.json();
      if (!SUPER_ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Super admin is not set up. Add SUPER_ADMIN_PASSWORD in Netlify environment variables." }), { status: 503, headers: corsHeaders() });
      }
      if (body.superPassword !== SUPER_ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Invalid password" }), { status: 401, headers: corsHeaders() });
      }
      const month = typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month) ? body.month : null;
      if (!month) {
        return new Response(JSON.stringify({ error: "Month required (YYYY-MM)" }), { status: 400, headers: corsHeaders() });
      }
      const allKeys = (await store.list()).blobs.map(b => b.key);
      const bookings = (await Promise.all(allKeys.filter(k => k.startsWith("booking_")).map(k => store.get(k, { type: "json" })))).filter(Boolean);
      const ledgers = (await Promise.all(allKeys.filter(k => k.startsWith("ledger_")).map(k => store.get(k, { type: "json" })))).filter(Boolean);

      const txns = new Map();
      const txnFor = (key, seed) => {
        if (!txns.has(key)) txns.set(key, { txnId: key, createdAt: seed.createdAt, name: seed.name, phone: seed.phone,
          source: bookingSource(seed), items: [] });
        return txns.get(key);
      };
      const seen = new Set();
      for (const b of bookings) {
        const t = txnFor(b.txnId || b.id, b);
        if (b.createdAt < t.createdAt) t.createdAt = b.createdAt;
        t.items.push({ id: b.id, date: b.date, startHour: b.startHour, endHour: b.endHour,
          rate: b.rate || DEFAULT_PRICE_PER_HOUR, status: b.status || "confirmed", paymentStatus: b.paymentStatus || null });
        seen.add(b.id);
      }
      // Bookings the admin permanently deleted still appear, from the ledger.
      for (const l of ledgers) {
        // The ledger's record of how the transaction was made wins over later edits.
        if (txns.has(l.txnId)) Object.assign(txns.get(l.txnId), { source: bookingSource(l), createdAt: l.createdAt, name: l.name, phone: l.phone });
        for (const it of l.items || []) {
          if (seen.has(it.id)) continue;
          txnFor(l.txnId, l).items.push({ ...it, status: "deleted" });
        }
      }
      const transactions = [...txns.values()]
        .filter(t => manilaMonth(t.createdAt) === month)
        .map(t => {
          t.items.sort((a, b) => a.date.localeCompare(b.date) || a.startHour - b.startHour);
          const hours = t.items.reduce((s, i) => s + (i.endHour - i.startHour), 0);
          const amount = t.items.reduce((s, i) => s + (i.endHour - i.startHour) * i.rate, 0);
          // Commission is per booked hour, for online bookings and admin-added walk-ins only.
          // Cancelled hours aren't charged; hours the admin permanently deleted still are.
          const billedItems = BILLABLE_SOURCES.includes(t.source) ? t.items.filter(i => i.status !== "cancelled") : [];
          const billedHours = billedItems.reduce((s, i) => s + (i.endHour - i.startHour), 0);
          const billedAmount = billedItems.reduce((s, i) => s + (i.endHour - i.startHour) * i.rate, 0);
          const billable = billedHours > 0;
          return { ...t, hours, amount, billable, billedHours, billedAmount, commission: billedHours * COMMISSION_PER_HOUR };
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const billed = transactions.filter(t => t.billable);
      return new Response(JSON.stringify({
        month, commissionPerHour: COMMISSION_PER_HOUR, transactions,
        totals: {
          transactions: transactions.length, billable: billed.length,
          billedHours: billed.reduce((s, t) => s + t.billedHours, 0),
          commission: billed.reduce((s, t) => s + t.commission, 0),
        },
      }), { headers: corsHeaders() });
    }

    // GET /:id
    if (req.method === "GET" && action) {
      const isAdmin = url.searchParams.get("admin") === ADMIN_PASSWORD;
      let booking = await store.get(`booking_${action}`, { type: "json" });
      if (!booking) booking = await store.get(`block_${action}`, { type: "json" });
      if (!booking) {
        return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders() });
      }
      if (!isAdmin) {
        const { paymentData, ...safeBooking } = booking;
        safeBooking.hasPayment = !!paymentData;
        return new Response(JSON.stringify({ booking: safeBooking }), { headers: corsHeaders() });
      }
      return new Response(JSON.stringify({ booking }), { headers: corsHeaders() });
    }

    // PUT /:id - admin edits
    if (req.method === "PUT" && action) {
      const body = await req.json();
      const { adminPassword, ...updates } = body;
      if (adminPassword !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      let storeKey = `booking_${action}`;
      let existing = await store.get(storeKey, { type: "json" });
      if (!existing) { storeKey = `block_${action}`; existing = await store.get(storeKey, { type: "json" }); }
      if (!existing) {
        return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders() });
      }
      // On-hold bookings don't occupy their slot (see occupiedRanges), so re-validate
      // for conflicts when the time changes, or when un-holding back to confirmed —
      // someone else may have booked that slot in the meantime.
      if ("court" in updates) {
        updates.court = normCourt(updates.court);
        if (!updates.court && existing.type !== "block") {
          return new Response(JSON.stringify({ error: "Please choose a court." }), { status: 400, headers: corsHeaders() });
        }
      }
      const becomingConfirmed = updates.status === "confirmed" && existing.status !== "confirmed";
      if (updates.date || updates.startHour !== undefined || updates.endHour !== undefined || "court" in updates || becomingConfirmed) {
        const newDate = updates.date || existing.date;
        const newStart = updates.startHour !== undefined ? updates.startHour : existing.startHour;
        const newEnd = updates.endHour !== undefined ? updates.endHour : existing.endHour;
        const entries = await loadEntries(store);
        for (const c of courtsOf({ ...existing, ...updates })) {
          const conflict = findConflict(occupiedRanges(entries, newDate, c, { excludeKey: storeKey }), newStart, newEnd);
          if (conflict) {
            return new Response(JSON.stringify({ error: conflictMessage(conflict, `Court ${c}: time slot conflict. Someone else may have booked this slot while it was on hold.`) }), { status: 409, headers: corsHeaders() });
          }
        }
      }
      const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
      await store.setJSON(storeKey, updated);
      const { paymentData, ...safeBooking } = updated;
      safeBooking.hasPayment = !!paymentData;
      return new Response(JSON.stringify({ booking: safeBooking }), { headers: corsHeaders() });
    }

    // DELETE /:id - cancel (soft) or permanently delete booking/block
    if (req.method === "DELETE" && action) {
      const body = await req.json();
      if (body.adminPassword !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      let storeKey = `booking_${action}`;
      let existing = await store.get(storeKey, { type: "json" });
      if (!existing) { storeKey = `block_${action}`; existing = await store.get(storeKey, { type: "json" }); }
      if (!existing) {
        return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders() });
      }
      if (body.hardDelete) {
        await store.delete(storeKey);
      } else {
        const cancelled = { ...existing, status: "cancelled", cancelledAt: new Date().toISOString() };
        await store.setJSON(storeKey, cancelled);
      }
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders() });
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders() });

  } catch (err) {
    console.error("Booking API error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: corsHeaders() });
  }
}

export const config = {
  path: ["/api/bookings", "/api/bookings/*"],
};
