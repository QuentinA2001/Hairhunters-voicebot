import fs from "fs";
import path from "path";
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import https from "https";
import { v4 as uuidv4 } from "uuid";
import "dotenv/config";

// ✅ NEW: date parsing add-on
import * as chrono from "chrono-node";
import { DateTime } from "luxon";

const app = express();

// Twilio sends x-www-form-urlencoded by default
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use("/assets", express.static("assets"));
/**
 * Set BASE_URL in Render env vars to your public URL, e.g.
 * https://hairhunters-voicebot.onrender.com
 */
const BASE_URL = process.env.BASE_URL || "";

// ✅ NEW: timezone config (set BOT_TIMEZONE in Render if you want)
const BOT_TZ = process.env.BOT_TIMEZONE || "America/Toronto";

// In-memory stores (OK for MVP; use Redis/S3 for production)
const audioStore = new Map();            // id -> Buffer(mp3)
const conversationStore = new Map();     // callSid -> messages[]
const pendingTurns = new Map();          // token -> { ready, twiml, createdAt, fillerId }
const pendingBookings = new Map();       // callSid -> booking payload waiting for confirm
const lastResolvedDateStore = new Map(); // callSid -> YYYY-MM-DD

// Keep-alive HTTP client (reduces latency)
const httpsAgent = new https.Agent({ keepAlive: true });
const http = axios.create({ httpsAgent, timeout: 12000 });

// Small helper for log redaction
const pick = (v) => (v ? String(v).slice(0, 6) + "…" : "missing");

// ---------- FILLERS (pre-generated ElevenLabs clips) ----------
const fillerText = ["One sec.", "Got it.", "Okay.", "Alright."];
const fillerIds = []; // mp3 ids ready to use

const clipIds = {
  repeat: null, // "Sorry—could you say that again?"
};

function pickFillerId() {
  if (!fillerIds.length) return null;
  return fillerIds[Math.floor(Math.random() * fillerIds.length)];
}

// ---------- PROMPT ----------
const SYSTEM_PROMPT = `
Your name is Alex. You are a warm, confident, mature, phone receptionist for ${process.env.SALON_NAME || "the salon"} in ${process.env.SALON_CITY || "the city"}.

Tasks:
- Handle bookings/reschedules. Collect: name, phone (Confirm the phone number after they say it), service (haircut/colour/cut & colour), stylist (Cosmo, Vince, Cassidy), and day/time window.
- Do NOT ask for email.
- Assume timezone America/Toronto unless otherwise specified.
- Convert natural language like "Tuesday at 4" into ISO 8601 with timezone offset.
- datetime MUST be ISO format like: 2026-02-21T15:00:00-05:00
- Do NOT state the weekday (Monday/Tuesday/etc) unless the caller already said it. (The server will confirm weekday.)
- Keep replies SHORT (1–2 sentences). Ask ONE question at a time.
- When you say the time back to the caller to confirm, speak in natural language (NOT ISO).
- Phone MUST be digits only (no spaces, no dashes, no words). Example: “9055551234”.
- If the caller says “nine oh five…”, convert to digits.

IMPORTANT:
- Do NOT do calendar math or guess weekdays/dates. If the caller asks “what date is that?”, the server will answer.
- The server may append "(resolved date: YYYY-MM-DD)" or "(resolved datetime: YYYY-MM-DDTHH:mm:ss-05:00)" to caller turns.
- Treat server-resolved date/datetime as ground truth.
- If you only have a day (e.g., "next Tuesday") but no time, ask for the time.

- If caller asks for a human/manager/desk, respond with:
ACTION_JSON: {"action":"transfer"}
(When outputting ACTION_JSON, output ONLY that line.)

- When you have all booking fields, respond with ONLY:
ACTION_JSON: {"action":"book","service":"...","stylist":"...","datetime":"ISO_FORMAT","name":"...","phone":"..."}
`;

