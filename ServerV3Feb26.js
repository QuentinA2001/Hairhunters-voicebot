import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import https from "https";
import { v4 as uuidv4 } from "uuid";
import "dotenv/config";

ffmpeg.setFfmpegPath(ffmpegPath);

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

// In-memory stores (OK for MVP; use Redis/S3 for production)
const audioStore = new Map();            // id -> Buffer(mp3)
const conversationStore = new Map();     // callSid -> messages[]
const pendingTurns = new Map();          // token -> { ready, twiml, createdAt, fillerId }
const pendingBookings = new Map();       // callSid -> booking payload waiting for confirm
const bookingDrafts = new Map();         // callSid -> { service, stylist, datetime, name, phone }  ✅ NEW

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

Rules:
- Keep replies SHORT (1–2 sentences). Ask ONE question at a time.
- Do NOT ask for email.
- Assume timezone America/Toronto unless otherwise specified.
- Do NOT state the weekday unless the caller already said it. (Server confirms weekday.)
- If caller asks for a human/manager/desk, respond with ONLY:
ACTION_JSON: {"action":"transfer"}

(When outputting ACTION_JSON, output ONLY that line.)
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
  let audio = await ttsWithRetry(text);
  audio = await mixSpeechWithAmbient(audio);
  const id = uuidv4();
  audioStore.set(id, audio);
  clipIds[kind] = id;
  return id;
}

async function warmFillers() {
  try {
    for (const line of fillerText) {
      let audio = await ttsWithRetry(line);
      audio = await mixSpeechWithAmbient(audio);
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
function getTZParts(date, timeZone = "America/Toronto") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;

  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    hh: Number(map.hour),
    mm: Number(map.minute),
    ss: Number(map.second),
  };
}

function mixSpeechWithAmbient(speechBuf, opts = {}) {
  const {
    ambientFile = path.join(process.cwd(), "assets", "shopping-mall.mp3"),
    ambientVolume = 0.18,
  } = opts;

  return new Promise((resolve, reject) => {
    const tmpIn = path.join("/tmp", `speech-${uuidv4()}.mp3`);
    const tmpOut = path.join("/tmp", `mixed-${uuidv4()}.mp3`);

    try {
      fs.writeFileSync(tmpIn, speechBuf);
    } catch (e) {
      return reject(e);
    }

    ffmpeg()
      .input(tmpIn)
      .inputOptions(["-re"])
      .input(ambientFile)
      .inputOptions(["-stream_loop", "-1"])
      .complexFilter([
        `[1:a]volume=${ambientVolume}[amb]`,
        `[0:a][amb]amix=inputs=2:duration=first:dropout_transition=0,aresample=async=1[m]`,
      ])
      .outputOptions([
        "-map", "[m]",
        "-c:a", "libmp3lame",
        "-b:a", "128k",
        "-ar", "44100",
      ])
      .on("end", () => {
        try {
          const out = fs.readFileSync(tmpOut);
          fs.unlinkSync(tmpIn);
          fs.unlinkSync(tmpOut);
          resolve(out);
        } catch (e) {
          reject(e);
        }
      })
      .on("error", (err) => {
        try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch {}
        try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
        reject(err);
      })
      .save(tmpOut);
  });
}

function zonedWallTimeToInstant({ y, m, d, hh, mm, ss }, timeZone = "America/Toronto") {
  const desiredUTC = Date.UTC(y, m - 1, d, hh, mm, ss);
  let guess = new Date(desiredUTC);
  for (let i = 0; i < 3; i++) {
    const got = getTZParts(guess, timeZone);
    const gotUTC = Date.UTC(got.y, got.m - 1, got.d, got.hh, got.mm, got.ss);
    guess = new Date(guess.getTime() + (desiredUTC - gotUTC));
  }
  return guess;
}

function formatISOWithTZOffset(date, timeZone = "America/Toronto") {
  const p = getTZParts(date, timeZone);
  const isoLocal = `${String(p.y).padStart(4, "0")}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}T${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}:${String(p.ss).padStart(2, "0")}`;

  const asUTC = new Date(Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss));
  const offsetMin = Math.round((date.getTime() - asUTC.getTime()) / 60000);

  const sign = offsetMin <= 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");

  return `${isoLocal}${sign}${oh}:${om}`;
}

