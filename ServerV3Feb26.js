import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import "dotenv/config";

const app = express();

// Twilio sends x-www-form-urlencoded by default
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/**
 * Optional but recommended on Render:
 * Set BASE_URL in Render env vars to:
 * https://hairhunters-voicebot.onrender.com
 */
const BASE_URL = process.env.BASE_URL || "";

// In-memory audio store (fine for testing; for production you’d use S3/Redis)
const audioStore = new Map();

// Per-call conversation memory
const conversationStore = new Map();

const pick = (v) => (v ? String(v).slice(0, 6) + "…" : "missing");

const SYSTEM_PROMPT = `
You are a concise, warm phone receptionist for ${process.env.SALON_NAME || "the salon"} in ${process.env.SALON_CITY || "the city"}.

Tasks:
- Handle bookings/reschedules. Collect: name, phone, email, service (cut/colour/cut+colour), stylist (optional), and day/time window.
- Assume timezone America/Toronto unless otherwise specified.
- Convert natural language like "Friday at 3pm" into ISO 8601.
- datetime MUST be ISO format like: 2026-02-21T15:00:00-05:00

- Keep replies SHORT (1–2 sentences). Ask ONE question at a time.

- If caller asks for a human/manager/desk, respond with:
ACTION_JSON: {"action":"transfer"}
(When outputting ACTION_JSON, output ONLY that line.)

- When you have all booking fields, respond with:
ACTION_JSON: {"action":"book","service":"...","stylist":"...","datetime":"ISO_FORMAT","name":"...","phone":"...","email":"..."}
(When outputting ACTION_JSON, output ONLY that line.)
`;

// --- ElevenLabs TTS with logging ---
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
    const resp = await axios.post(
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
        timeout: 12000,
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

/**
 * Browser-friendly test endpoint (not used by Twilio)
 */
app.get("/voice/incoming", async (req, res) => {
  const greet = `Hi! Thanks for calling ${process.env.SALON_NAME || "the salon"}. How can I help you today?`;
  try {
    const audio = await tts(greet);
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
  <Say>${greet}</Say>
</Response>`
    );
  }
});

/**
 * Twilio webhook for incoming calls
 */
app.post("/voice/incoming", async (req, res) => {
  const greet = `Hi! Thanks for calling ${process.env.SALON_NAME || "the salon"}. How can I help you today?`;

  try {
    const audio = await tts(greet);
    const id = uuidv4();
    audioStore.set(id, audio);

    const host = getHost(req);

    return res.type("text/xml").send(
`<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="/voice/turn" method="POST" speechTimeout="auto" />
</Response>`
    );
  } catch {
    // Fallback if ElevenLabs fails
    return res.type("text/xml").send(
`<Response>
  <Say>${greet}</Say>
  <Gather input="speech" action="/voice/turn" method="POST" speechTimeout="auto" />
</Response>`
    );
  }
});

/**
 * Twilio webhook for each conversation turn
 */
app.post("/voice/turn", async (req, res) => {
  const callSid = req.body.CallSid || "no-callsid";
  const userSpeech = req.body.SpeechResult || "";

  // Init memory for this call
  if (!conversationStore.has(callSid)) {
    conversationStore.set(callSid, [{ role: "system", content: SYSTEM_PROMPT }]);
  }
  const messages = conversationStore.get(callSid);
  messages.push({ role: "user", content: userSpeech });

  // Ask OpenAI
  let reply = "Sorry, could you repeat that?";
  try {
    const r = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.4,
        messages,
      },
      {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        timeout: 12000,
      }
    );

    reply = r.data.choices?.[0]?.message?.content?.trim() || reply;
    messages.push({ role: "assistant", content: reply });
  } catch (e) {
    console.log("❌ OpenAI error", e?.response?.status, e?.response?.data || e?.message);
  }

  const action = extractAction(reply);

  // Transfer to human
  if (action?.action === "transfer" && process.env.SALON_PHONE) {
    conversationStore.delete(callSid);
    return res.type("text/xml").send(
`<Response>
  <Say>Okay, I’ll connect you to the salon now.</Say>
  <Dial>${process.env.SALON_PHONE}</Dial>
</Response>`
    );
  }

  // Book: send to webhook and end call
  if (action?.action === "book" && process.env.BOOKING_WEBHOOK_URL) {
    axios.post(process.env.BOOKING_WEBHOOK_URL, action).catch(() => {});
    conversationStore.delete(callSid);

    return res.type("text/xml").send(
`<Response>
  <Say>Your appointment request has been submitted. We look forward to seeing you.</Say>
  <Hangup/>
</Response>`
    );
  }

  // Normal speech output (strip ACTION_JSON if present)
  const spoken =
    (action ? "" : reply.replace(/ACTION_JSON:[\s\S]*$/, "").trim()) || "Got it.";

  const host = getHost(req);

  // Try ElevenLabs audio; fall back to <Say>
  try {
    const audio = await tts(spoken);
    const id = uuidv4();
    audioStore.set(id, audio);

    return res.type("text/xml").send(
`<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="/voice/turn" method="POST" speechTimeout="auto" />
</Response>`
    );
  } catch (e) {
    console.log("❌ TTS error", e?.response?.status, e?.response?.data || e?.message);
    return res.type("text/xml").send(
`<Response>
  <Say>${spoken}</Say>
  <Gather input="speech" action="/voice/turn" method="POST" speechTimeout="auto" />
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
  });
});

app.get("/tts-test", async (req, res) => {
  try {
    const audio = await tts("Hi, this is the Render server speaking. ElevenLabs is working.");
    res.set("Content-Type", "audio/mpeg");
    res.send(audio);
  } catch (err) {
    console.error("TTS test failed:", err?.response?.data || err);
    res.status(500).send("TTS failed");
  }
});

app.get("/", (_, res) => res.send("Hair Hunters Voicebot is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Voice bot running on port ${PORT}`));