// ---------- ELEVENLABS TTS ----------
async function tts(text) {
  const safe = String(text).slice(0, 800);
  const voiceId = process.env.ELEVEN_VOICE_ID;
  const apiKey = process.env.ELEVEN_API_KEY;

  if (!voiceId || !apiKey) {
    const err = new Error("Missing ELEVEN_VOICE_ID or ELEVEN_API_KEY");
    err.code = "ELEVEN_MISSING_ENV";
    throw err;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

  try {
    const resp = await http.post(
      url,
      {
        text: safe,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      },
      {
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        responseType: "arraybuffer",
        timeout: 8000, // keep tight for Twilio stability
      }
    );

    const buf = Buffer.from(resp.data);
    console.log(`✅ ElevenLabs OK | bytes=${buf.length}`);
    return buf;
  } catch (e) {
    console.log("❌ ElevenLabs TTS error", {
      status: e?.response?.status,
      data: e?.response?.data?.toString?.().slice(0, 200),
      voice: voiceId,
      key: pick(apiKey),
    });
    throw e;
  }
}

async function ttsWithRetry(text, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await tts(text);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function ensureClip(kind, text) {
  if (clipIds[kind]) return clipIds[kind];
  const audio = await ttsWithRetry(text);
  const id = uuidv4();
  audioStore.set(id, audio);
  clipIds[kind] = id;
  return id;
}

async function warmFillers() {
  try {
    for (const line of fillerText) {
      const audio = await ttsWithRetry(line);
      const id = uuidv4();
      audioStore.set(id, audio);
      fillerIds.push(id);
    }
    await ensureClip("repeat", "Sorry—could you say that again?");
    console.log(`✅ Warmed fillers: ${fillerIds.length} | repeat clip ready`);
  } catch (e) {
    console.log("⚠️ warmFillers failed (server will still run):", e?.message || e);
  }
}

// ---------- HELPERS ----------
const STYLISTS = ["cosmo", "vince", "cassidy"];
const SERVICES = [
  { key: "cut & colour", patterns: ["cut and colour", "cut & colour", "cut and color", "cut & color"] },
  { key: "haircut", patterns: ["haircut", "trim", "cut"] },
  { key: "colour", patterns: ["colour", "color", "dye"] },
];
const WEEKDAY_ALIASES = [
  { weekday: 1, re: /\b(?:mon|monday)\b/ },
  { weekday: 2, re: /\b(?:tue|tues|tuesday)\b/ },
  { weekday: 3, re: /\b(?:wed|wednesday)\b/ },
  { weekday: 4, re: /\b(?:thu|thur|thurs|thursday)\b/ },
  { weekday: 5, re: /\b(?:fri|friday)\b/ },
  { weekday: 6, re: /\b(?:sat|saturday)\b/ },
  { weekday: 7, re: /\b(?:sun|sunday)\b/ },
];
const DATE_WORD_RE =
  /\b(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|today|tomorrow|january|february|march|april|may|june|july|august|september|october|november|december|next|this|coming)\b/;

function extractStylistFromSpeech(text) {
  const t = cleanSpeech(text);
  for (const s of STYLISTS) {
    if (t.includes(s)) return s[0].toUpperCase() + s.slice(1);
  }
  return null;
}

function extractServiceFromSpeech(text) {
  const t = cleanSpeech(text);
  const ranked = SERVICES
    .flatMap((svc) => svc.patterns.map((p) => ({ key: svc.key, pattern: p })))
    .sort((a, b) => b.pattern.length - a.pattern.length);
  for (const item of ranked) {
    if (t.includes(item.pattern)) return item.key;
  }
  return null;
}

function extractTimeOnly(text) {
  const t = cleanSpeech(text);
  if (!t) return null;
  if (/\d{3,}/.test(t)) return null;
  if (DATE_WORD_RE.test(t)) return null;

  const allow = new Set([
    "at", "around", "for", "please", "pls", "ok", "okay", "works", "work", "that", "sounds", "good",
    "yes", "yeah", "yep", "yup", "ya", "y", "no", "nah", "nope", "um", "uh", "thanks", "thank", "you",
  ]);
  const leftoversAllowed = (leftovers) =>
    !leftovers || leftovers.split(/\s+/).every((w) => allow.has(w));

  let m = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) {
    const leftovers = t.replace(m[0], "").trim();
    if (!leftoversAllowed(leftovers)) return null;
    return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
  }

  m = t.match(/\b(1[0-2]|[1-9])(?::([0-5]\d))?\s*(am|pm)?\b/);
  if (!m) return null;
  const leftovers = t.replace(m[0], "").trim();
  if (!leftoversAllowed(leftovers)) return null;

  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3] || null;

  if (!ampm) {
    if (hour >= 1 && hour <= 7) hour += 12;
  } else {
    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
  }

  return { hour, minute };
}

function extractTimeFromSpeech(text) {
  const input = String(text || "").trim();
  if (!input) return null;

  const now = DateTime.now().setZone(BOT_TZ);
  const results = chrono.parse(input, now.toJSDate());
  if (results.length) {
    const kv = results[0]?.start?.knownValues || {};
    if ("hour" in kv || "minute" in kv) {
      const hour = Number(kv.hour ?? 0);
      const minute = Number(kv.minute ?? 0);
      if (!Number.isNaN(hour) && !Number.isNaN(minute)) return { hour, minute };
    }
  }

  return extractTimeOnly(input);
}

function isoToDateOnly(iso) {
  const dt = DateTime.fromISO(String(iso || ""), { zone: BOT_TZ });
  return dt.isValid ? dt.toFormat("yyyy-LL-dd") : null;
}

function isoToTimeOnly(iso) {
  const dt = DateTime.fromISO(String(iso || ""), { zone: BOT_TZ });
  if (!dt.isValid) return null;
  return { hour: dt.hour, minute: dt.minute };
}

function detectWeekday(text) {
  const t = cleanSpeech(text);
  const hit = WEEKDAY_ALIASES.find((d) => d.re.test(t));
  return hit ? hit.weekday : null;
}

function hasForwardWeekdayIntent(text) {
  const t = cleanSpeech(text);
  if (!detectWeekday(t)) return false;
  return (
    /\bnext\b/.test(t) ||
    /\bfollowing\b/.test(t) ||
    /\bweek after\b/.test(t) ||
    /\bafter that\b/.test(t) ||
    /\bone after\b/.test(t)
  );
}

function hasNextWeekOnlyIntent(text) {
  const t = cleanSpeech(text);
  if (detectWeekday(t)) return false;
  return (
    /\bnext week\b/.test(t) ||
    /\bfollowing week\b/.test(t) ||
    /\bweek after\b/.test(t) ||
    /\bthe week after\b/.test(t)
  );
}

function resolveRelativeDayISO(text) {
  const t = cleanSpeech(text);
  const now = DateTime.now().setZone(BOT_TZ).startOf("day");
  if (/\bday after tomorrow\b/.test(t)) return now.plus({ days: 2 }).toFormat("yyyy-LL-dd");
  if (/\btomorrow\b/.test(t)) return now.plus({ days: 1 }).toFormat("yyyy-LL-dd");
  if (/\btoday\b/.test(t)) return now.toFormat("yyyy-LL-dd");
  return null;
}

