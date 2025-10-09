// server.js  (CommonJS)
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// in-memory audio store
const audioStore = new Map();

// --- helpers ---
async function chatReply(userText) {
  const systemPrompt = `
You are a friendly phone receptionist for ${process.env.SALON_NAME} in ${process.env.SALON_CITY}.
Collect service, stylist preference, day/time, name, phone, email.
If caller asks for address, answer: ${process.env.SALON_ADDRESS}.
If caller asks for a human, respond with: ACTION_JSON: {"action":"transfer"}.
When you have all booking fields, respond ending with:
ACTION_JSON: {"action":"book","service":"<service>","stylist":"<stylist>","datetime":"<date>","name":"<name>","phone":"<phone>","email":"<email>"}
  `.trim();

  const r = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText || "Caller joined the line." }
      ]
    },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  );

  return r.data.choices[0].message.content;
}

async function synthesizeVoice(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVEN_VOICE_ID}/stream`;
  const { data } = await axios.post(
    url,
    {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.4, similarity_boost: 0.8 }
    },
    {
      headers: {
        "xi-api-key": process.env.ELEVEN_API_KEY,
        "Accept": "audio/mpeg",
        "Content-Type": "application/json"
      },
      responseType: "arraybuffer"
    }
  );
  return Buffer.from(data);
}

function extractActionJSON(text) {
  const m = text.match(/ACTION_JSON:\s*(\{.*\})/s);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// --- routes ---

// serve generated audio
app.get("/audio/:id.mp3", (req, res) => {
  const buf = audioStore.get(req.params.id.replace(".mp3",""));
  if (!buf) return res.status(404).end();
  res.set("Content-Type", "audio/mpeg");
  res.send(buf);
});

// first hook Twilio hits
app.post("/voice/incoming", async (req, res) => {
  try {
    const greet = `Hi! Thanks for calling ${process.env.SALON_NAME}. Are you looking to book, reschedule, or ask a quick question?`;
    const audio = await synthesizeVoice(greet);
    const id = uuidv4();
    audioStore.set(id, audio);

    // TwiML (XML) response from Node.js:
    res.type("text/xml").send(`
      <Response>
        <Play>https://${req.headers.host}/audio/${id}.mp3</Play>
        <Gather input="speech" action="/voice/turn" speechTimeout="auto" />
      </Response>
    `);
  } catch (e) {
    console.error("incoming error:", e);
    res.type("text/xml").send(`<Response><Say>Sorry, I’m having trouble.</Say></Response>`);
  }
});

// subsequent turns
app.post("/voice/turn", async (req, res) => {
  try {
    const userSpeech = req.body.SpeechResult || "";
    const reply = await chatReply(userSpeech);

    // transfer to human?
    const action = extractActionJSON(reply);
    if (action?.action === "transfer" && process.env.SALON_PHONE) {
      return res.type("text/xml").send(`
        <Response>
          <Say>Okay, I’ll connect you now.</Say>
          <Dial>${process.env.SALON_PHONE}</Dial>
        </Response>
      `);
    }

    // (optional) send booking payload to your webhook
    if (action?.action === "book" && process.env.BOOKING_WEBHOOK_URL) {
      try { await axios.post(process.env.BOOKING_WEBHOOK_URL, action); } catch {}
    }

    // cap speech length to avoid 64KB TwiML
    const MAX_TTS_CHARS = 800;
    const speak = reply.replace(/ACTION_JSON:[\s\S]*$/,"").trim().slice(0, MAX_TTS_CHARS);

    const audio = await synthesizeVoice(speak || "Could you repeat that?");
    const id = uuidv4();
    audioStore.set(id, audio);

    res.type("text/xml").send(`
      <Response>
        <Play>https://${req.headers.host}/audio/${id}.mp3</Play>
        <Gather input="speech" action="/voice/turn" speechTimeout="auto" />
      </Response>
    `);
  } catch (e) {
    console.error("turn error:", e);
    res.type("text/xml").send(`
      <Response>
        <Say>Sorry, I hit a snag. Please say that again.</Say>
        <Gather input="speech" action="/voice/turn" speechTimeout="auto" />
      </Response>
    `);
  }
});

app.get("/", (_req, res) => res.send("Hair Hunters Voicebot is running ✅"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Voice bot running on port ${PORT}`));