function getWeekdayIndexInTZ(date, timeZone = "America/Toronto") {
  const wd = new Intl.DateTimeFormat("en-CA", { timeZone, weekday: "long" }).format(date).toLowerCase();
  const days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  return days.indexOf(wd);
}

// ✅ date resolver (weekday + next + time)
function resolveDateToISO(text) {
  const tz = "America/Toronto";
  const lower = String(text || "").toLowerCase();
  const days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];

  const now = new Date();
  const nowT = getTZParts(now, tz);
  const nowInstant = zonedWallTimeToInstant({ ...nowT }, tz);
  const todayIdx = getWeekdayIndexInTZ(nowInstant, tz);

  let targetIdx = -1;
  for (let i = 0; i < days.length; i++) {
    if (lower.includes(days[i])) { targetIdx = i; break; }
  }
  if (targetIdx === -1) return null;

  let diff = targetIdx - todayIdx;
  if (diff <= 0) diff += 7;

  // IMPORTANT: "next Wednesday" = week after the upcoming one
  if (/\bnext\b/.test(lower)) diff += 7;

  let hh = 12, mm = 0, ss = 0;

  if (/\bnoon\b/.test(lower)) {
    hh = 12; mm = 0;
  } else if (/\bmidnight\b/.test(lower)) {
    hh = 0; mm = 0;
  } else {
    const m = lower.match(/(?:\bat\b\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|(?:\bat\b\s*)(\d{1,2})(?::(\d{2}))?\b/);
    if (!m) return null;

    const hourStr = m[1] || m[4];
    const minStr  = m[2] || m[5] || "0";
    const ampm    = m[3];

    hh = parseInt(hourStr, 10);
    mm = parseInt(minStr, 10);

    if (ampm) {
      if (ampm === "pm" && hh !== 12) hh += 12;
      if (ampm === "am" && hh === 12) hh = 0;
    } else {
      if (hh >= 1 && hh <= 7) hh += 12;
    }
  }

  const targetBase = new Date(nowInstant.getTime() + diff * 24 * 60 * 60 * 1000);
  const baseParts = getTZParts(targetBase, tz);

  const targetInstant = zonedWallTimeToInstant(
    { y: baseParts.y, m: baseParts.m, d: baseParts.d, hh, mm, ss },
    tz
  );

  return formatISOWithTZOffset(targetInstant, tz);
}

function extractAction(text) {
  const m = text?.match(/ACTION_JSON:\s*(\{.*\})/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function getHost(req) {
  return BASE_URL || `https://${req.headers.host}`;
}

function formatTorontoConfirm(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;

  const weekday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    weekday: "long",
  }).format(d);

  const datePretty = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    month: "long",
    day: "numeric",
  }).format(d);

  const timePretty = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    hour: "numeric",
    minute: "numeric",
    hour12: true,
  }).format(d);

  return `${weekday}, ${datePretty} at ${timePretty}`;
}

function torontoNowString() {
  return new Date().toLocaleString("en-CA", { timeZone: "America/Toronto" });
}

function cleanSpeech(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  const t = String(text || "").toLowerCase();
  return /(human|manager|front desk|desk|reception|someone|representative|staff|person|talk to)/i.test(t);
}

