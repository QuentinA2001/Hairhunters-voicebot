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
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { google } from "googleapis";

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
const BUSINESS_OPEN_HOUR = 9;   // 9:00 AM
const BUSINESS_CLOSE_HOUR = 17; // 5:00 PM
const CLOSED_WEEKDAY = 7;       // Sunday in Luxon (Mon=1..Sun=7)
const ELEVEN_STABILITY = Number(process.env.ELEVEN_STABILITY || "0.55");
const ELEVEN_SIMILARITY = Number(process.env.ELEVEN_SIMILARITY || "0.75");
const DEFAULT_SERVICE_DURATION_MIN = Number(process.env.DEFAULT_SERVICE_DURATION_MIN || "60");
const SLOT_STEP_MIN = Number(process.env.SLOT_STEP_MIN || "30");

// In-memory stores (OK for MVP; use Redis/S3 for production)
const audioStore = new Map();            // id -> Buffer(mp3)
const conversationStore = new Map();     // callSid -> messages[]
const pendingTurns = new Map();          // token -> { ready, twiml, createdAt, fillerId }
const pendingBookings = new Map();       // callSid -> booking payload waiting for confirm
const lastResolvedDateStore = new Map(); // callSid -> YYYY-MM-DD
const partialPhoneStore = new Map();     // callSid -> partial digit buffer
const lastCalendarConflictStore = new Map(); // callSid -> { dateISO, service, createdAt }

// Keep-alive HTTP client (reduces latency)
const httpsAgent = new https.Agent({ keepAlive: true });
const http = axios.create({ httpsAgent, timeout: 12000 });

// Small helper for log redaction
const pick = (v) => (v ? String(v).slice(0, 6) + "…" : "missing");

// ---------- FILLERS (pre-generated ElevenLabs clips) ----------
const fillerText = ["Okay.", "Alright.", "Sounds good."];
const fillerIds = []; // mp3 ids ready to use

const clipIds = {
  repeat: null, // "Sorry—could you say that again?"
};

function pickFillerId() {
  if (!fillerIds.length) return null;
  return fillerIds[Math.floor(Math.random() * fillerIds.length)];
}