function resolveUpcomingWeekdayISO(text, opts = {}) {
  const t = cleanSpeech(text);
  const weekday = detectWeekday(t);
  if (!weekday) return null;

  const now = DateTime.now().setZone(BOT_TZ).startOf("day");
  let daysAhead = (weekday - now.weekday + 7) % 7;
  const explicitThis = /\b(this|coming)\b/.test(t);
  if (daysAhead === 0 && !explicitThis) daysAhead = 7;

  let candidate = now.plus({ days: daysAhead });
  const afterDateISO = opts?.afterDateISO || null;
  const afterDate = afterDateISO
    ? DateTime.fromISO(`${afterDateISO}T00:00:00`, { zone: BOT_TZ }).startOf("day")
    : null;

  // If caller says "next Tuesday" while already discussing a Tuesday date,
  // move to the following week relative to that existing date.
  if (afterDate && afterDate.isValid) {
    while (candidate <= afterDate) candidate = candidate.plus({ days: 7 });
  }

  return candidate.toFormat("yyyy-LL-dd");
}

function resolveDateOnlyISO(text, opts = {}) {
  const input = String(text || "").trim();
  if (!input) return null;

  // "next week" should keep same weekday from current booking context.
  if (hasNextWeekOnlyIntent(input) && opts?.afterDateISO) {
    const base = DateTime.fromISO(`${opts.afterDateISO}T00:00:00`, { zone: BOT_TZ }).startOf("day");
    if (base.isValid) return base.plus({ days: 7 }).toFormat("yyyy-LL-dd");
  }
  // Ambiguous "next week" without anchor should not auto-pick a day.
  if (hasNextWeekOnlyIntent(input) && !opts?.afterDateISO) {
    return null;
  }

  const relative = resolveRelativeDayISO(input);
  if (relative) return relative;

  const weekdayDate = resolveUpcomingWeekdayISO(input, opts);
  if (weekdayDate) return weekdayDate;

  const now = DateTime.now().setZone(BOT_TZ);
  const results = chrono.parse(input, now.toJSDate());
  if (!results.length) return null;

  const r = results[0];
  const kv = r?.start?.knownValues || {};
  const hasDateInfo =
    ("weekday" in kv) || ("day" in kv) || ("month" in kv) || ("year" in kv);
  if (!hasDateInfo) return null;

  let dt = DateTime.fromJSDate(r.start.date()).setZone(BOT_TZ);
  const specifiedYear = ("year" in kv);
  if (!specifiedYear && dt < now.startOf("day")) {
    const weekdayOnly = ("weekday" in kv) && !("month" in kv) && !("day" in kv);
    const monthDay = ("month" in kv) && ("day" in kv);
    if (weekdayOnly) dt = dt.plus({ days: 7 });
    else if (monthDay) dt = dt.plus({ years: 1 });
  }

  return dt.toFormat("yyyy-LL-dd");
}

function buildISOFromDateAndTime(dateISO, timeObj) {
  const dt = DateTime.fromISO(`${dateISO}T00:00:00`, { zone: BOT_TZ })
    .set({ hour: timeObj.hour, minute: timeObj.minute, second: 0, millisecond: 0 });
  return dt.isValid ? dt.toISO({ suppressMilliseconds: true, includeOffset: true }) : null;
}

function resolveDateToISO(text, opts = {}) {
  const input = String(text || "").trim();
  if (!input) return null;

  const now = DateTime.now().setZone(BOT_TZ);
  const dateISO = resolveDateOnlyISO(input, opts);
  if (!dateISO) return null;

  const timeObj = extractTimeFromSpeech(input);
  if (!timeObj) return null;

  let dt = DateTime.fromISO(`${dateISO}T00:00:00`, { zone: BOT_TZ }).set({
    hour: timeObj.hour,
    minute: timeObj.minute,
    second: 0,
    millisecond: 0,
  });
  if (!dt.isValid) return null;

  if (dt < now && detectWeekday(input)) dt = dt.plus({ days: 7 });
  if (dt < now) return null;
  return dt.toISO({ suppressMilliseconds: true, includeOffset: true });
}

function extractAction(text) {
  const m = text?.match(/ACTION_JSON:\s*(\{.*\})/s);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function getHost(req) {
  return BASE_URL || `https://${req.headers.host}`;
}

function formatTimeForSpeechFromISO(iso) {
  const dt = DateTime.fromISO(String(iso || ""), { zone: BOT_TZ });
  if (!dt.isValid) return null;

  const hour12 = dt.toFormat("h");
  const minute = dt.minute;
  const suffix = dt.hour >= 12 ? "PM" : "AM";
  if (minute === 0) return `${hour12} ${suffix}`;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function formatTorontoConfirm(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;

  const weekday = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOT_TZ,
    weekday: "long",
  }).format(d);

  const datePretty = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOT_TZ,
    month: "long",
    day: "numeric",
  }).format(d);

  const timePretty = formatTimeForSpeechFromISO(iso);
  if (!timePretty) return null;

  return `${weekday}, ${datePretty} at ${timePretty}`;
}

function torontoNowString() {
  return new Date().toLocaleString("en-CA", { timeZone: BOT_TZ });
}

function isCompleteBooking(action) {
  return Boolean(
    action &&
    action.action === "book" &&
    action.service &&
    action.stylist &&
    action.datetime &&
    action.name &&
    action.phone
  );
}