// --- SLOT EXTRACTORS (server-side “memory”) ✅ NEW ---
function extractName(text) {
  const m = String(text || "").match(/\b(my name is|it'?s|i am)\s+([a-z]+(?:\s+[a-z]+)?)\b/i);
  return m ? m[2].trim() : "";
}

function extractService(text) {
  const t = String(text || "").toLowerCase();
  const hasCut = t.includes("cut") || t.includes("haircut");
  const hasColor = t.includes("colour") || t.includes("color");

  if (hasCut && hasColor) return "cut & colour";
  if (hasColor) return "colour";
  if (hasCut) return "haircut";
  return "";
}

function extractStylist(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("cassidy")) return "Cassidy";
  if (t.includes("vince")) return "Vince";
  if (t.includes("cosmo")) return "Cosmo";
  return "";
}

// digits + “nine oh five” support
function extractPhoneDigits(text) {
  const t = String(text || "").toLowerCase();

  const direct = t.replace(/\D/g, "");
  if (direct.length >= 10) return direct.slice(-10);

  const map = { zero:"0", oh:"0", o:"0", one:"1", two:"2", three:"3", four:"4", five:"5", six:"6", seven:"7", eight:"8", nine:"9" };
  const words = t.split(/\s+/);
  const joined = words.map(w => map[w] ?? "").join("");
  if (joined.length >= 10) return joined.slice(-10);

  return "";
}

function speakPhoneDigits(d10) {
  // “9055551234” -> “9 0 5 5 5 5 1 2 3 4”
  const s = String(d10 || "").replace(/\D/g, "").slice(-10);
  return s.split("").join(" ");
}

function nextMissingQuestion(d) {
  if (!d.service) return "What are you looking to book — a haircut, colour, or cut and colour?";
  if (!d.stylist) return "Do you have a stylist you want — Cosmo, Vince, or Cassidy?";
  if (!d.datetime) return "What day and time works best for you?";
  if (!d.name) return "And what’s your name?";
  if (!d.phone) return "What’s the best phone number to confirm the booking?";
  return "";
}

function isDraftComplete(d) {
  return Boolean(d.service && d.stylist && d.datetime && d.name && d.phone);
}

function sanitizeSpoken(text) {
  let out = String(text || "");

  out = out.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:\d{2}/g,
    (iso) => formatTorontoConfirm(iso) || "that time"
  );

  out = out.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "that date");
  return out;
}

/**
 * Post booking to Zapier and REQUIRE success.
 */
