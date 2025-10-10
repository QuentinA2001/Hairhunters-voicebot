// server.js — Hair Hunters voice bot (Render + Twilio + ElevenLabs + OpenAI)
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import "dotenv/config";

// --- Optional: basic auth header for Twilio REST
const twilioBasicAuth = () =>
  Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- In‑memory stores ---
const audioStore = new Map(); // id -> Buffer
const callState = new Map(); // CallSid -> { lastSpoken: string }

// --- helpers ---
const pick = (v) => (v ? String(v).slice(0, 6) + "…" : "missing");

function extractAction(text) {
  const m = text?.match(/ACTION_JSON:\s*(\{.*\})/s);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

async function tts(text) {
  const safe = String(text ?? "").slice(0, 800);
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVEN_VOICE_ID}/stream`;
  try {
    const resp = await axios.post(
      url,
      { text: safe, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.4, similarity_boost: 0.8 } },
      {
        headers: {
          "xi-api-key": process.env.ELEVEN_API_KEY,
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
      voice: process.env.ELEVEN_VOICE_ID,
      key: pick(process.env.ELEVEN_API_KEY),
    });
    throw e;
  }
}

async function sayAndGather({ req, res, text, callSid }) {
  const spoken = String(text ?? "").trim() || "Got it.";
  // remember last prompt per call
  if (callSid) {
    const st = callState.get(callSid) || {};
    st.lastSpoken = spoken;
    callState.set(callSid, st);
  }
  try {
    const audio = await tts(spoken);
    const id = uuidv4();
    audioStore.set(id, audio);
    return res
      .type("text/xml")
      .send(
        `<Response>\n  <Play>https://${req.headers.host}/audio/${id}.mp3</Play>\n  <Gather input="speech" action="/voice/turn" method="POST" speechTimeout="auto" />\n</Response>`
      );
  } catch {
    return res
      .type("text/xml")
      .send(
        `<Response>\n  <Say>${spoken}</Say>\n  <Gather input="speech" action="/voice/turn" method="POST" speechTimeout="auto" />\n</Response>`
      );
  }
}

// --- LLM prompt with full action set ---
const SYSTEM_PROMPT = `
You are a concise, warm phone receptionist for ${process.env.SALON_NAME} in ${process.env.SALON_CITY}.
General rules:
- Keep replies SHORT (1–2 sentences). Ask ONE question at a time.
- Never invent data; ask for missing fields.
- If the caller asks for a person/human/manager/desk, transfer them.
- If address is requested, you may directly speak: "${process.env.SALON_ADDRESS}".

Primary task: handle bookings/reschedules/cancellations. Collect fields:
- name, phone, email,
- service: cut | colour | cut+colour (or other),
- stylist (optional),
- day/time window (date + rough time or exact datetime).

When you want the server to DO something, output exactly ONE of these lines and NOTHING ELSE:
ACTION_JSON: {"action":"confirm","summary":"<short confirmation of the appointment details>"}
ACTION_JSON: {"action":"book","service":"...","stylist":"...","datetime":"...","name":"...","phone":"...","email":"..."}
ACTION_JSON: {"action":"reschedule","booking_id":"...","datetime":"..."}
ACTION_JSON: {"action":"cancel","booking_id":"..."}
ACTION_JSON: {"action":"transfer"}
ACTION_JSON: {"action":"info","topic":"hours|address|prices|services|parking|website"}
ACTION_JSON: {"action":"send_sms","to":"+1...","text":"..."}
ACTION_JSON: {"action":"voicemail","reason":"..."}
ACTION_JSON: {"action":"reprompt"}
ACTION_JSON: {"action":"end"}

Notes:
- Use confirm before book when all fields are gathered; after caller says yes, send book.
- Use reschedule/cancel only if the caller clearly references an existing appointment.
- Use reprompt if caller says "what?" or you need to repeat last question.
- For basic Qs about hours/address/prices/services/parking/website, prefer the info action.
- Keep the flow moving: always end with a clear next question unless you output an ACTION_JSON.
`;