function normalizePhone(s) {
  const digits = String(s || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

function cleanSpeech(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asksWhatDate(text) {
  const t = cleanSpeech(text);
  if (!t) return false;
  if (/\bwhat(?:s| is)?\s+(?:the\s+)?(?:date|day)\b/.test(t)) return true;
  if (/\bwhich\s+(?:date|day)\b/.test(t)) return true;
  if (/\bwhat\s+day\s+(?:is|would|will)\s+that\b/.test(t)) return true;
  if (/\bwhat\s+date\s+(?:is|would|will)\s+that\b/.test(t)) return true;
  if (/\b(?:date|day)\s+again\b/.test(t)) return true;
  return /\b(what|which|when)\b/.test(t) && /\b(date|day|weekday)\b/.test(t);
}

function formatTorontoDateOnly(dateISO) {
  const d = new Date(`${dateISO}T12:00:00`);
  if (isNaN(d.getTime())) return null;

  const weekday = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOT_TZ,
    weekday: "long",
  }).format(d);

  const datePretty = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOT_TZ,
    month: "long",
    day: "numeric",
  }).format(d);

  return `${weekday}, ${datePretty}`;
}

function isYes(text) {
  const t = cleanSpeech(text);
  if (/\b(no|nope|nah|negative|not|dont|do not)\b/.test(t)) return false;
  return /\b(yes|yeah|yep|yup|correct|confirm|confirmed|sure|okay|ok|sounds good|that works)\b/.test(t);
}

function isNo(text) {
  const t = cleanSpeech(text);
  if (/\b(yes|yeah|yep|yup|correct|confirm|sure|okay|ok)\b/.test(t)) return false;
  return /\b(no|nope|nah|negative|incorrect|not right|cancel)\b/.test(t);
}

function wantsHuman(text) {
  return /(human|manager|front desk|desk|reception|someone|representative|staff|person|talk to)/i.test(String(text || ""));
}

function sanitizeSpoken(text) {
  let out = String(text || "");
  out = out.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:\d{2}/g,
    (iso) => formatTorontoConfirm(iso) || "that time"
  );
  out = out.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "that date");
  out = out.replace(/\b(\d{1,2})(?::([0-5]\d))?\s+y+\s*(a\.?m\.?|p\.?m\.?)\b/gi, (_m, h, mm, ap) => {
    const suffix = /^p/i.test(ap) ? "PM" : "AM";
    if (!mm) return `${h} ${suffix}`;
    return `${h}:${mm} ${suffix}`;
  });
  out = out.replace(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/gi, (_m, h, mm, ap) => {
    const suffix = /^p/i.test(ap) ? "PM" : "AM";
    if (!mm) return `${h} ${suffix}`;
    return `${h}:${mm} ${suffix}`;
  });
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function assistantSeemsToAskForTime(text) {
  const t = cleanSpeech(text);
  return (
    /\b(what|which)\s+time\b/.test(t) ||
    /\bwhat\s+hour\b/.test(t) ||
    /\btime\s+(works|would work|is good|is best)\b/.test(t) ||
    /\bcan you give me a time\b/.test(t)
  );
}

function getNextMissingQuestion(draft) {
  if (!draft.service) return "What service would you like to book?";
  if (!draft.stylist) return "Which stylist would you like: Cosmo, Vince, or Cassidy?";
  if (!draft.datetime) return draft.date ? "What time works for you?" : "What day works best for you?";
  if (!draft.name) return "Can I get your name for the booking?";
  if (!draft.phone) return "What’s the best 10-digit phone number for the booking?";
  return null;
}

function mergeBookActionWithDraft(action, draft) {
  if (!action || action.action !== "book") return action;
  return {
    action: "book",
    service: action.service || draft.service || "",
    stylist: action.stylist || draft.stylist || "",
    datetime: action.datetime || draft.datetime || "",
    name: action.name || draft.name || "",
    phone: normalizePhone(action.phone || draft.phone || ""),
  };
}

function draftToBookAction(draft) {
  if (!draft.service || !draft.stylist || !draft.datetime || !draft.name || !draft.phone) return null;
  return {
    action: "book",
    service: draft.service,
    stylist: draft.stylist,
    datetime: draft.datetime,
    name: draft.name,
    phone: normalizePhone(draft.phone),
  };
}

async function postBookingToZapier(payload) {
  const url = process.env.BOOKING_WEBHOOK_URL;
  if (!url) throw new Error("BOOKING_WEBHOOK_URL missing");

  const resp = await http.post(url, payload, {
    timeout: 5000,
    validateStatus: () => true,
    headers: { "Content-Type": "application/json" },
  });

  console.log("📨 Zapier POST result:", { status: resp.status });
  if (resp.status < 200 || resp.status >= 300) throw new Error(`Zapier returned ${resp.status}`);
}


// Cleanup so memory doesn't grow forever
setInterval(() => {
  if (audioStore.size > 300) {
    const keys = Array.from(audioStore.keys()).slice(0, audioStore.size - 300);
    keys.forEach((k) => audioStore.delete(k));
  }

  const now = Date.now();
  for (const [token, v] of pendingTurns.entries()) {
    if (now - v.createdAt > 120_000) pendingTurns.delete(token);
  }

  for (const [sid, v] of pendingBookings.entries()) {
    if (now - (v._createdAt || now) > 600_000) pendingBookings.delete(sid);
  }

  for (const sid of bookingDraftStore.keys()) {
    if (!conversationStore.has(sid)) bookingDraftStore.delete(sid);
  }
  for (const sid of awaitingPhoneConfirm.keys()) {
    if (!conversationStore.has(sid)) awaitingPhoneConfirm.delete(sid);
  }
  for (const sid of lastResolvedDateStore.keys()) {
    if (!conversationStore.has(sid)) lastResolvedDateStore.delete(sid);
  }
}, 30_000);

// ---- BOOKING DRAFT + PHONE CONFIRM STATE ----
const bookingDraftStore = new Map();      // callSid -> { name, phone, service, stylist, datetime }
const awaitingPhoneConfirm = new Map();   // callSid -> "9055558851" waiting for yes/no

