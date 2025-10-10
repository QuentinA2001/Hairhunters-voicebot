// server.js  — Hair Hunters voice bot (Render + Twilio + ElevenLabs + OpenAI)
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import "dotenv/config";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const audioStore = new Map();
const pick = (v) => (v ? String(v).slice(0, 6) + "…" : "missing");

const SYSTEM_PROMPT = `
You are a concise, warm phone receptionist for ${process.env.SALON_NAME} in ${process.env.SALON_CITY}.
Tasks:
- Handle bookings/reschedules. Collect: name, phone, email, service (cut/colour/cut+colour), stylist (optional), and day/time window.
- Keep replies SHORT (1–2 sentences). Ask ONE question at a time.
- If address is requested, say: "${process.env.SALON_ADDRESS}".
- If caller asks for a human/manager/desk, respond with:
ACTION_JSON: {"action":"transfer"}
- When you have all booking fields, respond with:
ACTION_JSON: {"action":"book","service":"...","stylist":"...","datetime":"...","name":"...","phone":"...","email":"..."}
(When outputting ACTION_JSON, output ONLY that line.)
`;

async function chatReply(userText) {
  const r = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText || "Caller joined the line." }
      ]
    },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  );
  return r.data.choices?.[0]?.message?.content?.trim() || "Sorry, could you repeat that?";
}

// --- improved ElevenLabs TTS with logging ---
async function tts(text) {
  const safe = String(text).slice(0, 800);
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVEN_VOICE_ID}/stream`;
  try {
    const resp = await axios.post(
      url,
      { text: safe, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.4, similarity_boost: 0.8 } },
      {
        headers: {
          "xi-api-key": process.env.ELEVEN_API_KEY,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg"
        },
        responseType: "arraybuffer",
        timeout: 12000
      }
    );
    const buf = Buffer.from(resp.data);
    console.log(`✅ ElevenLabs OK | bytes=${buf.length}`);
    return buf;
  } catch (e) {
    console.log("❌ ElevenLabs TTS error", {
      status: e?.response?.status,
      data: e?.response?.data?.toString?.().slice(0, 200),
      voice: process.env.ELEVEN_VOICE_ID,
      key: pick(process.env.ELEVEN_API_KEY)
    });
    throw e;
  }
}

function extractAction(text) {
  const m = text?.match(/ACTION_JSON:\s*(\{.*\})/s);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// --- Twilio webhooks ---
app.post("/voice/incoming", async (req, res) => {
  try {
    const greet = `Hi! Thanks for calling ${process.env.SALON_NAME}. Are you looking to book, reschedule, or ask a quick question?`;
    const audio = await tts(greet);
    const id = uuidv4();
    audioStore.set(id, audio);
    res.type("text/xml").send(
`<Response>
  <Play>https://${req.headers.host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="/voice/turn" method="POST" speechTimeout="auto" />
</Response>`
    );
  } catch {
    res.type("text/xml").send(
`<Response>
  <Say>Welcome to ${process.env.SALON_NAME}. Please tell me what you need.</Say>
  <Gather input="speech" action="/voice/turn" method="POST" speechTimeout="auto" />
</Response>`
    );
  }
});

app.post("/voice/turn", async (req, res) => {
  const userSpeech = req.body.SpeechResult || "";
  let reply;
  try { reply = await chatReply(userSpeech); }
  catch { reply = "Sorry, I had trouble understanding that. Could you say it again?"; }

  const action = extractAction(reply);

  if (action?.action === "transfer" && process.env.SALON_PHONE) {
    return res.type("text/xml").send(
`<Response>
  <Say>Okay, I’ll connect you to the salon now.</Say>
  <Dial>${process.env.SALON_PHONE}</Dial>
</Response>`
    );
  }

  if (action?.action === "book" && process.env.BOOKING_WEBHOOK_URL) {
    axios.post(process.env.BOOKING_WEBHOOK_URL, action).catch(() => {});
  }

  const spoken = (action ? "" : reply.replace(/ACTION_JSON:[\s\S]*$/, "").trim()) || "Got it.";
  try {
    const audio = await tts(spoken);
    const id = uuidv4();
    audioStore.set(id, audio);
    return res.type("text/xml").send(
`<Response>
  <Play>https://${req.headers.host}/audio/${id}.mp3</Play>
  <Gather input="speech" action="/voice/turn" method="POST" speechTimeout="auto" />
</Response>`
    );
  } catch {
    return res.type("text/xml").send(
`<Response>
  <Say>${spoken}</Say>
  <Gather input="speech" action="/voice/turn" method="POST" speechTimeout="auto" />
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
  res.json({
    ELEVEN_API_KEY_len: process.env.ELEVEN_API_KEY?.length || 0,
    ELEVEN_VOICE_ID: process.env.ELEVEN_VOICE_ID || "missing",
    OPENAI_API_KEY_len: process.env.OPENAI_API_KEY?.length || 0,
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
