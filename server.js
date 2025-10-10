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

// --- In-memory stores ---
const audioStore = new Map(); // id -> Buffer
// CallSid -> { lastSpoken: string, history: Array<{role:string, content:string}>, slots: { name?, phone?, email?, service?, stylist?, datetime? } }
const callState = new Map();

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
    const st = callState.get(callSid) || { history: [], slots: {} };
    st.lastSpoken = spoken;
    callState.set(callSid, st);
  }
  const gather = `<Gather input="speech"
        action="/voice/turn"
        method="POST"
        speechTimeout="auto"
        actionOnEmptyResult="true"
        language="en-CA"
        enhanced="true"
        profanityFilter="false"
        speechModel="phone_call" />`;
  try {
    const audio = await tts(spoken);
    const id = uuidv4();
    audioStore.set(id, audio);
    return res
      .type("text/xml")
      .send(`\n<Response>\n  <Play>https://${req.headers.host}/audio/${id}.mp3</Play>\n  ${gather}\n</Response>`);
  } catch {
    return res
      .type("text/xml")
      .send(`\n<Response>\n  <Say>${spoken}</Say>\n  ${gather}\n</Response>`);
  }
}

// --- LLM prompt with full action set ---
const SYSTEM_PROMPT = `
You are a concise, warm phone receptionist for ${process.env.SALON_NAME} in ${process.env.SALON_CITY}.
General rules:
- Keep replies SHORT (1–2 sentences). Ask ONE question at a time.
- Never invent data; ask for missing fields.
- Do NOT re-ask for fields already provided; briefly confirm what you have and move to the next missing field.
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

// --- simple local fallback when LLM is unavailable (e.g., 429 insufficient_quota) ---
function localFallbackReply(text) {
  const s = (text || "").toLowerCase();
  if (/(manager|human|reception|front desk|real person|someone)/i.test(s)) return 'ACTION_JSON: {"action":"transfer"}';
  if (/address|where.*located|location/.test(s)) return 'ACTION_JSON: {"action":"info","topic":"address"}';
  if (/hour|open|close|closing/.test(s)) return 'ACTION_JSON: {"action":"info","topic":"hours"}';
  if (/price|cost|how much/.test(s)) return 'ACTION_JSON: {"action":"info","topic":"prices"}';
  if (/website|site|online/.test(s)) return 'ACTION_JSON: {"action":"info","topic":"website"}';
  if (/park|parking/.test(s)) return 'ACTION_JSON: {"action":"info","topic":"parking"}';

  if (/cancel/.test(s)) return 'Sure—what name is the booking under, and what date/time should I cancel?';
  if (/resched|move.*appointment|change.*time|another time/.test(s)) return 'No problem—what name is the booking under, and what new date/time works?';

  if (/(book|appointment|schedule|haircut|colour|color)/.test(s)) {
    if (!/(cut\+?colour|cut\s*\+\s*colour|colour|color|\bcut\b)/.test(s)) return 'Sure—what service would you like: cut, colour, or cut+colour?';
    if (!/(today|tomorrow|mon|tue|wed|thu|fri|sat|sun|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}(:\d{2})?\s*(am|pm)?\b)/.test(s)) return 'Great—what day and roughly what time works for you?';
    if (!/(\+?\d[\d\s\-().]{6,}\d)/.test(s)) return 'Got it—what’s the best phone number for the booking?';
    if (!/@/.test(s)) return 'And your email, so we can send a confirmation?';
    return 'ACTION_JSON: {"action":"confirm","summary":"I have your appointment noted. Shall I lock it in?"}';
  }
  if (/what|repeat|again|pardon|sorry/.test(s)) return 'ACTION_JSON: {"action":"reprompt"}';
  return "I can help with bookings, reschedules, hours, and our address—what do you need today?";
}

async function chatReply(userText, state) {
  const slotsNote = state?.slots ? `Known fields so far: ${JSON.stringify(state.slots)}` : "";
  const historyMsgs = Array.isArray(state?.history) ? state.history.slice(-8) : [];
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    slotsNote ? { role: "system", content: slotsNote } : null,
    ...historyMsgs,
    { role: "user", content: userText || "Caller joined the line." },
  ].filter(Boolean);

  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" };

  const postOnce = () => axios.post(
    "https://api.openai.com/v1/chat/completions",
    { model: "gpt-4o-mini", temperature: 0.4, messages },
    { headers, timeout: 15000 }
  );

  try {
    let r;
    try { r = await postOnce(); }
    catch (e) {
      if (e?.response?.status >= 500 || e?.code === "ECONNRESET" || e?.code === "ETIMEDOUT") {
        await new Promise((s) => setTimeout(s, 350));
        r = await postOnce();
      } else {
        throw e;
      }
    }
    return r.data.choices?.[0]?.message?.content?.trim() || localFallbackReply(userText);
  } catch (e) {
    console.error("❌ OpenAI chat error:", { status: e?.response?.status, data: e?.response?.data, message: e?.message, key_prefix: (process.env.OPENAI_API_KEY || "").slice(0,6)+"…" });
    // Use local fallback when quota/network/model fails
    return localFallbackReply(userText);
  }
}

// --- Twilio Voice webhooks ---
app.post("/voice/incoming", async (req, res) => {
  const greet = `Hi! Thanks for calling ${process.env.SALON_NAME}. How can I help you today?`;
  const callSid = req.body.CallSid || uuidv4();
  callState.set(callSid, { lastSpoken: greet, history: [], slots: {} });
  const gather = `<Gather input="speech"
        action="/voice/turn"
        method="POST"
        speechTimeout="auto"
        actionOnEmptyResult="true"
        language="en-CA"
        enhanced="true"
        profanityFilter="false"
        speechModel="phone_call" />`;
  try {
    const audio = await tts(greet);
    const id = uuidv4();
    audioStore.set(id, audio);
    res.type("text/xml").send(`\n<Response>\n  <Play>https://${req.headers.host}/audio/${id}.mp3</Play>\n  ${gather}\n</Response>`);
  } catch {
    res.type("text/xml").send(`\n<Response>\n  <Say>Welcome to ${process.env.SALON_NAME}. Please tell me what you need.</Say>\n  ${gather}\n</Response>`);
  }
});