function speakDigits(digits) {
  return String(digits).split("").join(" ");
}

/**
 * Converts speech like:
 * "905 555 8851"
 * "nine oh five five five five eight eight five one"
 * "nine zero five..."
 * into a 10-digit string (best effort)
 */
function extractLikelyPhoneFromSpeech(speech) {
  const raw = String(speech || "").toLowerCase();

  // normalize common "oh"/"o" to zero
  let t = raw
    .replace(/\boh\b/g, " zero ")
    .replace(/\bo\b/g, " zero ")
    .replace(/-/g, " ")
    .replace(/\./g, " ")
    .replace(/,/g, " ");

  // word -> digit mapping
  const map = {
    zero: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  };

  // turn words into digits
  t = t.split(/\s+/).map(w => (map[w] ?? w)).join(" ");

  // keep only digits
  const digits = t.replace(/\D/g, "");

  // prefer a clean 10-digit number if present anywhere
  if (digits.length === 10) return digits;

  // if longer, take last 10 (handles “+1 905...” etc)
  if (digits.length > 10) return digits.slice(-10);

  // if shorter, return as-is (caller may be mid-number)
  return digits;
}

function getDraft(callSid) {
  return bookingDraftStore.get(callSid) || {};
}

function setDraft(callSid, patch) {
  bookingDraftStore.set(callSid, { ...getDraft(callSid), ...patch });
}

function draftSummarySystem(draft) {
  const parts = [];
  if (draft.date) parts.push(`date="${draft.date}"`);
  if (draft.name) parts.push(`name="${draft.name}"`);
  if (draft.phone) parts.push(`phone="${draft.phone}"`);
  if (draft.service) parts.push(`service="${draft.service}"`);
  if (draft.stylist) parts.push(`stylist="${draft.stylist}"`);
  if (draft.datetime) parts.push(`datetime="${draft.datetime}"`);
  return parts.length ? `Known booking fields so far: ${parts.join(", ")}.` : `No booking fields collected yet.`;
}

// ---------- ROUTES ----------
app.get("/voice/incoming", async (req, res) => {
  try {
    const greet = `Hi thanks for calling ${process.env.SALON_NAME || "the salon"}. My name is Alex, how can I help you?`;
    const audio = await ttsWithRetry(greet);
    const id = uuidv4();
    audioStore.set(id, audio);

    const host = getHost(req);
    return res.type("text/xml").send(
`<Response>
  <Play>${host}/audio/${id}.mp3</Play>
</Response>`
    );
  } catch {
    return res.type("text/xml").send(
`<Response>
  <Say>Hi! Thanks for calling. How can I help you today?</Say>
</Response>`
    );
  }
});

app.post("/voice/incoming", async (req, res) => {
  const host = getHost(req);
  const actionUrl = `${host}/voice/turn`;

  try {
    const greet = `Hi this ${process.env.SALON_NAME || "the salon"}. My name is Alex, how can I help you?`;
    const audio = await ttsWithRetry(greet);
    const id = uuidv4();
    audioStore.set(id, audio);

    return res.type("text/xml").send(
`<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`
    );
  } catch {
    return res.type("text/xml").send(
`<Response>
  <Say>Hi! Thanks for calling. How can I help you today?</Say>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`
    );
  }
});

