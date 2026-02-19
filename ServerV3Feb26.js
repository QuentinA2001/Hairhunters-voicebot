import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import https from "https";
import { v4 as uuidv4 } from "uuid";
import "dotenv/config";

const app = express();

// Twilio sends x-www-form-urlencoded by default
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/**
 * Set BASE_URL in Render env vars to your public URL, e.g.
 * https://hairhunters-voicebot.onrender.com
 */
const BASE_URL = process.env.BASE_URL || "";

// In-memory stores (OK for MVP; use Redis/S3 for production)
const audioStore = new Map();            // id -> Buffer(mp3)
const conversationStore = new Map();     // callSid -> messages[]
const pendingTurns = new Map();          // token -> { ready, twiml, createdAt, fillerId, fillerPlayed }
const pendingBookings = new Map();       // callSid -> action booking payload waiting for "yes"

// Keep-alive HTTP client (reduces latency)
const httpsAgent = new https.Agent({ keepAlive: true });
const http = axios.create({ httpsAgent, timeout: 12000 });

// Small helper for log redaction
const pick = (v) => (v ? String(v).slice(0, 6) + "…" : "missing");

// ---------- FILLERS (pre-generated ElevenLabs clips) ----------
const fillerText = ["One sec.", "Got it.", "Okay.", "Alright."];
const fillerIds = []; // array of mp3 ids ready to use

const clipIds = {
  repeat: null, // "Sorry—could you say that again?"
};

function pickFillerId() {
  if (!fillerIds.length) return null;
  return fillerIds[Math.floor(Math.random() * fillerIds.length)];
}

// ---------- PROMPT ----------
const SYSTEM_PROMPT = `
You are a concise, warm, bubbly phone receptionist for ${process.env.SALON_NAME || "the salon"} in ${process.env.SALON_CITY || "the city"}.

Tasks:
- Handle bookings/reschedules. Collect: name, phone (Confirm the phone number after they say it), service (haircut/colour/cut & colour), stylist (Cosmo, Vince, Cassidy), and day/time window.
- Do NOT ask for email.
- Assume timezone America/Toronto unless otherwise specified.
- Convert natural language like "Friday at 3pm" into ISO 8601 with timezone offset.
- datetime MUST be ISO format like: 2026-02-21T15:00:00-05:00
- Do NOT state the weekday (Monday/Tuesday/etc) unless the caller already said it. (The server will confirm day-of-week.)
- Keep replies SHORT (1–2 sentences). Ask ONE question at a time.
- When you say the time back to the caller to confirm, speak in natural language (NOT ISO).

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
    minute: "2-digit",
    hour12: true,
  }).format(d);

  return `${weekday}, ${datePretty} at ${timePretty}`;
}

function nowISO() {
  return new Date().toISOString();
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

function isYes(text) {
  const t = String(text || "").trim().toLowerCase();
  return /^(yes|yeah|yep|correct|that works|sounds good|ok|okay|sure|confirm)$/i.test(t);
}

function isNo(text) {
  const t = String(text || "").trim().toLowerCase();
  return /^(no|nope|not really|nah|negative)$/i.test(t);
}

// Cleanup so memory doesn't grow forever
setInterval(() => {
  // audio: keep last ~300 items
  if (audioStore.size > 300) {
    const keys = Array.from(audioStore.keys()).slice(0, audioStore.size - 300);
    keys.forEach((k) => audioStore.delete(k));
  }

  // pendingTurns: expire after 2 minutes
  const now = Date.now();
  for (const [token, v] of pendingTurns.entries()) {
    if (now - v.createdAt > 120_000) pendingTurns.delete(token);
  }
}, 30_000);

// ---------- ROUTES ----------

/**
 * Browser-friendly test endpoint (not used by Twilio)
 */
app.get("/voice/incoming", async (req, res) => {
  try {
    const greet = `Hi! Thanks for calling ${process.env.SALON_NAME || "the salon"}. How can I help you today?`;
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

/**
 * Twilio webhook for incoming calls
 */
app.post("/voice/incoming", async (req, res) => {
  const host = getHost(req);
  const actionUrl = `${host}/voice/turn`;

  try {
    const greet = `Hi! Thanks for calling ${process.env.SALON_NAME || "the salon"}. How can I help you today?`;
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

/**
 * Turn handler: respond immediately with ONE filler clip + redirect to polling.
 * Background task generates the real response + stores final TwiML in pendingTurns.
 */
app.post("/voice/turn", async (req, res) => {
  const host = getHost(req);
  const actionUrl = `${host}/voice/turn`;

  try {
    const callSid = req.body.CallSid || "no-callsid";
    const userSpeech = req.body.SpeechResult || "";

    // Init memory for this call
    if (!conversationStore.has(callSid)) {
      const now = nowISO();
      conversationStore.set(callSid, [
        {
          role: "system",
          content:
            SYSTEM_PROMPT +
            `