async function chatReply(userText) {
  const r = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText || "Caller joined the line." },
      ],
    },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  );
  return r.data.choices?.[0]?.message?.content?.trim() || "Sorry, could you repeat that?";
}

// --- Twilio Voice webhooks ---
app.post("/voice/incoming", async (req, res) => {
  const greet = `Hi! Thanks for calling ${process.env.SALON_NAME}. How can I help you today?`;
  const callSid = req.body.CallSid || uuidv4();
  callState.set(callSid, { lastSpoken: greet });
  try {
    const audio = await tts(greet);
    const id = uuidv4();
    audioStore.set(id, audio);
    res
      .type("text/xml")
      .send(
        `<Response>\n  <Play>https://${req.headers.host}/audio/${id}.mp3</Play>\n  <Gather input="speech" action="/voice/turn" method="POST" speechTimeout="auto" />\n</Response>`
      );
  } catch {
    res
      .type("text/xml")
      .send(
        `<Response>\n  <Say>Welcome to ${process.env.SALON_NAME}. Please tell me what you need.</Say>\n  <Gather input="speech" action="/voice/turn" method="POST" speechTimeout="auto" />\n</Response>`
      );
  }
});

app.post("/voice/turn", async (req, res) => {
  const userSpeech = req.body.SpeechResult || "";
  const callSid = req.body.CallSid || undefined;

  let reply;
  try {
    reply = await chatReply(userSpeech);
  } catch {
    reply = "Sorry, I had trouble understanding that. Could you say it again?";
  }

  const action = extractAction(reply);

  // --- ACTION HANDLERS ---
  if (action?.action === "transfer" && process.env.SALON_PHONE) {
    return res
      .type("text/xml")
      .send(
        `<Response>\n  <Say>Okay, I’ll connect you to the salon now.</Say>\n  <Dial>${process.env.SALON_PHONE}</Dial>\n</Response>`
      );
  }

  if (action?.action === "end") {
    return res
      .type("text/xml")
      .send(`<Response><Say>Thanks for calling. Have a great day!</Say><Hangup/></Response>`);
  }

  if (action?.action === "reprompt") {
    const st = callState.get(callSid) || {};
    const repeat = st.lastSpoken || "Could you please repeat that?";
    return sayAndGather({ req, res, text: repeat, callSid });
  }

  if (action?.action === "info") {
    let say = "One moment.";
    const t = (s) => (s ? String(s) : undefined);
    if (action.topic === "hours" && process.env.SALON_HOURS) say = `Our hours are ${process.env.SALON_HOURS}.`;
    if (action.topic === "address" && process.env.SALON_ADDRESS) say = `We're at ${process.env.SALON_ADDRESS}.`;
    if (action.topic === "prices" && process.env.SALON_PRICES) say = `Prices: ${process.env.SALON_PRICES}.`;
    if (action.topic === "services" && process.env.SALON_SERVICES) say = `Services: ${process.env.SALON_SERVICES}.`;
    if (action.topic === "parking" && process.env.SALON_PARKING) say = `Parking: ${process.env.SALON_PARKING}.`;
    if (action.topic === "website" && process.env.SALON_WEBSITE) say = `Our website is ${process.env.SALON_WEBSITE}.`;
    return sayAndGather({ req, res, text: say, callSid });
  }

  if (action?.action === "send_sms") {
    try {
      const body = new URLSearchParams();
      body.set("To", action.to);
      body.set("Body", action.text);
      if (process.env.TWILIO_MESSAGING_SID) {
        body.set("MessagingServiceSid", process.env.TWILIO_MESSAGING_SID);
      } else {
        body.set("From", process.env.SALON_TWILIO_NUMBER);
      }
      await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
        body,
        {
          headers: {
            Authorization: `Basic ${twilioBasicAuth()}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          timeout: 10000,
        }
      );
      return sayAndGather({ req, res, text: "I just sent that text.", callSid });
    } catch (e) {
      console.error("SMS send failed", e?.response?.data || e);
      return sayAndGather({ req, res, text: "I couldn't send the text just now.", callSid });
    }
  }

  if (action?.action === "voicemail") {
    const reason = action.reason ? String(action.reason) : "";
    return res
      .type("text/xml")
      .send(
        `<Response>\n  <Say>I'm sorry we can't take the call right now. Please leave a message after the tone.</Say>\n  <Record maxLength="90" playBeep="true" action="/voice/voicemail-done" method="POST"/>\n</Response>`
      );
  }

  if (action?.action === "confirm") {
    const summary = action.summary || "I have your booking ready. Shall I lock it in?";
    return sayAndGather({ req, res, text: summary, callSid });
  }

  if (action?.action === "book" && process.env.BOOKING_WEBHOOK_URL) {
    axios.post(process.env.BOOKING_WEBHOOK_URL, action).catch(() => {});
    return sayAndGather({ req, res, text: "All set! Your appointment is booked.", callSid });
  }

  if (action?.action === "reschedule" && process.env.BOOKING_WEBHOOK_URL) {
    axios.post(process.env.BOOKING_WEBHOOK_URL, action).catch(() => {});
    return sayAndGather({ req, res, text: "Done. Your appointment has been rescheduled.", callSid });
  }

  if (action?.action === "cancel" && process.env.BOOKING_WEBHOOK_URL) {
    axios.post(process.env.BOOKING_WEBHOOK_URL, action).catch(() => {});
    return sayAndGather({ req, res, text: "Okay, that appointment is canceled.", callSid });
  }

  // --- Default: speak model's reply (minus any ACTION_JSON suffix) ---
  const spoken = (action ? "" : reply.replace(/ACTION_JSON:[\s\S]*$/, "").trim()) || "Got it.";
  return sayAndGather({ req, res, text: spoken, callSid });
});

// --- Voicemail completion ---
app.post("/voice/voicemail-done", async (req, res) => {
  try {
    const payload = {
      action: "voicemail",
      from: req.body.From,
      recordingUrl: req.body.RecordingUrl,
      transcriptionText: req.body.TranscriptionText || undefined,
    };
    if (process.env.BOOKING_WEBHOOK_URL) {
      axios.post(process.env.BOOKING_WEBHOOK_URL, payload).catch(() => {});
    }
  } catch (e) {
    console.error("Voicemail post failed", e?.response?.data || e);
  }
  res.type("text/xml").send(`<Response><Say>Thanks! We'll get back to you shortly.</Say><Hangup/></Response>`);
});

// --- audio serving ---
app.get("/audio/:id.mp3", (req, res) => {
  const id = (req.params.id || "").replace(".mp3", "");
  const buf = audioStore.get(id);
  if (!buf) return res.status(404).end();
  res.set("Content-Type", "audio/mpeg");
  res.send(buf);
});

// --- diagnostics ---
app.get("/env-check", (_, res) => {
  res.json({
    ELEVEN_API_KEY_len: process.env.ELEVEN_API_KEY?.length || 0,
    ELEVEN_VOICE_ID: process.env.ELEVEN_VOICE_ID || "missing",
    OPENAI_API_KEY_len: process.env.OPENAI_API_KEY?.length || 0,
    SALON_PHONE: process.env.SALON_PHONE || "missing",
    SALON_ADDRESS: process.env.SALON_ADDRESS || "missing",
    SALON_HOURS: process.env.SALON_HOURS || "missing",
    SALON_PRICES: process.env.SALON_PRICES || "missing",
    SALON_SERVICES: process.env.SALON_SERVICES || "missing",
    SALON_PARKING: process.env.SALON_PARKING || "missing",
    SALON_WEBSITE: process.env.SALON_WEBSITE || "missing",
    TWILIO_MESSAGING_SID: process.env.TWILIO_MESSAGING_SID ? "set" : "missing",
    SALON_TWILIO_NUMBER: process.env.SALON_TWILIO_NUMBER || "missing",
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