async function postBookingToZapier(payload) {
  const url = process.env.BOOKING_WEBHOOK_URL;
  if (!url) throw new Error("BOOKING_WEBHOOK_URL missing");

  const resp = await http.post(url, payload, {
    timeout: 5000,
    validateStatus: () => true,
    headers: { "Content-Type": "application/json" },
  });

  console.log("📨 Zapier POST result:", { status: resp.status });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Zapier returned ${resp.status}`);
  }
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

  // bookingDrafts: expire after 15 minutes
  for (const [sid, v] of bookingDrafts.entries()) {
    if (now - (v._createdAt || now) > 900_000) bookingDrafts.delete(sid);
  }
}, 30_000);

// ---------- ROUTES ----------

/**
 * Browser-friendly test endpoint (not used by Twilio)
 */
app.get("/voice/incoming", async (req, res) => {
  try {
    const greet = `Hi thanks for calling ${process.env.SALON_NAME || "the salon"}. My name is Alex. How can I help you?`;
    let audio = await ttsWithRetry(greet);
    audio = await mixSpeechWithAmbient(audio);
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

/**
 * Twilio webhook for incoming calls
 */
app.post("/voice/incoming", async (req, res) => {
  const host = getHost(req);
  const actionUrl = `${host}/voice/turn`;

  try {
    const greet = `Hi, thanks for calling ${process.env.SALON_NAME || "the salon"}. My name is Alex. How can I help you?`;
    let audio = await ttsWithRetry(greet);
    audio = await mixSpeechWithAmbient(audio);
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

/**
 * Turn handler: immediate filler + redirect polling until response is ready.
 */
app.post("/voice/turn", async (req, res) => {
  const host = getHost(req);
  const actionUrl = `${host}/voice/turn`;

  try {
    const callSid = req.body.CallSid || "no-callsid";
    const userSpeech = req.body.SpeechResult || "";

    // Init memory for this call
    if (!conversationStore.has(callSid)) {
      conversationStore.set(callSid, [
        {
          role: "system",
          content:
            SYSTEM_PROMPT +
            `

CURRENT_DATETIME_TORONTO: ${torontoNowString()}
Timezone: America/Toronto
Never book in the past.
If no year is specified, assume the next upcoming future date.
`,
        },
      ]);
    }

    // Keep the convo log (still useful for transfer requests + general chat)
    const messages = conversationStore.get(callSid);
    const resolvedISO = resolveDateToISO(userSpeech);

    messages.push({
      role: "user",
      content: resolvedISO ? `${userSpeech} (resolved datetime: ${resolvedISO})` : userSpeech
    });

    // Create pending token for this turn
    const token = uuidv4();
    const fillerId = pickFillerId();

    pendingTurns.set(token, {
      ready: false,
      twiml: "",
      createdAt: Date.now(),
      fillerId,
    });

    // Background work
    (async () => {
      const entry = pendingTurns.get(token);
      if (!entry) return;

      try {
        const pendingBooking = pendingBookings.get(callSid);

        // ✅ CONFIRM STATE: YES -> post + hangup
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
            bookingDrafts.delete(callSid);
            conversationStore.delete(callSid);
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

        // ✅ CONFIRM STATE: NO -> clear + ask correction
        if (pendingBooking && isNo(userSpeech)) {
          pendingBookings.delete(callSid);

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

        // ✅ If correcting while pending booking, keep old slots but allow new datetime
        if (pendingBooking && !isYes(userSpeech) && !isNo(userSpeech)) {
          // Put pending booking back into draft so slot flow continues cleanly
          bookingDrafts.set(callSid, {
            service: pendingBooking.service,
            stylist: pendingBooking.stylist,
            datetime: "", // force re-ask/resolution
            name: pendingBooking.name,
            phone: pendingBooking.phone,
            _createdAt: Date.now(),
          });
          pendingBookings.delete(callSid);
        }

        // -------- SERVER-SIDE SLOT MEMORY (draft) ✅ --------
        const draft = bookingDrafts.get(callSid) || { service:"", stylist:"", datetime:"", name:"", phone:"", _createdAt: Date.now() };

        // Update from this turn
        const svc = extractService(userSpeech);
        const sty = extractStylist(userSpeech);
        const dt  = resolveDateToISO(userSpeech);
        const nm  = extractName(userSpeech);
        const ph  = extractPhoneDigits(userSpeech);

        if (!draft.service && svc) draft.service = svc;
        if (!draft.stylist && sty) draft.stylist = sty;
        if (!draft.datetime && dt) draft.datetime = dt;
        if (!draft.name && nm) draft.name = nm;
        if (!draft.phone && ph) draft.phone = ph;

        // If they just gave a phone, immediately confirm it out loud (digits spaced)
        // and keep going.
        bookingDrafts.set(callSid, draft);

        const missingQ = nextMissingQuestion(draft);

        // If still missing something, ASK IT YOURSELF (skip OpenAI)
        if (missingQ) {
          // special case: if we just captured phone, confirm it in the same turn
          let line = missingQ;
          if (ph) {
            line = `Just to confirm, that’s ${speakPhoneDigits(draft.phone)}. ${missingQ}`;
          }

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

        // Draft complete -> create booking payload + ask your existing confirmation question
        if (isDraftComplete(draft)) {
          const booking = {
            action: "book",
            service: draft.service,
            stylist: draft.stylist,
            datetime: draft.datetime,
            name: draft.name,
            phone: draft.phone,
            _createdAt: Date.now(),
          };

          pendingBookings.set(callSid, booking);

          const pretty = formatTorontoConfirm(booking.datetime) || booking.datetime;
          const confirmLine = `Just to confirm: a ${booking.service} with ${booking.stylist} on ${pretty}, correct?`;

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

        // -------- OPENAI (only used for non-booking chatter / transfer requests) --------
        // If the user asked for a human, let OpenAI decide transfer only for that case
        if (wantsHuman(userSpeech)) {
          let reply = "Okay — I’ll connect you to the salon now.";

          try {
            const r = await http.post(
              "https://api.openai.com/v1/chat/completions",
              {
                model: "gpt-4o-mini",
                temperature: 0.2,
                max_tokens: 80,
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

          const action = extractAction(reply);

          if (action?.action === "transfer" && process.env.SALON_PHONE) {
            const transferLine = "Okay, I’ll connect you to the salon now.";
            const audio = await ttsWithRetry(transferLine);
            const id = uuidv4();
            audioStore.set(id, audio);

            entry.ready = true;
            entry.twiml = `<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Dial>${process.env.SALON_PHONE}</Dial>
</Response>`;
            return;
          }
        }

        // fallback
        const audio = await ttsWithRetry("Got it. What are you looking to book?");
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

    // Immediate TwiML: play ONE filler clip, then poll
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

/**
 * Poll endpoint
 */
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

/**
 * Audio playback endpoint
 */
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
    bookingDrafts: bookingDrafts.size,
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

// Warm fillers first, then listen
(async () => {
  await warmFillers();
  app.listen(PORT, () => console.log(`Voice bot running on port ${PORT}`));
})();