app.post("/voice/turn", async (req, res) => {
  const userSpeech = req.body.SpeechResult || "";
  const callSid = req.body.CallSid || undefined;
  console.log("📞 SpeechResult:", JSON.stringify(userSpeech));
  const state = callState.get(callSid) || { history: [], slots: {} };

  if (!userSpeech.trim()) {
    const repeat = state.lastSpoken || "Sorry, I didn’t catch that. What service would you like: cut, colour, or cut+colour?";
    return sayAndGather({ req, res, text: repeat, callSid });
  }

  // --- naive slot extraction from caller utterance ---
  try {
    const s = userSpeech;
    const phoneMatch = s.match(/(\+?\d[\d\s\-().]{6,}\d)/);
    if (phoneMatch) state.slots.phone = phoneMatch[1];
    const emailMatch = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (emailMatch) state.slots.email = emailMatch[0];
    if (/\b(cut\s*\+\s*colour|cut\+colour)\b/i.test(s)) state.slots.service = "cut+colour";
    else if (/\bcolour|color\b/i.test(s)) state.slots.service = "colour";
    else if (/\bcut\b/i.test(s)) state.slots.service = "cut";
    const nameMatch = s.match(/\b(?:my name is|it'?s|i am|i’m)\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+){0,2})/i);
    if (nameMatch) state.slots.name = nameMatch[1];
    const dtGuess = s.match(/(today|tomorrow|mon|tue|wed|thu|fri|sat|sun|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}(:\d{2})?\s*(am|pm)?\b)/i);
    if (dtGuess && !state.slots.datetime) state.slots.datetime = dtGuess[0];
  } catch {}

  // remember user turn
  state.history = (state.history || []).concat([{ role: "user", content: userSpeech }]).slice(-10);

  let reply;
  try {
    reply = await chatReply(userSpeech, state);
  } catch (e) {
    console.error("❌ OpenAI chat error in /voice/turn:", { status: e?.response?.status, data: e?.response?.data, message: e?.message });
    reply = "Sorry, I had trouble understanding that. Could you say it again?";
  }

  // remember assistant turn + persist state
  state.history = state.history.concat([{ role: "assistant", content: reply }]).slice(-10);
  callState.set(callSid, state);

  const action = extractAction(reply);

  // --- ACTION HANDLERS ---
  if (action?.action === "transfer" && process.env.SALON_PHONE) {
    return res.type("text/xml").send(`<Response>\n  <Say>Okay, I’ll connect you to the salon now.</Say>\n  <Dial>${process.env.SALON_PHONE}</Dial>\n</Response>`);
  }

  if (action?.action === "end") {
    return res.type("text/xml").send(`<Response><Say>Thanks for calling. Have a great day!</Say><Hangup/></Response>`);
  }

  if (action?.action === "reprompt") {
    const repeat = state.lastSpoken || "Could you please repeat that?";
    return sayAndGather({ req, res, text: repeat, callSid });
  }

  if (action?.action === "info") {
    let say = "One moment.";
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
      if (process.env.TWILIO_MESSAGING_SID) body.set("MessagingServiceSid", process.env.TWILIO_MESSAGING_SID);
      else body.set("From", process.env.SALON_TWILIO_NUMBER);
      await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
        body,
        { headers: { Authorization: `Basic ${twilioBasicAuth()}`, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 }
      );
      return sayAndGather({ req, res, text: "I just sent that text.", callSid });
    } catch (e) {
      console.error("SMS send failed", e?.response?.data || e);
      return sayAndGather({ req, res, text: "I couldn't send the text just now.", callSid });
    }
  }

  if (action?.action === "voicemail") {
    return res.type("text/xml").send(`\n<Response>\n  <Say>I'm sorry we can't take the call right now. Please leave a message after the tone.</Say>\n  <Record maxLength="90" playBeep="true" action="/voice/voicemail-done" method="POST"/>\n</Response>`);
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
    if (process.env.BOOKING_WEBHOOK_URL) axios.post(process.env.BOOKING_WEBHOOK_URL, payload).catch(() => {});
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

// --- debug: hit from browser to simulate one turn ---
app.get("/debug/turn", async (req, res) => {
  const text = req.query.text || "can i book an appointment";
  try {
    const callSid = "DEBUG";
    const state = callState.get(callSid) || { history: [], slots: {} };
    const reply = await chatReply(String(text), state);
    res.json({ heard: text, reply, action: extractAction(reply) });
  } catch (e) {
    res.status(500).json({ error: "openai_failed", details: e?.response?.data || e?.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Voice bot running on port ${PORT}`));