function clamp01(n, fallback) {
  const v = Number(n);
  if (Number.isNaN(v)) return fallback;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function prepareTtsText(input) {
  let out = String(input || "");
  out = out.normalize("NFKC");
  out = out.replace(/[\u200B-\u200D\uFEFF]/g, "");
  out = out.replace(/\u00A0/g, " ");
  out = out.replace(/[‘’]/g, "'");
  out = out.replace(/[“”]/g, '"');
  out = out.replace(/\u2026/g, "...");
  out = out.replace(/[‐‑‒–—]/g, "-");
  out = out.replace(/[\u0000-\u001F\u007F]/g, " ");
  out = out.replace(/\b(\d+)-digit\b/gi, "$1 digit");
  out = out.replace(/\s+-\s+/g, ", ");
  out = out.replace(/:\s+/g, ", ");
  out = out.replace(/\s+/g, " ").trim();
  out = out.replace(/([.!?])\1+/g, "$1");
  if (out && !/[.!?]$/.test(out)) out += ".";
  return out;
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
- Business hours are 9 AM to 5 PM, Monday through Saturday. Sunday is closed.

- If caller asks for a human/manager/desk, respond with:
ACTION_JSON: {"action":"transfer"}
(When outputting ACTION_JSON, output ONLY that line.)

- When you have all booking fields, respond with ONLY:
ACTION_JSON: {"action":"book","service":"...","stylist":"...","datetime":"ISO_FORMAT","name":"...","phone":"..."}
`;

// ---------- ELEVENLABS TTS ----------
async function tts(text) {
  const safe = prepareTtsText(text).slice(0, 800);
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
        voice_settings: {
          stability: clamp01(ELEVEN_STABILITY, 0.55),
          similarity_boost: clamp01(ELEVEN_SIMILARITY, 0.75),
        },
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

function titleCaseName(name) {
  return String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
    .trim();
}

function extractNameFromSpeech(text, opts = {}) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const t = cleanSpeech(raw);
  if (!t) return null;
  if (isYes(t) || isNo(t)) return null;

  const explicit =
    raw.match(/\b(?:my name is|name is|this is|i am|i'm|it is|it's)\s+([a-z][a-z' -]{0,40}?)(?=\s+(?:and|my|phone|number|for|to|with|at|i|im|i'm|want|would|need|like|calling)\b|$)/i) ||
    raw.match(/\b(?:its|it s)\s+([a-z][a-z' -]{0,40}?)(?=\s+(?:and|my|phone|number|for|to|with|at|i|im|i'm|want|would|need|like|calling)\b|$)/i);
  if (explicit?.[1]) {
    const clipped = explicit[1].replace(/[^a-z' -]/gi, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ");
    const candidate = titleCaseName(clipped);
    if (candidate && !isYes(candidate) && !isNo(candidate)) return candidate;
  }

  if (/\d/.test(raw)) return null;
  if (extractLikelyPhoneFromSpeech(raw).length >= 7) return null;
  if (extractStylistFromSpeech(raw) || extractServiceFromSpeech(raw)) return null;
  if (detectWeekday(raw) || hasNextWeekOnlyIntent(raw) || hasForwardWeekdayIntent(raw)) return null;
  if (extractTimeOnly(raw) || extractTimeFromSpeech(raw)) return null;
  if (DATE_WORD_RE.test(t)) return null;

  if (!opts.expectingName) return null;

  let candidate = t
    .replace(/\b(?:um|uh|yeah|yes|ok|okay|sure|its|it s|it is|it's|i am|i m|my name is|name is|this is)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!candidate) return null;
  if (!/^[a-z' -]{2,40}$/.test(candidate)) return null;
  candidate = candidate.split(" ").slice(0, 3).join(" ");
  if (isYes(candidate) || isNo(candidate)) return null;

  return titleCaseName(candidate);
}

function extractTimeOnly(text) {
  const t = cleanSpeech(text);
  if (!t) return null;
  if (/\d{3,}/.test(t)) return null;
  if (DATE_WORD_RE.test(t)) return null;

  const allow = new Set([
    "at", "around", "for", "please", "pls", "ok", "okay", "works", "work", "that", "sounds", "good",
    "yes", "yeah", "yep", "yup", "ya", "y", "no", "nah", "nope", "um", "uh", "thanks", "thank", "you",
    "o", "clock", "oclock",
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
    if (hour >= 1 && hour <= 8) hour += 12;
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
      let hour = Number(kv.hour ?? 0);
      const minute = Number(kv.minute ?? 0);
      const hasMeridiem = ("meridiem" in kv) || /\b(a\.?m\.?|p\.?m\.?)\b/i.test(input);
      if (!hasMeridiem && hour >= 1 && hour <= 8) hour += 12;
      if (!Number.isNaN(hour) && !Number.isNaN(minute)) return { hour, minute };
    }
  }

  return extractTimeOnly(input);
}

function getBusinessViolation(iso) {
  const dt = DateTime.fromISO(String(iso || ""), { zone: BOT_TZ });
  if (!dt.isValid) return "invalid";
  if (dt.weekday === CLOSED_WEEKDAY) return "closed_day";
  const mins = dt.hour * 60 + dt.minute;
  const open = BUSINESS_OPEN_HOUR * 60;
  const close = BUSINESS_CLOSE_HOUR * 60;
  if (mins < open || mins > close) return "outside_hours";
  return null;
}

function isClosedDateOnly(dateISO) {
  const dt = DateTime.fromISO(`${String(dateISO || "")}T12:00:00`, { zone: BOT_TZ });
  return dt.isValid ? dt.weekday === CLOSED_WEEKDAY : false;
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
  const normalized = normalizePhone(action?.phone || "");
  return Boolean(
    action &&
    action.action === "book" &&
    action.service &&
    action.stylist &&
    action.datetime &&
    action.name &&
    isLikelyNorthAmericanPhone(normalized)
  );
}

function normalizePhone(s) {
  const digits = String(s || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

function parseNanpPhone(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  const tries = [raw, raw.replace(/[^\d+]/g, ""), raw.replace(/\D/g, "")];
  for (const candidate of tries) {
    if (!candidate) continue;
    for (const region of ["CA", "US"]) {
      try {
        const phone = parsePhoneNumberFromString(candidate, region);
        // Use "possible" (format/length) instead of "valid" (assignment-level),
        // so normal-looking test numbers don't get rejected and shifted.
        const ok = Boolean(phone?.isPossible?.() || phone?.isValid?.());
        if (!ok) continue;
        if (phone.country && !["CA", "US"].includes(phone.country)) continue;
        return phone;
      } catch {
        // ignore parse errors; caller speech can be noisy
      }
    }
  }
  return null;
}

function getNanpPhoneQuality(input) {
  const raw = String(input || "").trim();
  if (!raw) return { phone: null, valid: false, possible: false, national: "" };

  const tries = [raw, raw.replace(/[^\d+]/g, ""), raw.replace(/\D/g, "")];
  for (const candidate of tries) {
    if (!candidate) continue;
    for (const region of ["CA", "US"]) {
      try {
        const phone = parsePhoneNumberFromString(candidate, region);
        if (!phone) continue;
        if (phone.country && !["CA", "US"].includes(phone.country)) continue;
        const possible = Boolean(phone?.isPossible?.());
        const valid = Boolean(phone?.isValid?.());
        const national = String(phone.nationalNumber || "");
        if (!possible && !valid) continue;
        if (!/^\d{10}$/.test(national)) continue;
        return { phone, valid, possible: possible || valid, national };
      } catch {
        // ignore noisy speech parse errors
      }
    }
  }
  return { phone: null, valid: false, possible: false, national: "" };
}

function toValidNanpPhone10(input) {
  const q = getNanpPhoneQuality(input);
  return q.national || "";
}

function selectBestPhoneDigits(s) {
  const digits = String(s || "").replace(/\D/g, "");
  if (!digits) return "";
  const exactQ = getNanpPhoneQuality(digits);
  if (digits.length === 10 && exactQ.national) return exactQ.national;
  if (digits.length === 11 && exactQ.national) return exactQ.national;
  if (digits.length > 10) {
    let firstPossible = "";
    for (let i = 0; i <= digits.length - 11; i += 1) {
      const cand11 = digits.slice(i, i + 11);
      const q11 = getNanpPhoneQuality(cand11);
      if (q11.valid && q11.national) return q11.national;
      if (!firstPossible && q11.national) firstPossible = q11.national;
    }
    for (let i = 0; i <= digits.length - 10; i += 1) {
      const cand = digits.slice(i, i + 10);
      const q10 = getNanpPhoneQuality(cand);
      if (q10.valid && q10.national) return q10.national;
      if (!firstPossible && q10.national) firstPossible = q10.national;
    }
    if (firstPossible) return firstPossible;
    return digits.slice(-10);
  }
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits;
}

function isLikelyNorthAmericanPhone(s) {
  const q = getNanpPhoneQuality(s);
  return Boolean(q.national);
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

function asksAvailableTimesOnDay(text) {
  const t = cleanSpeech(text);
  if (!t) return false;
  if (/\bwhat\s+time\b/.test(t) && !/\bother|else|available|open|options?\b/.test(t)) return false;
  const hasTimeAvailabilityWord = /\b(time|times|availability|available|open|slot|slots)\b/.test(t);
  const hasAskingWord = /\b(other|else|what|which|any|options?)\b/.test(t);
  const hasDayReference = /\b(that day|that date|same day|that afternoon|that evening|for that day|on that day)\b/.test(t);
  if (!(hasTimeAvailabilityWord && (hasAskingWord || hasDayReference))) return false;
  return (
    /\bwhat\s+(?:other\s+)?times?\s+(?:are\s+)?(?:available|open)\b/.test(t) ||
    /\bwhat\s+(?:other\s+)?slots?\s+(?:are\s+)?(?:available|open)\b/.test(t) ||
    /\bwhat\s+else\s+is\s+available\b/.test(t) ||
    /\bany\s+other\s+times?\b/.test(t) ||
    /\bany\s+other\s+slots?\b/.test(t) ||
    /\bwhat\s+other\s+options?\b/.test(t) ||
    /\bwhat\s+times?\s+(?:do you have|are open|are free)\b/.test(t) ||
    /\bwhich\s+times?\s+(?:are open|are available)\b/.test(t) ||
    /\bother\s+times?\s+(?:that\s+day|on\s+that\s+day|on\s+that\s+date|that\s+date)\b/.test(t) ||
    /\bavailability\s+(?:for|on)\s+that\s+(?:day|date)\b/.test(t) ||
    (hasDayReference && /\b(available|open|free|times?|slots?)\b/.test(t))
  );
}

function soundsLikeAvailabilityFollowUp(text) {
  const t = cleanSpeech(text);
  if (!t) return false;
  if (isYes(t) || isNo(t)) return false;
  if (extractTimeOnly(t) || extractTimeFromSpeech(t)) return false;
  return (
    /\b(what|which|any|other|else|options?)\b/.test(t) &&
      /\b(time|times|slot|slots|available|availabel|open|free|later|earlier)\b/.test(t)
  ) || (
    /\bdo you have\b/.test(t) &&
      /\b(anything|something|times|slots?|open|available|later|earlier)\b/.test(t)
  ) || (
    /\bwhat else\b/.test(t)
  );
}

function assistantSaidTimeUnavailable(text) {
  const t = cleanSpeech(text);
  if (!t) return false;
  return (
    /\btime\s+is\s+(?:already\s+booked|no longer available)\b/.test(t) ||
    /\balready booked in the calendar\b/.test(t) ||
    /\bwhat other time works for you\b/.test(t)
  );
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
  return /\b(yes|yeah|yep|yup|correct|right|exactly|confirm|confirmed|sure|okay|ok|sounds good|that works|go ahead|book it|do it|thats correct|that is correct|thats right|that is right|thats good|that is good)\b/.test(t);
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
  out = out.replace(/^\s*great choice[!. ,:-]*/i, "");
  out = out.replace(/\b(?:okay|alright|sounds good)[!.]\s+great choice[!. ,:-]*/i, (m) =>
    m.replace(/\s*great choice[!. ,:-]*/i, " ")
  );
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
  out = out.replace(/\b(\d{1,2})\s+long\s*(AM|PM)\b/gi, "$1 $2");
  // Avoid ":" pronunciation artifacts in TTS ("4:00 PM" -> "4 PM", "4:30 PM" -> "4 30 PM")
  out = out.replace(/\b(\d{1,2}):00\s*(AM|PM)\b/g, "$1 $2");
  out = out.replace(/\b(\d{1,2}):([0-5]\d)\s*(AM|PM)\b/g, "$1 $2 $3");
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

function assistantSeemsToAskForName(text) {
  const t = cleanSpeech(text);
  return (
    /\bwhat(?:s| is)?\s+your\s+name\b/.test(t) ||
    /\bcan i get your name\b/.test(t) ||
    /\bcan i have your name\b/.test(t) ||
    /\bname\s+for\s+the\s+booking\b/.test(t) ||
    /\bwho\s+should\s+i\s+put\s+the\s+booking\s+under\b/.test(t) ||
    /\bwho am i speaking with\b/.test(t) ||
    /\bwho is this\b/.test(t)
  );
}

function assistantSeemsToRecapBooking(text) {
  const t = cleanSpeech(text);
  return (
    /\bjust to confirm\b/.test(t) ||
    /\bi have all the details\b/.test(t) ||
    /\blet me confirm\b/.test(t) ||
    /\bconfirming\b/.test(t) ||
    /\byou re all set\b/.test(t) ||
    /\bdoes that look right\b/.test(t)
  );
}

function getNextMissingQuestion(draft) {
  if (!draft.service) return "What service would you like to book?";
  if (!draft.stylist) return "Which stylist would you like: Cosmo, Vince, or Cassidy?";
  if (!draft.datetime) return draft.date ? "What time works for you?" : "What day works best for you?";
  if (!draft.name) return "Can I get your name for the booking?";
  if (!draft.phone) return "What is the best 10 digit phone number for the booking?";
  return null;
}

function mergeBookActionWithDraft(action, draft) {
  if (!action || action.action !== "book") return action;
  return {
    action: "book",
    service: draft.service || action.service || "",
    stylist: draft.stylist || action.stylist || "",
    datetime: draft.datetime || action.datetime || "",
    name: draft.name || action.name || "",
    phone: normalizePhone(draft.phone || action.phone || ""),
  };
}

function draftToBookAction(draft) {
  if (!draft.service || !draft.stylist || !draft.datetime || !draft.name || !isLikelyNorthAmericanPhone(draft.phone)) return null;
  return {
    action: "book",
    service: draft.service,
    stylist: draft.stylist,
    datetime: draft.datetime,
    name: draft.name,
    phone: normalizePhone(draft.phone),
  };
}

function getServiceDurationMinutes(service) {
  const t = cleanSpeech(service || "");
  if (t.includes("cut") && (t.includes("colour") || t.includes("color"))) {
    return Number(process.env.DURATION_CUT_COLOUR_MIN || process.env.DURATION_CUT_COLOR_MIN || "180");
  }
  if (t.includes("colour") || t.includes("color")) {
    return Number(process.env.DURATION_COLOUR_MIN || process.env.DURATION_COLOR_MIN || "120");
  }
  if (t.includes("haircut") || t.includes("cut") || t.includes("trim")) {
    return Number(process.env.DURATION_HAIRCUT_MIN || "60");
  }
  return DEFAULT_SERVICE_DURATION_MIN;
}

function getGoogleCalendarConfig() {
  const calendarId = String(process.env.GOOGLE_CALENDAR_ID || "").trim();
  if (!calendarId) return null;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      if (parsed?.client_email && parsed?.private_key) {
        return {
          calendarId,
          credentials: {
            client_email: parsed.client_email,
            private_key: String(parsed.private_key).replace(/\\n/g, "\n"),
          },
        };
      }
    } catch (e) {
      console.log("⚠️ GOOGLE_SERVICE_ACCOUNT_JSON parse error:", e?.message || e);
    }
  }

  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return {
      calendarId,
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: String(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, "\n"),
      },
    };
  }

  return null;
}

async function checkGoogleCalendarAvailability(booking) {
  const cfg = getGoogleCalendarConfig();
  if (!cfg) return { enabled: false, available: true, reason: "not_configured" };

  const start = DateTime.fromISO(String(booking?.datetime || ""), { zone: BOT_TZ });
  if (!start.isValid) return { enabled: true, available: true, reason: "invalid_datetime" };

  const mins = Math.max(15, Number(getServiceDurationMinutes(booking?.service) || DEFAULT_SERVICE_DURATION_MIN));
  const end = start.plus({ minutes: mins });

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: cfg.credentials,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    const calendar = google.calendar({ version: "v3", auth });
    const resp = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.toUTC().toISO(),
        timeMax: end.toUTC().toISO(),
        timeZone: BOT_TZ,
        items: [{ id: cfg.calendarId }],
      },
    });

    const calBlock = resp?.data?.calendars?.[cfg.calendarId];
    const calErrors = Array.isArray(calBlock?.errors) ? calBlock.errors : [];
    if (!calBlock) {
      console.log("⚠️ Google Calendar freebusy missing calendar block", {
        calendarId: cfg.calendarId,
        keys: Object.keys(resp?.data?.calendars || {}),
      });
      return { enabled: true, available: false, reason: "calendar_missing" };
    }
    if (calErrors.length) {
      console.log("⚠️ Google Calendar freebusy calendar errors", {
        calendarId: cfg.calendarId,
        errors: calErrors,
      });
      return { enabled: true, available: false, reason: "calendar_error" };
    }

    const busy = Array.isArray(calBlock?.busy) ? calBlock.busy : [];
    console.log("📅 Calendar availability", {
      calendarId: cfg.calendarId,
      start: start.toISO(),
      end: end.toISO(),
      busyCount: busy.length,
      mins,
    });
    return {
      enabled: true,
      available: busy.length === 0,
      reason: "ok",
      busyCount: busy.length,
      mins,
    };
  } catch (e) {
    console.log("⚠️ Google Calendar availability check failed (blocking booking):", e?.message || e);
    return { enabled: true, available: false, reason: "api_error" };
  }
}

async function listGoogleCalendarAvailableTimesForDate({ dateISO, service }) {
  const cfg = getGoogleCalendarConfig();
  if (!cfg) return { enabled: false, ok: false, reason: "not_configured", slots: [] };

  const day = DateTime.fromISO(`${String(dateISO || "")}T00:00:00`, { zone: BOT_TZ });
  if (!day.isValid) return { enabled: true, ok: false, reason: "invalid_date", slots: [] };
  if (day.weekday === CLOSED_WEEKDAY) return { enabled: true, ok: true, reason: "closed_day", slots: [] };

  const durationMin = Math.max(15, Number(getServiceDurationMinutes(service) || DEFAULT_SERVICE_DURATION_MIN));
  const stepMin = Math.max(15, Number(SLOT_STEP_MIN || 30));
  const openDt = day.set({ hour: BUSINESS_OPEN_HOUR, minute: 0, second: 0, millisecond: 0 });
  const closeDt = day.set({ hour: BUSINESS_CLOSE_HOUR, minute: 0, second: 0, millisecond: 0 });
  const latestStart = closeDt.minus({ minutes: durationMin });
  if (latestStart < openDt) return { enabled: true, ok: true, reason: "no_capacity", slots: [] };

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: cfg.credentials,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    const calendar = google.calendar({ version: "v3", auth });
    const resp = await calendar.freebusy.query({
      requestBody: {
        timeMin: openDt.toUTC().toISO(),
        timeMax: closeDt.toUTC().toISO(),
        timeZone: BOT_TZ,
        items: [{ id: cfg.calendarId }],
      },
    });

    const calBlock = resp?.data?.calendars?.[cfg.calendarId];
    const calErrors = Array.isArray(calBlock?.errors) ? calBlock.errors : [];
    if (!calBlock) return { enabled: true, ok: false, reason: "calendar_missing", slots: [] };
    if (calErrors.length) return { enabled: true, ok: false, reason: "calendar_error", slots: [] };

    const busy = (Array.isArray(calBlock?.busy) ? calBlock.busy : [])
      .map((b) => ({
        start: DateTime.fromISO(String(b.start || ""), { zone: BOT_TZ }),
        end: DateTime.fromISO(String(b.end || ""), { zone: BOT_TZ }),
      }))
      .filter((b) => b.start.isValid && b.end.isValid && b.end > b.start);

    const now = DateTime.now().setZone(BOT_TZ);
    let slot = openDt;
    if (day.hasSame(now, "day") && slot < now) {
      const minsSinceOpen = Math.max(0, Math.ceil(now.diff(openDt, "minutes").minutes));
      const snapped = Math.ceil(minsSinceOpen / stepMin) * stepMin;
      slot = openDt.plus({ minutes: snapped });
    }

    const slots = [];
    while (slot <= latestStart) {
      const end = slot.plus({ minutes: durationMin });
      const overlaps = busy.some((b) => slot < b.end && end > b.start);
      if (!overlaps) slots.push(slot.toISO({ suppressMilliseconds: true, includeOffset: true }));
      slot = slot.plus({ minutes: stepMin });
      if (slots.length >= 12) break; // keep responses short
    }

    return { enabled: true, ok: true, reason: "ok", slots, durationMin };
  } catch (e) {
    console.log("⚠️ Google Calendar day availability list failed:", e?.message || e);
    return { enabled: true, ok: false, reason: "api_error", slots: [] };
  }
}

function formatAvailableTimeListLine(dateISO, slotIsos) {
  const prettyDate = formatTorontoDateOnly(dateISO) || dateISO;
  const labels = (slotIsos || [])
    .map((iso) => formatTimeForSpeechFromISO(iso))
    .filter(Boolean);

  if (!labels.length) {
    return `I do not have any open times left on ${prettyDate}. What other day works for you?`;
  }

  const top = labels.slice(0, 6);
  let joined = "";
  if (top.length === 1) joined = top[0];
  else if (top.length === 2) joined = `${top[0]} or ${top[1]}`;
  else joined = `${top.slice(0, -1).join(", ")}, or ${top[top.length - 1]}`;

  return `On ${prettyDate}, I have ${joined} available. What time works for you?`;
}

function calendarUnavailableLine(availability, stale = false) {
  if (!availability?.enabled) {
    return stale
      ? "That time is no longer available. What other time works for you?"
      : "That time is already booked. What other time works for you?";
  }
  if (availability.reason === "ok") {
    return stale
      ? "That time is no longer available in the calendar. What other time works for you?"
      : "That time is already booked in the calendar. What other time works for you?";
  }
  return "I could not verify the calendar right now. Please try another time, or I can connect you to the salon.";
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
  for (const sid of partialPhoneStore.keys()) {
    if (!conversationStore.has(sid)) partialPhoneStore.delete(sid);
  }
  for (const sid of lastCalendarConflictStore.keys()) {
    if (!conversationStore.has(sid)) lastCalendarConflictStore.delete(sid);
  }
}, 30_000);

// ---- BOOKING DRAFT + PHONE CONFIRM STATE ----
const bookingDraftStore = new Map();      // callSid -> { name, phone, service, stylist, datetime }
const awaitingPhoneConfirm = new Map();   // callSid -> "9055558851" waiting for yes/no

function speakDigits(digits) {
  const d = normalizePhone(digits);
  if (d.length !== 10) return "";
  const area = d.slice(0, 3).split("").join(" ");
  const mid = d.slice(3, 6).split("").join(" ");
  const tail = d.slice(6).split("").join(" ");
  return `${area}, ${mid}, ${tail}`;
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
  const directDigits = raw.replace(/\D/g, "");
  if (directDigits.length >= 10) return selectBestPhoneDigits(directDigits);

  const strictMap = {
    zero: "0", oh: "0", o: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
  };
  const homophoneMap = {
    won: "1",
    to: "2",
    too: "2",
    tree: "3",
    for: "4",
    ate: "8",
  };
  const phoneContext = /\b(phone|number|digits?|call me|reach me)\b/.test(raw);
  const tokens = raw
    .replace(/-/g, " ")
    .replace(/\./g, " ")
    .replace(/,/g, " ")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const numericishToken = (tok) => Boolean(strictMap[tok] || homophoneMap[tok] || /^\d+$/.test(tok));

  let built = "";
  let mappedCount = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (/^\d+$/.test(tok)) {
      built += tok;
      mappedCount += tok.length;
      continue;
    }
    let mapped = strictMap[tok];
    if (!mapped && homophoneMap[tok]) {
      const prev = tokens[i - 1] || "";
      const next = tokens[i + 1] || "";
      // Only treat risky homophones as digits when surrounded by number-like tokens
      // or when the utterance explicitly looks like a phone-number response.
      if (phoneContext || numericishToken(prev) || numericishToken(next)) {
        mapped = homophoneMap[tok];
      }
    }
    if (mapped) {
      built += mapped;
      mappedCount += 1;
    }
  }

  if (!phoneContext && mappedCount < 7) return "";
  const digits = built.replace(/\D/g, "");

  if (digits.length >= 10) return selectBestPhoneDigits(digits);

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
  if (draft.time) parts.push(`time="${String(draft.time.hour).padStart(2, "0")}:${String(draft.time.minute).padStart(2, "0")}"`);
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
    const greet = `Hi, this is ${process.env.SALON_NAME || "the salon"}. My name is Alex, how can I help you?`;
    const audio = await ttsWithRetry(greet);
    const id = uuidv4();
    audioStore.set(id, audio);

    return res.type("text/xml").send(
`<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`
    );
  } catch {
    return res.type("text/xml").send(
`<Response>
  <Say>Hi! Thanks for calling. How can I help you today?</Say>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
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

    const draftAtTurnStart = getDraft(callSid);
    const pendingAtTurnStart = pendingBookings.get(callSid);
    const t = cleanSpeech(userSpeech);
    const hasForwardDateIntent = hasForwardWeekdayIntent(t) || hasNextWeekOnlyIntent(t);
    const contextDateForCorrection =
      hasForwardDateIntent
        ? (draftAtTurnStart.date || isoToDateOnly(pendingAtTurnStart?.datetime))
        : null;
    const isAmbiguousNextWeekOnly = hasNextWeekOnlyIntent(t) && !contextDateForCorrection;
    const spokenTime = extractTimeOnly(userSpeech) || extractTimeFromSpeech(userSpeech);
    const lastAssistantPrompt =
      [...messages].reverse().find((m) => m?.role === "assistant")?.content || "";
    const expectingNameNow =
      !draftAtTurnStart.name &&
      (
        getNextMissingQuestion(draftAtTurnStart) === "Can I get your name for the booking?" ||
        assistantSeemsToAskForName(lastAssistantPrompt)
      );
    const foundName = extractNameFromSpeech(userSpeech, { expectingName: expectingNameNow });

    // Server-owned slot extraction on every utterance
    let foundDateOnly = resolveDateOnlyISO(userSpeech, { afterDateISO: contextDateForCorrection });
    const speechPatch = {};
    const foundStylist = extractStylistFromSpeech(userSpeech);
    const foundService = extractServiceFromSpeech(userSpeech);
    if (foundStylist) speechPatch.stylist = foundStylist;
    if (foundService) speechPatch.service = foundService;
    if (spokenTime) speechPatch.time = spokenTime;
    if (foundName && (!draftAtTurnStart.name || expectingNameNow)) speechPatch.name = foundName;
    if (foundDateOnly) {
      speechPatch.date = foundDateOnly;
      lastResolvedDateStore.set(callSid, foundDateOnly);
    }
    if (Object.keys(speechPatch).length) setDraft(callSid, speechPatch);

    let finalResolvedISO = resolveDateToISO(userSpeech, { afterDateISO: contextDateForCorrection });

    if (!finalResolvedISO) {
      const draft = getDraft(callSid);
      const timeOnly = spokenTime || draft.time || isoToTimeOnly(draft.datetime || pendingAtTurnStart?.datetime);
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
      const violation = getBusinessViolation(finalResolvedISO);
      if (violation === "closed_day" || violation === "outside_hours") {
        finalResolvedISO = null;
        if (violation === "closed_day") {
          setDraft(callSid, { date: "", datetime: "", time: null });
        } else {
          const keepDate = foundDateOnly || draftAtTurnStart.date || isoToDateOnly(pendingAtTurnStart?.datetime) || "";
          setDraft(callSid, { date: keepDate, datetime: "", time: null });
        }
      }
    }

    if (finalResolvedISO) {
      const dt = DateTime.fromISO(finalResolvedISO, { zone: BOT_TZ });
      if (dt.isValid) {
        foundDateOnly = dt.toFormat("yyyy-LL-dd");
        setDraft(callSid, { date: foundDateOnly, datetime: finalResolvedISO, time: { hour: dt.hour, minute: dt.minute } });
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
        if (!cleanSpeech(userSpeech)) {
          const pendingBooking = pendingBookings.get(callSid);
          const draftNow = getDraft(callSid);
          const line = pendingBooking
            ? "I'm still here. Are these booking details correct?"
            : (getNextMissingQuestion(draftNow) || "I'm still here whenever you're ready.");
          const audio = await ttsWithRetry(line);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
          return;
        }

        if (isAmbiguousNextWeekOnly) {
          const line = "What day next week were you looking for?";
          const audio = await ttsWithRetry(line);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
          return;
        }

        if (foundDateOnly && !finalResolvedISO && isClosedDateOnly(foundDateOnly)) {
          setDraft(callSid, { date: "", datetime: "" });
          lastResolvedDateStore.delete(callSid);
          const line = "We're closed on Sundays. What day works for you Monday through Saturday?";
          const audio = await ttsWithRetry(line);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
          return;
        }

        if (spokenTime && !finalResolvedISO && getDraft(callSid).date) {
          const line = "We book between 9 AM and 5 PM. What time in that window works for you?";
          const audio = await ttsWithRetry(line);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
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
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
            return;
          }
        }

        const conflictCtx = lastCalendarConflictStore.get(callSid);
        const lastAssistantSpoken =
          [...messages].reverse().find((m) => m?.role === "assistant")?.content || "";
        const availabilityFollowUpIntent =
          asksAvailableTimesOnDay(userSpeech) ||
          (Boolean(conflictCtx) &&
            soundsLikeAvailabilityFollowUp(userSpeech)) ||
          (assistantSaidTimeUnavailable(lastAssistantSpoken) &&
            /\b(what|which|any|other|else|open|available|time|times|slot|slots)\b/.test(cleanSpeech(userSpeech)));

        if (conflictCtx) {
          console.log("📅 availability follow-up check", {
            callSid,
            hasConflictCtx: true,
            userSpeech,
            availabilityFollowUpIntent,
            conflictDate: conflictCtx.dateISO,
          });
        }

        if (availabilityFollowUpIntent) {
          const draftNow = getDraft(callSid);
          const pendingNow = pendingBookings.get(callSid);
          const targetDate =
            draftNow.date ||
            conflictCtx?.dateISO ||
            lastResolvedDateStore.get(callSid) ||
            isoToDateOnly(draftNow.datetime || pendingNow?.datetime);
          const targetService = draftNow.service || conflictCtx?.service || pendingNow?.service || "";

          if (!targetDate) {
            const line = "I can check that once I have the day. What day were you looking for?";
            const audio = await ttsWithRetry(line);
            const id = uuidv4();
            audioStore.set(id, audio);

            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
            return;
          }

          const dayAvailability = await listGoogleCalendarAvailableTimesForDate({
            dateISO: targetDate,
            service: targetService,
          });

          let line;
          if (!dayAvailability.ok) {
            line = "I could not verify the calendar right now. Please try another time, or I can connect you to the salon.";
          } else if (dayAvailability.reason === "closed_day") {
            line = "We are closed on Sundays. What other day works for you?";
          } else {
            line = formatAvailableTimeListLine(targetDate, dayAvailability.slots);
          }

          if (dayAvailability.ok) {
            lastCalendarConflictStore.set(callSid, {
              dateISO: targetDate,
              service: targetService,
              createdAt: Date.now(),
            });
          }

          const audio = await ttsWithRetry(line);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
          return;
        }

        const pendingBooking = pendingBookings.get(callSid);

        if (pendingBooking && isYes(userSpeech)) {
          try {
            const availability = await checkGoogleCalendarAvailability(pendingBooking);
            if (!availability.available) {
              pendingBookings.delete(callSid);
              const keepDate = isoToDateOnly(pendingBooking.datetime) || getDraft(callSid).date || "";
              setDraft(callSid, { datetime: "", date: keepDate, time: null });
              lastCalendarConflictStore.set(callSid, {
                dateISO: keepDate,
                service: pendingBooking.service || getDraft(callSid).service || "",
                createdAt: Date.now(),
              });

              const line = calendarUnavailableLine(availability, true);
              const audio = await ttsWithRetry(line);
              const id = uuidv4();
              audioStore.set(id, audio);

              entry.ready = true;
              entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
              return;
            }

            console.log("✅ Confirmed booking, posting to Zapier:", pendingBooking);
            await postBookingToZapier(pendingBooking);

            const finalLine = `Perfect ${pendingBooking.name}. You are all set. Thanks for calling.`;
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
            partialPhoneStore.delete(callSid);
            lastCalendarConflictStore.delete(callSid);
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
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
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
            const correctedTime = isoToTimeOnly(corrected.datetime);
            setDraft(callSid, {
              service: corrected.service,
              stylist: corrected.stylist,
              datetime: corrected.datetime,
              name: corrected.name,
              phone: corrected.phone,
              date: isoToDateOnly(corrected.datetime) || draftNow.date,
              time: correctedTime || draftNow.time,
            });

            const pretty = formatTorontoConfirm(corrected.datetime) || corrected.datetime;
            const line = `Got it — updating that to ${pretty}. Is that correct?`;
            const audio = await ttsWithRetry(line);
            const id = uuidv4();
            audioStore.set(id, audio);

            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
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
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
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
            const correctedTime = isoToTimeOnly(corrected.datetime);
            setDraft(callSid, {
              service: corrected.service,
              stylist: corrected.stylist,
              datetime: corrected.datetime,
              name: corrected.name,
              phone: corrected.phone,
              date: isoToDateOnly(corrected.datetime) || draftNow.date,
              time: correctedTime || draftNow.time,
            });

            const pretty = formatTorontoConfirm(corrected.datetime) || corrected.datetime;
            const line = `Got it — updating that to ${pretty}. Is that correct?`;
            const audio = await ttsWithRetry(line);
            const id = uuidv4();
            audioStore.set(id, audio);

            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
            return;
          }

          const line = "Sorry, I just need a quick yes or no. Should I finalize this booking?";
          const audio = await ttsWithRetry(line);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
          return;
        }

        // ---- PHONE CONFIRM FLOW (server-controlled) ----
        const maybePhone = extractLikelyPhoneFromSpeech(userSpeech);
        const maybePhoneDigits = normalizePhone(maybePhone);
        const draftForPhone = getDraft(callSid);
        const expectingPhoneNow =
          !draftForPhone.phone &&
          getNextMissingQuestion(draftForPhone) === "What is the best 10 digit phone number for the booking?";
        const hasPhoneIntent = /\b(phone|number|digits?)\b/.test(cleanSpeech(userSpeech));

        // A) If we are waiting on "yes/no" to confirm phone
        if (awaitingPhoneConfirm.has(callSid)) {
          const pendingPhone = normalizePhone(awaitingPhoneConfirm.get(callSid));
          if (!isLikelyNorthAmericanPhone(pendingPhone)) {
            awaitingPhoneConfirm.delete(callSid);
            const line = "Sorry, I missed that number. Please say the full 10-digit phone number again, one digit at a time.";
            const audio = await ttsWithRetry(line);
            const id = uuidv4();
            audioStore.set(id, audio);

            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
            return;
          }

          if (isYes(userSpeech)) {
            setDraft(callSid, { phone: pendingPhone });
            messages.push({
              role: "system",
              content: `Caller phone confirmed: ${pendingPhone}. Do NOT ask for phone again.`,
            });
            awaitingPhoneConfirm.delete(callSid);
            partialPhoneStore.delete(callSid);

            const draftNow = getDraft(callSid);
            const completeFromDraft = draftToBookAction(draftNow);
            if (completeFromDraft) {
              const availability = await checkGoogleCalendarAvailability(completeFromDraft);
              if (!availability.available) {
                const keepDate = isoToDateOnly(completeFromDraft.datetime) || draftNow.date || "";
                setDraft(callSid, { datetime: "", date: keepDate, time: null });
                lastCalendarConflictStore.set(callSid, {
                  dateISO: keepDate,
                  service: completeFromDraft.service || draftNow.service || "",
                  createdAt: Date.now(),
                });

                const line = calendarUnavailableLine(availability, false);
                const audio = await ttsWithRetry(line);
                const id = uuidv4();
                audioStore.set(id, audio);

                entry.ready = true;
                entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
                return;
              }

              const bizViolation = getBusinessViolation(completeFromDraft.datetime);
              if (bizViolation === "closed_day") {
                const line = "We're closed on Sundays. What day works for you Monday through Saturday?";
                const audio = await ttsWithRetry(line);
                const id = uuidv4();
                audioStore.set(id, audio);

                setDraft(callSid, { datetime: "", date: "", time: null });
                entry.ready = true;
                entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
                return;
              }
              if (bizViolation === "outside_hours") {
                const line = "We book between 9 AM and 5 PM. What time in that window works for you?";
                const audio = await ttsWithRetry(line);
                const id = uuidv4();
                audioStore.set(id, audio);

                const keepDate = isoToDateOnly(completeFromDraft.datetime) || draftNow.date || "";
                setDraft(callSid, { datetime: "", date: keepDate, time: null });
                entry.ready = true;
                entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
                return;
              }

              completeFromDraft._createdAt = Date.now();
              pendingBookings.set(callSid, completeFromDraft);
              const pretty = formatTorontoConfirm(completeFromDraft.datetime) || completeFromDraft.datetime;
              const confirmLine = `Just to confirm, a ${completeFromDraft.service} with ${completeFromDraft.stylist} on ${pretty}, correct?`;

              const audio = await ttsWithRetry(confirmLine);
              const id = uuidv4();
              audioStore.set(id, audio);

              entry.ready = true;
              entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
              return;
            }

            const nextQuestion = getNextMissingQuestion(draftNow);
            const line = nextQuestion ? `Perfect. ${nextQuestion}` : "Perfect. How can I help with the booking?";
            const audio = await ttsWithRetry(line);
            const id = uuidv4();
            audioStore.set(id, audio);

            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
            return;
          }

          if (isNo(userSpeech)) {
            awaitingPhoneConfirm.delete(callSid);
            partialPhoneStore.delete(callSid);

            const line = "No worries — can you say the full 10-digit phone number again, one digit at a time?";
            const audio = await ttsWithRetry(line);
            const id = uuidv4();
            audioStore.set(id, audio);

            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
            return;
          }

          // unclear response: ask again
          const spokenPhone = speakDigits(pendingPhone);
          const line = spokenPhone
            ? `Just to confirm — is your number ${spokenPhone}?`
            : "Sorry, I missed that number. Please say the full 10-digit phone number again, one digit at a time.";
          const audio = await ttsWithRetry(line);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
          return;
        }

        // B) Collect phone digits (supports split utterances like "905", then remaining digits)
        if (!draftForPhone.phone) {
          const currentFullPhone = isLikelyNorthAmericanPhone(maybePhoneDigits)
            ? normalizePhone(maybePhoneDigits)
            : "";
          const treatAsFreshAttempt = maybePhoneDigits.length >= 9;
          if (treatAsFreshAttempt) partialPhoneStore.delete(callSid);
          const previousPartial = (currentFullPhone || treatAsFreshAttempt) ? "" : (partialPhoneStore.get(callSid) || "");
          const shouldTreatAsPhone =
            expectingPhoneNow || hasPhoneIntent || previousPartial.length > 0 || maybePhoneDigits.length >= 7;
          if (shouldTreatAsPhone && maybePhoneDigits) {
            if (currentFullPhone) {
              partialPhoneStore.delete(callSid);
              awaitingPhoneConfirm.set(callSid, currentFullPhone);

              const spokenPhone = speakDigits(currentFullPhone);
              const line = spokenPhone
                ? `Just to confirm — is your number ${spokenPhone}?`
                : "Sorry, I missed that number. Please say the full 10-digit phone number again, one digit at a time.";
              const audio = await ttsWithRetry(line);
              const id = uuidv4();
              audioStore.set(id, audio);

              entry.ready = true;
              entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
              return;
            }

            const minimumChunk = previousPartial.length > 0 ? 1 : 3;
            if (maybePhoneDigits.length < minimumChunk) {
              const line = "Please say your full 10-digit phone number, one digit at a time.";
              const audio = await ttsWithRetry(line);
              const id = uuidv4();
              audioStore.set(id, audio);

              entry.ready = true;
              entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
              return;
            }

            const combinedRaw = `${previousPartial}${maybePhoneDigits}`.replace(/\D/g, "");
            if (combinedRaw.length < 10) {
              partialPhoneStore.set(callSid, combinedRaw);
              const line = "Thanks. Please say the remaining digits.";
              const audio = await ttsWithRetry(line);
              const id = uuidv4();
              audioStore.set(id, audio);

              entry.ready = true;
              entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
              return;
            }

            const cleanPhone = selectBestPhoneDigits(combinedRaw);
            partialPhoneStore.delete(callSid);
            if (!isLikelyNorthAmericanPhone(cleanPhone)) {
              const line = "That didn’t sound like a valid 10-digit number. Please say it again, one digit at a time.";
              const audio = await ttsWithRetry(line);
              const id = uuidv4();
              audioStore.set(id, audio);

              entry.ready = true;
              entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
              return;
            }

            awaitingPhoneConfirm.set(callSid, cleanPhone);

          const spokenPhone = speakDigits(cleanPhone);
          const line = spokenPhone
            ? `Just to confirm — is your number ${spokenPhone}?`
            : "Sorry, I missed that number. Please say the full 10-digit phone number again, one digit at a time.";
          const audio = await ttsWithRetry(line);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
          return;
        }
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
          const draftBeforeActionMerge = getDraft(callSid);
          action = mergeBookActionWithDraft(action, draftBeforeActionMerge);

          const patchFromAction = {};
          if (action.service) patchFromAction.service = action.service;
          if (action.stylist) patchFromAction.stylist = action.stylist;
          if (action.name) patchFromAction.name = action.name;
          if (action.phone && isLikelyNorthAmericanPhone(action.phone)) {
            patchFromAction.phone = normalizePhone(action.phone);
          }
          const shouldAcceptActionDatetime = Boolean(
            action.datetime &&
            (!draftBeforeActionMerge.datetime || finalResolvedISO)
          );
          if (shouldAcceptActionDatetime) {
            patchFromAction.datetime = action.datetime;
            const adt = DateTime.fromISO(action.datetime, { zone: BOT_TZ });
            if (adt.isValid) {
              const d = adt.toFormat("yyyy-LL-dd");
              patchFromAction.date = d;
              patchFromAction.time = { hour: adt.hour, minute: adt.minute };
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
          partialPhoneStore.delete(callSid);
          lastCalendarConflictStore.delete(callSid);
          lastResolvedDateStore.delete(callSid);
          return;
        }

        let spoken = reply.replace(/ACTION_JSON:[\s\S]*$/, "").trim() || "Got it.";
        spoken = sanitizeSpoken(spoken);
        const latestDraft = getDraft(callSid);
        if (!pendingBookings.get(callSid) && assistantSeemsToRecapBooking(spoken)) {
          const fromDraft = draftToBookAction(latestDraft);
          if (fromDraft) {
            action = fromDraft;
            spoken = "";
          } else {
            spoken = getNextMissingQuestion(latestDraft) || "What detail should I update for the booking?";
          }
        }
        if (latestDraft.name && assistantSeemsToAskForName(spoken)) {
          spoken = getNextMissingQuestion(latestDraft) || "Perfect.";
        }
        if (latestDraft.datetime && assistantSeemsToAskForTime(spoken)) {
          spoken = getNextMissingQuestion(latestDraft) || "Great. What’s your name for the booking?";
        }

        if (action?.action === "book" && !isCompleteBooking(action)) {
          spoken = getNextMissingQuestion(getDraft(callSid)) || "What detail should I update for the booking?";
        }

        if (isCompleteBooking(action)) {
          const availability = await checkGoogleCalendarAvailability(action);
          if (!availability.available) {
            const line = calendarUnavailableLine(availability, false);
            const audio = await ttsWithRetry(line);
            const id = uuidv4();
            audioStore.set(id, audio);

            const keepDate = isoToDateOnly(action.datetime) || getDraft(callSid).date || "";
            setDraft(callSid, { datetime: "", date: keepDate, time: null });
            lastCalendarConflictStore.set(callSid, {
              dateISO: keepDate,
              service: action.service || getDraft(callSid).service || "",
              createdAt: Date.now(),
            });
            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
            return;
          }

          const bizViolation = getBusinessViolation(action.datetime);
          if (bizViolation === "closed_day") {
            const line = "We're closed on Sundays. What day works for you Monday through Saturday?";
            const audio = await ttsWithRetry(line);
            const id = uuidv4();
            audioStore.set(id, audio);

            setDraft(callSid, { datetime: "", date: "", time: null });
            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
            return;
          }
          if (bizViolation === "outside_hours") {
            const line = "We book between 9 AM and 5 PM. What time in that window works for you?";
            const audio = await ttsWithRetry(line);
            const id = uuidv4();
            audioStore.set(id, audio);

            const keepDate = isoToDateOnly(action.datetime) || getDraft(callSid).date || "";
            setDraft(callSid, { datetime: "", date: keepDate, time: null });
            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
            return;
          }

          action.phone = normalizePhone(action.phone);
          action._createdAt = Date.now();
          setDraft(callSid, {
            service: action.service,
            stylist: action.stylist,
            datetime: action.datetime,
            name: action.name,
            phone: action.phone,
            time: isoToTimeOnly(action.datetime),
          });
          pendingBookings.set(callSid, action);

          const pretty = formatTorontoConfirm(action.datetime) || action.datetime;
          const confirmLine = `Just to confirm, a ${action.service} with ${action.stylist} on ${pretty}, correct?`;

          const audio = await ttsWithRetry(confirmLine);
          const id = uuidv4();
          audioStore.set(id, audio);

          entry.ready = true;
          entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
          return;
        }

        const audio = await ttsWithRetry(spoken);
        const id = uuidv4();
        audioStore.set(id, audio);

        entry.ready = true;
        entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
</Response>`;
      } catch (e) {
        console.log("❌ Background turn error", e?.stack || e?.message || e);
        const repeatId = clipIds.repeat || (await ensureClip("repeat", "Sorry—could you say that again?"));

        entry.ready = true;
        entry.twiml = `<Response>
  <Play>${host}/audio/${repeatId}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
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
  <Gather input="speech" action="${getHost(req)}/voice/turn" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
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
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
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
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" timeout="60" actionOnEmptyResult="true" />
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
    GOOGLE_CALENDAR_ID: process.env.GOOGLE_CALENDAR_ID ? "set" : "missing",
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? "set" : "missing",
    GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL ? "set" : "missing",
    GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY ? "set" : "missing",
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