CURRENT_DATETIME: ${now}
Timezone: America/Toronto
Never book in the past.
If no year is specified, assume the next upcoming future date.
`,
        },
      ]);
    }

    const messages = conversationStore.get(callSid);
    messages.push({ role: "user", content: userSpeech });

    // Create pending token for this turn
    const token = uuidv4();
    const fillerId = pickFillerId();

    pendingTurns.set(token, {
      ready: false,
      twiml: "",
      createdAt: Date.now(),
      fillerId,
      fillerPlayed: false
    });

    // Background work (don’t await)
    (async () => {
      const entry = pendingTurns.get(token);
      if (!entry) return;

      try {
        // ✅ CONFIRMATION HANDLER (server-side)
        // If we already asked "confirm?", and user says YES, finalize booking now.
        const pendingBooking = pendingBookings.get(callSid);
        if (pendingBooking && isYes(userSpeech)) {
          if (!process.env.BOOKING_WEBHOOK_URL) {
            console.log("⚠️ BOOKING_WEBHOOK_URL missing; cannot post to Zapier");
          } else {
            http.post(process.env.BOOKING_WEBHOOK_URL, pendingBooking).catch(() => {});
          }

          const pretty = formatTorontoConfirm(pendingBooking.datetime) || pendingBooking.datetime;
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
          return;
        }

        // If they say NO, clear the pending booking and ask what to change.
        if (pendingBooking && isNo(userSpeech)) {
          pendingBookings.delete(callSid);

          const line = "No problem—what would you like to change? The day, the time, or the stylist?";
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

        // ---- OpenAI ----
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

        const action = extractAction(reply);
        console.log("AI RAW REPLY:", reply);
        console.log("PARSED ACTION:", action);

        // Strip ACTION_JSON for spoken text
        let spoken = reply.replace(/ACTION_JSON:[\s\S]*$/, "").trim() || "Got it.";

        // If model tries to book without full payload, keep convo going
        if (action?.action === "book" && !isCompleteBooking(action)) {
          spoken = "Quick check—what’s the best phone number to confirm the booking?";
        }

        // Transfer
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

          pendingBookings.delete(callSid);
          conversationStore.delete(callSid);
          return;
        }

        // ✅ Booking complete -> DO NOT book yet. Ask for confirmation and store it.
        if (isCompleteBooking(action)) {
          action.phone = normalizePhone(action.phone) || action.phone;

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

        // Normal turn
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

    // Immediate TwiML: play ONE filler clip (if available), then redirect to poll
    const pollUrl = `${host}/voice/turn/result?token=${encodeURIComponent(token)}`;

    if (fillerId) {
      const entry = pendingTurns.get(token);
      if (entry) entry.fillerPlayed = true;

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
    const repeatId = clipIds.repeat;
    if (repeatId) {
      return res.type("text/xml").send(
`<Response>
  <Play>${getHost(req)}/audio/${repeatId}.mp3</Play>
  <Gather input="speech" action="${getHost(req)}/voice/turn" method="POST" speechTimeout="auto" />
</Response>`
      );
    }
    return res.type("text/xml").send(
`<Response>
  <Say>Sorry—could you say that again?</Say>
  <Gather input="speech" action="${getHost(req)}/voice/turn" method="POST" speechTimeout="auto" />
</Response>`
    );
  }
});

/**
 * Poll endpoint: if not ready, DO NOT play filler again.
 * Just pause + redirect until the final TwiML is ready.
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

    // token missing/expired -> recover gracefully
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
    const repeatId = clipIds.repeat;
    if (repeatId) {
      return res.type("text/xml").send(
`<Response>
  <Play>${host}/audio/${repeatId}.mp3</Play>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`
      );
    }
    return res.type("text/xml").send(
`<Response>
  <Say>Sorry—could you say that again?</Say>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" />
</Response>`
    );
  }
});

/**
 * Audio playback endpoint Twilio hits after <Play>
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
  res.json({
    BASE_URL: process.env.BASE_URL || "missing",
    SALON_NAME: process.env.SALON_NAME || "missing",
    ELEVEN_API_KEY_len: process.env.ELEVEN_API_KEY?.length || 0,
    ELEVEN_VOICE_ID: process.env.ELEVEN_VOICE_ID || "missing",
    OPENAI_API_KEY_len: process.env.OPENAI_API_KEY?.length || 0,
    BOOKING_WEBHOOK_URL: process.env.BOOKING_WEBHOOK_URL ? "set" : "missing",
    SALON_PHONE: process.env.SALON_PHONE || "missing",
    fillerCount: fillerIds.length,
    repeatClip: clipIds.repeat ? "ready" : "missing",
    pendingTurns: pendingTurns.size,
    pendingBookings: pendingBookings.size,
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

// Warm fillers first (fast playback), then listen
(async () => {
  await warmFillers();
  app.listen(PORT, () => console.log(`Voice bot running on port ${PORT}`));
})();