app.post("/voice/turn", async (req, res) => {
  const host = getHost(req);
  const actionUrl = `${host}/voice/turn`;

  try {
    const callSid = req.body.CallSid || "no-callsid";
    const userSpeech = req.body.SpeechResult || "";
    const draftAtTurnStart = getDraft(callSid);
    const pendingAtTurnStart = pendingBookings.get(callSid);
    const t = cleanSpeech(userSpeech);
    const hasForwardDateIntent = hasForwardWeekdayIntent(t) || hasNextWeekOnlyIntent(t);
    const contextDateForCorrection =
      hasForwardDateIntent
        ? (draftAtTurnStart.date || isoToDateOnly(pendingAtTurnStart?.datetime))
        : null;
    const isAmbiguousNextWeekOnly = hasNextWeekOnlyIntent(t) && !contextDateForCorrection;

    // Server-owned slot extraction on every utterance
    let foundDateOnly = resolveDateOnlyISO(userSpeech, { afterDateISO: contextDateForCorrection });
    const speechPatch = {};
    const foundStylist = extractStylistFromSpeech(userSpeech);
    const foundService = extractServiceFromSpeech(userSpeech);
    if (foundStylist) speechPatch.stylist = foundStylist;
    if (foundService) speechPatch.service = foundService;
    if (foundDateOnly) {
      speechPatch.date = foundDateOnly;
      lastResolvedDateStore.set(callSid, foundDateOnly);
    }
    if (Object.keys(speechPatch).length) setDraft(callSid, speechPatch);

    if (!conversationStore.has(callSid)) {
      conversationStore.set(callSid, [
        {
          role: "system",
          content:
            SYSTEM_PROMPT +
            `

CURRENT_DATETIME_TORONTO: ${torontoNowString()}
Timezone: ${BOT_TZ}
Never book in the past.
If no year is specified, assume the next upcoming future date.
`,
        },
      ]);
    }

    const messages = conversationStore.get(callSid);
    let finalResolvedISO = resolveDateToISO(userSpeech, { afterDateISO: contextDateForCorrection });

    if (!finalResolvedISO) {
      const draft = getDraft(callSid);
      const timeOnly = extractTimeOnly(userSpeech);
      if (draft?.date && timeOnly) {
        finalResolvedISO = buildISOFromDateAndTime(draft.date, timeOnly);
      }
    }

    // If caller corrected only the date (e.g., "no, next Tuesday"), keep existing time.
    if (!finalResolvedISO && foundDateOnly) {
      const existingTime = isoToTimeOnly(draftAtTurnStart.datetime || pendingAtTurnStart?.datetime);
      if (existingTime) {
        finalResolvedISO = buildISOFromDateAndTime(foundDateOnly, existingTime);
      }
    }

    if (finalResolvedISO) {
      const dt = DateTime.fromISO(finalResolvedISO, { zone: BOT_TZ });
      if (dt.isValid) {
        foundDateOnly = dt.toFormat("yyyy-LL-dd");
        setDraft(callSid, { date: foundDateOnly, datetime: finalResolvedISO });
        lastResolvedDateStore.set(callSid, foundDateOnly);
      } else {
        setDraft(callSid, { datetime: finalResolvedISO });
      }
      messages.push({
        role: "user",
        content: `${userSpeech} (resolved datetime: ${finalResolvedISO})`,
      });
    } else if (foundDateOnly) {
      messages.push({
        role: "user",
        content: `${userSpeech} (resolved date: ${foundDateOnly})`,
      });
    } else {
      messages.push({ role: "user", content: userSpeech });
    }

    const token = uuidv4();
    const fillerId = pickFillerId();

    pendingTurns.set(token, {
      ready: false,
      twiml: "",
      createdAt: Date.now(),
      fillerId,
    });

    (async () => {
      const entry = pendingTurns.get(token);
      if (!entry) return;

      try {
        if (isAmbiguousNextWeekOnly) {
          const line = "What day next week were you looking for?";
          const audio = await ttsWithRetry(line);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`;
          return;
        }

        // deterministic answer for "what date is that?"
        if (asksWhatDate(userSpeech)) {
          const remembered = lastResolvedDateStore.get(callSid) || getDraft(callSid).date;
          if (remembered) {
            const prettyDate = formatTorontoDateOnly(remembered) || remembered;
            const line = `That would be ${prettyDate}.`;
            const audio = await ttsWithRetry(line);
            const id = uuidv4();
            audioStore.set(id, audio);

            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`;
            return;
          }
        }

        const pendingBooking = pendingBookings.get(callSid);

        if (pendingBooking && isYes(userSpeech)) {
          const pretty = formatTorontoConfirm(pendingBooking.datetime) || pendingBooking.datetime;

          try {
            console.log("✅ Confirmed booking, posting to Zapier:", pendingBooking);
            await postBookingToZapier(pendingBooking);

            const finalLine = `Perfect ${pendingBooking.name}. You’re all set for ${pretty}.`;
            const audio = await ttsWithRetry(finalLine);
            const id = uuidv4();
            audioStore.set(id, audio);

            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Hangup/>
</Response>`;

            pendingBookings.delete(callSid);
            conversationStore.delete(callSid);
            bookingDraftStore.delete(callSid);
            awaitingPhoneConfirm.delete(callSid);
            lastResolvedDateStore.delete(callSid);
            return;
          } catch (err) {
            console.log("❌ Booking post failed, NOT hanging up:", err?.message || err);

            const failLine =
              "Sorry — I couldn’t save that appointment right now. Do you want to try again, or should I connect you to the salon?";
            const audio = await ttsWithRetry(failLine);
            const id = uuidv4();
            audioStore.set(id, audio);

            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`;
            return;
          }
        }

        if (pendingBooking && isNo(userSpeech)) {
          const draftNow = getDraft(callSid);
          const corrected = {
            ...pendingBooking,
            service: draftNow.service || pendingBooking.service,
            stylist: draftNow.stylist || pendingBooking.stylist,
            datetime: draftNow.datetime || pendingBooking.datetime,
            name: draftNow.name || pendingBooking.name,
            phone: draftNow.phone || pendingBooking.phone,
          };

          const changed =
            corrected.service !== pendingBooking.service ||
            corrected.stylist !== pendingBooking.stylist ||
            corrected.datetime !== pendingBooking.datetime;

          if (changed && corrected.datetime) {
            corrected._createdAt = Date.now();
            pendingBookings.set(callSid, corrected);
            setDraft(callSid, {
              service: corrected.service,
              stylist: corrected.stylist,
              datetime: corrected.datetime,
              name: corrected.name,
              phone: corrected.phone,
              date: isoToDateOnly(corrected.datetime) || draftNow.date,
            });

            const pretty = formatTorontoConfirm(corrected.datetime) || corrected.datetime;
            const line = `Got it — updating that to ${pretty}. Is that correct?`;
            const audio = await ttsWithRetry(line);
            const id = uuidv4();
            audioStore.set(id, audio);

            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`;
            return;
          }

          const line = "No problem — what should I change? The day, the time, or the stylist?";
          const audio = await ttsWithRetry(line);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`;
          return;
        }

        if (pendingBooking && !isYes(userSpeech) && !isNo(userSpeech)) {
          const draftNow = getDraft(callSid);
          const corrected = {
            ...pendingBooking,
            service: draftNow.service || pendingBooking.service,
            stylist: draftNow.stylist || pendingBooking.stylist,
            datetime: draftNow.datetime || pendingBooking.datetime,
            name: draftNow.name || pendingBooking.name,
            phone: draftNow.phone || pendingBooking.phone,
          };
          const changed =
            corrected.service !== pendingBooking.service ||
            corrected.stylist !== pendingBooking.stylist ||
            corrected.datetime !== pendingBooking.datetime;

          if (changed && corrected.datetime) {
            corrected._createdAt = Date.now();
            pendingBookings.set(callSid, corrected);
            setDraft(callSid, {
              service: corrected.service,
              stylist: corrected.stylist,
              datetime: corrected.datetime,
              name: corrected.name,
              phone: corrected.phone,
              date: isoToDateOnly(corrected.datetime) || draftNow.date,
            });

            const pretty = formatTorontoConfirm(corrected.datetime) || corrected.datetime;
            const line = `Got it — updating that to ${pretty}. Is that correct?`;
            const audio = await ttsWithRetry(line);
            const id = uuidv4();
            audioStore.set(id, audio);

            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`;
            return;
          }

          messages.push({
            role: "system",
            content:
              `The caller is correcting the appointment time. Keep service="${pendingBooking.service}", stylist="${pendingBooking.stylist}", name="${pendingBooking.name}", phone="${pendingBooking.phone}". ` +
              `Update ONLY datetime based on the caller's correction and output ACTION_JSON book with updated datetime.`,
          });
        }

        // ---- PHONE CONFIRM FLOW (server-controlled) ----
        const maybePhone = extractLikelyPhoneFromSpeech(userSpeech);

        // A) If we are waiting on "yes/no" to confirm phone
        if (awaitingPhoneConfirm.has(callSid)) {
          const pendingPhone = awaitingPhoneConfirm.get(callSid);

          if (isYes(userSpeech)) {
            setDraft(callSid, { phone: pendingPhone });
            messages.push({
              role: "system",
              content: `Caller phone confirmed: ${pendingPhone}. Do NOT ask for phone again.`,
            });
            awaitingPhoneConfirm.delete(callSid);

            const nextQuestion = getNextMissingQuestion(getDraft(callSid));
            const line = nextQuestion
              ? `Perfect — I’ve got ${speakDigits(pendingPhone)}. ${nextQuestion}`
              : `Perfect — I’ve got ${speakDigits(pendingPhone)}.`;
            const audio = await ttsWithRetry(line);
            const id = uuidv4();
            audioStore.set(id, audio);

            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`;
            return;
          }

          if (isNo(userSpeech)) {
            awaitingPhoneConfirm.delete(callSid);

            const line = "No worries — can you say the full 10-digit phone number again, one digit at a time?";
            const audio = await ttsWithRetry(line);
            const id = uuidv4();
            audioStore.set(id, audio);

            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`;
            return;
          }

          // unclear response: ask again
          const line = `Just to confirm — is your number ${speakDigits(pendingPhone)}?`;
          const audio = await ttsWithRetry(line);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`;
          return;
        }

        // B) If caller just said a full phone number this turn -> ask for confirmation
        if (maybePhone.length === 10 && !getDraft(callSid).phone) {
          awaitingPhoneConfirm.set(callSid, maybePhone);

          const line = `Just to confirm — is your number ${speakDigits(maybePhone)}?`;
          const audio = await ttsWithRetry(line);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`;
          return;
        }

        // Remind the model what we already collected (prevents re-asking)
        const draft = getDraft(callSid);
        messages.push({
          role: "system",
          content: `${draftSummarySystem(draft)} Do NOT ask for fields already known. Ask ONLY for the next missing field.`,
        });
        if (finalResolvedISO) {
          messages.push({
            role: "system",
            content: `Server-resolved datetime for this turn is ${finalResolvedISO} (${BOT_TZ}). Use this exact value.`,
          });
          messages.push({
            role: "system",
            content: `Datetime is already known for this booking. Do NOT ask for time again.`,
          });
        }

        let reply = "Sorry—could you say that again?";

        try {
          const r = await http.post(
            "https://api.openai.com/v1/chat/completions",
            {
              model: "gpt-4o-mini",
              temperature: 0.2,
              max_tokens: 110,
              messages,
            },
            {
              headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
              timeout: 8000,
            }
          );

          reply = r.data.choices?.[0]?.message?.content?.trim() || reply;
          messages.push({ role: "assistant", content: reply });
        } catch (e) {
          console.log("❌ OpenAI error", e?.response?.status, e?.response?.data || e?.message);
        }

        let action = extractAction(reply);
        if (action?.action === "book") {
          action = mergeBookActionWithDraft(action, getDraft(callSid));

          const patchFromAction = {};
          if (action.service) patchFromAction.service = action.service;
          if (action.stylist) patchFromAction.stylist = action.stylist;
          if (action.name) patchFromAction.name = action.name;
          if (action.phone) patchFromAction.phone = normalizePhone(action.phone) || action.phone;
          if (action.datetime) {
            patchFromAction.datetime = action.datetime;
            const adt = DateTime.fromISO(action.datetime, { zone: BOT_TZ });
            if (adt.isValid) {
              const d = adt.toFormat("yyyy-LL-dd");
              patchFromAction.date = d;
              lastResolvedDateStore.set(callSid, d);
            }
          }
          if (Object.keys(patchFromAction).length) setDraft(callSid, patchFromAction);
        } else {
          const fromDraft = draftToBookAction(getDraft(callSid));
          if (fromDraft) action = fromDraft;
        }

        console.log("AI RAW REPLY:", reply);
        console.log("PARSED ACTION:", action);

        if (action?.action === "transfer" && process.env.SALON_PHONE && wantsHuman(userSpeech)) {
          const transferLine = "Okay, I’ll connect you to the salon now.";
          const audio = await ttsWithRetry(transferLine);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Dial>${process.env.SALON_PHONE}</Dial>
</Response>`;

          pendingBookings.delete(callSid);
          conversationStore.delete(callSid);
          bookingDraftStore.delete(callSid);
          awaitingPhoneConfirm.delete(callSid);
          lastResolvedDateStore.delete(callSid);
          return;
        }

        let spoken = reply.replace(/ACTION_JSON:[\s\S]*$/, "").trim() || "Got it.";
        spoken = sanitizeSpoken(spoken);
        const latestDraft = getDraft(callSid);
        if (latestDraft.datetime && assistantSeemsToAskForTime(spoken)) {
          spoken = getNextMissingQuestion(latestDraft) || "Great. What’s your name for the booking?";
        }

        if (action?.action === "book" && !isCompleteBooking(action)) {
          spoken = getNextMissingQuestion(getDraft(callSid)) || "What detail should I update for the booking?";
        }

        if (isCompleteBooking(action)) {
          action.phone = normalizePhone(action.phone) || action.phone;
          action._createdAt = Date.now();
          setDraft(callSid, {
            service: action.service,
            stylist: action.stylist,
            datetime: action.datetime,
            name: action.name,
            phone: action.phone,
          });
          pendingBookings.set(callSid, action);

          const pretty = formatTorontoConfirm(action.datetime) || action.datetime;
          const confirmLine = `Just to confirm: a ${action.service} with ${action.stylist} on ${pretty}, correct?`;

          const audio = await ttsWithRetry(confirmLine);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`;
          return;
        }

        const audio = await ttsWithRetry(spoken);
        const id = uuidv4();
        audioStore.set(id, audio);

        entry.ready = true;
        entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`;
      } catch (e) {
        console.log("❌ Background turn error", e?.stack || e?.message || e);
        const repeatId = clipIds.repeat || (await ensureClip("repeat", "Sorry—could you say that again?"));

        entry.ready = true;
        entry.twiml = `<Response>
  <Play>${host}/audio/${repeatId}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`;
      }
    })();

    const pollUrl = `${host}/voice/turn/result?token=${encodeURIComponent(token)}`;

    if (fillerId) {
      return res.type("text/xml").send(
`<Response>
  <Play>${host}/audio/${fillerId}.mp3</Play>
  <Redirect method="GET">${pollUrl}</Redirect>
</Response>`
      );
    }

    return res.type("text/xml").send(
`<Response>
  <Pause length="1" />
  <Redirect method="GET">${pollUrl}</Redirect>
</Response>`
    );
  } catch (e) {
    console.log("❌ /voice/turn UNCAUGHT", e?.stack || e?.message || e);
    return res.type("text/xml").send(
`<Response>
  <Say>Sorry—could you say that again?</Say>
  <Gather input="speech" action="${getHost(req)}/voice/turn" method="POST" speechTimeout="auto" />
</Response>`
    );
  }
});

app.get("/voice/turn/result", async (req, res) => {
  const host = getHost(req);
  const actionUrl = `${host}/voice/turn`;

  try {
    const token = String(req.query.token || "");
    const pending = pendingTurns.get(token);

    if (pending?.ready && pending.twiml) {
      pendingTurns.delete(token);
      return res.type("text/xml").send(pending.twiml);
    }

    if (!pending) {
      const repeatId = clipIds.repeat || (await ensureClip("repeat", "Sorry—could you say that again?"));
      return res.type("text/xml").send(
`<Response>
  <Play>${host}/audio/${repeatId}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`
      );
    }

    const pollUrl = `${host}/voice/turn/result?token=${encodeURIComponent(token)}`;

    return res.type("text/xml").send(
`<Response>
  <Pause length="1" />
  <Redirect method="GET">${pollUrl}</Redirect>
</Response>`
    );
  } catch (e) {
    console.log("❌ /voice/turn/result error", e?.stack || e?.message || e);
    return res.type("text/xml").send(
`<Response>
  <Say>Sorry—could you say that again?</Say>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`
    );
  }
});

app.get("/audio/:id.mp3", (req, res) => {
  const id = (req.params.id || "").replace(".mp3", "");
  const buf = audioStore.get(id);
  if (!buf) return res.status(404).end();
  res.set("Content-Type", "audio/mpeg");
  res.send(buf);
});

// --- diagnostic routes ---
app.get("/env-check", (_, res) => {
  let zapHost = "missing";
  try {
    zapHost = process.env.BOOKING_WEBHOOK_URL ? new URL(process.env.BOOKING_WEBHOOK_URL).host : "missing";
  } catch {
    zapHost = "invalid";
  }

  res.json({
    BASE_URL: process.env.BASE_URL || "missing",
    SALON_NAME: process.env.SALON_NAME || "missing",
    ELEVEN_API_KEY_len: process.env.ELEVEN_API_KEY?.length || 0,
    ELEVEN_VOICE_ID: process.env.ELEVEN_VOICE_ID || "missing",
    OPENAI_API_KEY_len: process.env.OPENAI_API_KEY?.length || 0,
    BOOKING_WEBHOOK_URL: process.env.BOOKING_WEBHOOK_URL ? "set" : "missing",
    BOOKING_WEBHOOK_URL_host: zapHost,
    SALON_PHONE: process.env.SALON_PHONE || "missing",
    fillerCount: fillerIds.length,
    repeatClip: clipIds.repeat ? "ready" : "missing",
    pendingTurns: pendingTurns.size,
    pendingBookings: pendingBookings.size,
    BOT_TIMEZONE: BOT_TZ,
  });
});

app.get("/tts-test", async (_req, res) => {
  try {
    const audio = await ttsWithRetry("Hi, this is the server speaking. ElevenLabs is working.");
    res.set("Content-Type", "audio/mpeg");
    res.send(audio);
  } catch (err) {
    console.error("TTS test failed:", err?.response?.data || err);
    res.status(500).send("TTS failed");
  }
});

app.get("/", (_, res) => res.send("Hair Hunters Voicebot is running ✅"));

const PORT = process.env.PORT || 3000;

(async () => {
  await warmFillers();
  app.listen(PORT, () => console.log(`Voice bot running on port ${PORT}`));
})();
