import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import "dotenv/config";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Temporary storage for generated audio
const audioStore = new Map();

async function chatReply(userText) {
  const systemPrompt = `
You are a friendly, efficient phone receptionist for ${process.env.SALON_NAME} in ${process.env.SALON_CITY}.
Be concise, professional, and warm. Your main tasks:
1. Help clients book or reschedule hair appointments.
2. Ask for name, service (cut, colour, etc.), stylist preference, and day/time.
3. When you have enough info, end your reply with:
ACTION_JSON: {"action":"book","service":"<service>","stylist":"<stylist>","datetime":"<date>","name":"<name>","phone":"<phone>"}
Do NOT make up fake bookings.
If asked for location, say "${process.env.SALON_ADDRESS}".
If asked to speak to someone, say you'll connect them soon.
Keep answers short and natural.
  `;

  const gpt = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText || "Client joined the line." }
      ],
      temperature: 0.4
    },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  );

  return gpt.data.choices[0].message.content;
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
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      responseType: "arraybuffer"
    }
  );

  return Buffer.from(data);
}

function extractActionJSON(text) {
  const match = text.match(/ACTION_JSON:\s*(\{.*\})/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// Twilio webhook endpoints
app.post("/voice/incoming", async (req, res) => {
  const greet = `Hi! Thanks for calling ${process.env.SALON_NAME}. Are you looking to book, reschedule, or ask a quick question?`;
  const audio = await synthesizeVoice(greet);
  const id = uuidv4();
  audioStore.set(id, audio);

  res.type("text/xml").send(`
    <Response>
      <Play>https://${req.headers.host}/audio/${id}.mp3</Play>
      <Gather input="speech" action="/voice/turn" speechTimeout="auto" />
    </Response>
  `);
});

app.post("/voice/turn", async (req, res) => {
  const userSpeech = req.body.SpeechResult || "";
  const reply = await chatReply(userSpeech);

  const action = extractActionJSON(reply);
  if (action?.action === "book" && process.env.BOOKING_WEBHOOK_URL) {
    try {
      await axios.post(process.env.BOOKING_WEBHOOK_URL, action);
    } catch (e) {
      console.error("Booking webhook failed:", e.message);
    }
  }

  const cleanedReply = reply.replace(/ACTION_JSON:[\s\S]*$/, "").trim();
  const audio = await synthesizeVoice(cleanedReply);
  const id = uuidv4();
  audioStore.set(id, audio);

  res.type("text/xml").send(`
    <Response>
      <Play>https://${req.headers.host}/audio/${id}.mp3</Play>
      <Gather input="speech" action="/voice/turn" speechTimeout="auto" />
    </Response>
  `);
});

app.get("/audio/:id.mp3", (req, res) => {
  const audio = audioStore.get(req.params.id.split(".")[0]);
  if (!audio) return res.status(404).send("Audio not found");
  res.set("Content-Type", "audio/mpeg");
  res.send(audio);
});

app.get("/", (_, res) => res.send("Hair Hunters Voicebot is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Voice bot running on port ${PORT}`));