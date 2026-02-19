import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import https from "https";
import { v4 as uuidv4 } from "uuid";
import "dotenv/config";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const BASE_URL = process.env.BASE_URL || "";

const audioStore = new Map();
const conversationStore = new Map();
const pendingTurns = new Map();
const pendingBookings = new Map();

const httpsAgent = new https.Agent({ keepAlive: true });
const http = axios.create({ httpsAgent, timeout: 12000 });

// ---------- PROMPT ----------
const SYSTEM_PROMPT = `
You are a concise, warm receptionist.

Collect:
- name
- phone
- service
- stylist
- date/time

DO NOT confirm bookings.
DO NOT summarize bookings.
DO NOT output natural confirmations.

When ready:
ACTION_JSON: {"action":"book","service":"...","stylist":"...","datetime":"ISO","name":"...","phone":"..."}
`;

// ---------- HELPERS ----------
function extractAction(text) {
  const m = text?.match(/ACTION_JSON:\s*(\{.*\})/s);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function getHost(req) {
  return BASE_URL || `https://${req.headers.host}`;
}

function isYes(text) {
  return /^(yes|yeah|yep|ok|okay|sure)$/i.test(text || "");
}

function isNo(text) {
  return /^(no|nope|nah)$/i.test(text || "");
}

function normalizePhone(s) {
  return String(s || "").replace(/\D/g, "").slice(-10);
}

function isCompleteBooking(a) {
  return a?.service && a?.stylist && a?.datetime && a?.name && a?.phone;
}

function wantsHuman(text) {
  return /(human|manager|person|staff|desk)/i.test(text || "");
}

function sanitizeSpoken(text) {
  return text.replace(/\d{4}-\d{2}-\d{2}T[^\s]+/g, "");
}

function formatTorontoConfirm(iso) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(d);
}

// ---------- TTS ----------
async function tts(text) {
  const resp = await http.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVEN_VOICE_ID}/stream`,
    {
      text,
      model_id: "eleven_multilingual_v2"
    },
    {
      headers: {
        "xi-api-key": process.env.ELEVEN_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      responseType: "arraybuffer"
    }
  );
  return Buffer.from(resp.data);
}

async function ttsWithRetry(text) {
  try { return await tts(text); }
  catch { return await tts(text); }
}

// ---------- ZAPIER ----------
async function postBooking(action) {
  const resp = await http.post(process.env.BOOKING_WEBHOOK_URL, action, {
    validateStatus: () => true
  });

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error("Zapier failed");
  }
}

// ---------- ROUTES ----------

app.post("/voice/incoming", async (req, res) => {
  const host = getHost(req);
  const greet = "Hi! Thanks for calling. How can I help you today?";

  const audio = await ttsWithRetry(greet);
  const id = uuidv4();
  audioStore.set(id, audio);

  res.type("text/xml").send(`
<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${host}/voice/turn" method="POST"/>
</Response>
`);
});

app.post("/voice/turn", async (req, res) => {
  const host = getHost(req);
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || "";

  if (!conversationStore.has(callSid)) {
    conversationStore.set(callSid, [
      { role: "system", content: SYSTEM_PROMPT }
    ]);
  }

  const messages = conversationStore.get(callSid);
  messages.push({ role: "user", content: userSpeech });

  const pending = pendingBookings.get(callSid);

  // ✅ YES CONFIRMATION
  if (pending && isYes(userSpeech)) {
    try {
      await postBooking(pending);

      const msg = `Perfect ${pending.name}, you're booked for ${formatTorontoConfirm(pending.datetime)}.`;
      const audio = await ttsWithRetry(msg);
      const id = uuidv4();
      audioStore.set(id, audio);

      pendingBookings.delete(callSid);
      conversationStore.delete(callSid);

      return res.type("text/xml").send(`
<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Hangup/>
</Response>
`);
    } catch {
      const msg = "Something went wrong booking that. Want to try again?";
      const audio = await ttsWithRetry(msg);
      const id = uuidv4();
      audioStore.set(id, audio);

      return res.type("text/xml").send(`
<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${host}/voice/turn" method="POST"/>
</Response>
`);
    }
  }

  // ❌ NO → restart
  if (pending && isNo(userSpeech)) {
    pendingBookings.delete(callSid);
  }

  // 🤖 AI CALL
  const ai = await http.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages
    },
    {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    }
  );

  const reply = ai.data.choices[0].message.content;
  messages.push({ role: "assistant", content: reply });

  const action = extractAction(reply);

  // 🚫 BLOCK RANDOM TRANSFER
  if (action?.action === "transfer" && wantsHuman(userSpeech)) {
    return res.type("text/xml").send(`
<Response>
  <Dial>${process.env.SALON_PHONE}</Dial>
</Response>
`);
  }

  // ✅ BOOKING FLOW
  if (isCompleteBooking(action)) {
    pendingBookings.set(callSid, action);

    const msg = `Just to confirm — ${action.service} with ${action.stylist} on ${formatTorontoConfirm(action.datetime)}. Does that sound right?`;
    const audio = await ttsWithRetry(msg);
    const id = uuidv4();
    audioStore.set(id, audio);

    return res.type("text/xml").send(`
<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${host}/voice/turn" method="POST"/>
</Response>
`);
  }

  // 💬 NORMAL RESPONSE
  let spoken = sanitizeSpoken(reply);

  const audio = await ttsWithRetry(spoken);
  const id = uuidv4();
  audioStore.set(id, audio);

  res.type("text/xml").send(`
<Response>
  <Play>${host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="${host}/voice/turn" method="POST"/>
</Response>
`);
});

// AUDIO
app.get("/audio/:id.mp3", (req, res) => {
  const buf = audioStore.get(req.params.id);
  if (!buf) return res.status(404).end();
  res.set("Content-Type", "audio/mpeg");
  res.send(buf);
});

app.listen(process.env.PORT || 3000);
