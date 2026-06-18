// =============================================================================
// Discord 24/7 Free-form Bridge
// -----------------------------------------------------------------------------
// A tiny always-on relay. It keeps a WebSocket open to Discord's Gateway,
// listens for DMs you send the bot, forwards the plain text to your Lovable
// `discord-bot` edge function (same brain + memory + tools as /ask), and posts
// the reply back into the DM. It also lets the bot learn your Discord user ID
// so scheduled tasks / alerts can DM you directly.
//
// Deploy this anywhere that runs Node 18+ 24/7 (Railway, Fly.io, Render, VPS).
//
// Required environment variables:
//   DISCORD_BOT_TOKEN  - your bot token (same one already in Lovable)
//   EDGE_URL           - your discord-bot function URL (see README)
//   BRIDGE_SECRET      - the shared secret (see README)
// =============================================================================

const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  Routes,
} = require("discord.js");

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const EDGE_URL = process.env.EDGE_URL;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
const BRIDGE_VERSION = "attachments-v3-voice-debug-2026-06-18";

if (!DISCORD_BOT_TOKEN || !EDGE_URL || !BRIDGE_SECRET) {
  console.error(
    "Missing env. Need DISCORD_BOT_TOKEN, EDGE_URL and BRIDGE_SECRET.",
  );
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once("ready", () => {
  console.log(`✅ Bridge online as ${client.user.tag}. DM the bot to chat. version=${BRIDGE_VERSION}`);
});

function normalizeAttachment(att) {
  return {
    id: att.id ? String(att.id) : "",
    url: att.url || att.proxyURL || att.proxy_url || "",
    name: att.name || att.filename || "file",
    contentType: att.contentType || att.content_type || "",
    durationSecs: att.durationSecs ?? att.duration_secs,
    waveform: att.waveform,
  };
}

async function fetchRawMessageAttachments(message) {
  try {
    const raw = await client.rest.get(Routes.channelMessage(message.channelId, message.id));
    return Array.isArray(raw?.attachments) ? raw.attachments.map(normalizeAttachment) : [];
  } catch (e) {
    console.error("REST attachment fetch failed:", e?.message ?? e);
    return [];
  }
}

function mergeAttachments(primary, fallback) {
  const byKey = new Map();
  for (const att of [...primary, ...fallback]) {
    const key = att.id || att.url || att.name;
    if (!key) continue;
    byKey.set(key, { ...(byKey.get(key) || {}), ...att });
  }
  return [...byKey.values()].filter((att) => att.url);
}

function chunk2000(text) {
  const chunks = [];
  let remaining = (text || "").trim() || "(no response)";
  const MAX = 2000;
  while (remaining.length > MAX) {
    let cut = remaining.lastIndexOf("\n", MAX);
    if (cut < MAX * 0.5) cut = MAX;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

client.on("messageCreate", async (message) => {
  try {
    if (message.partial) {
      try {
        message = await message.fetch();
      } catch (e) {
        console.error("Failed to fetch partial message:", e?.message ?? e);
        return;
      }
    }

    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.DM) return;

    const content = (message.content || "").trim();

    const rawFlags = Number(message.flags?.bitfield ?? message.flags ?? 0);
    const isVoiceMessage =
      (rawFlags & 8192) === 8192 ||
      (typeof message.flags?.has === "function" && message.flags.has(8192));

    let audio = null;
    const images = [];
    const files = [];
    const cachedAttachments = message.attachments
      ? [...message.attachments.values()].map(normalizeAttachment)
      : [];
    const rawAttachments = await fetchRawMessageAttachments(message);
    const allAttachments = mergeAttachments(cachedAttachments, rawAttachments);
    if (allAttachments.length > 0) {
      for (const att of allAttachments) {
        const ct = (att.contentType || "").toLowerCase();
        const name = (att.name || "").toLowerCase();
        const isVoiceAtt =
          isVoiceMessage ||
          name.startsWith("voice-message") ||
          name.includes("voice-message") ||
          att.durationSecs !== undefined ||
          !!att.waveform;
        const isAudio =
          isVoiceAtt ||
          ct.startsWith("audio/") ||
          /\.(ogg|oga|opus|mp3|m4a|wav|webm|flac)$/.test(name);
        const isImage = ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/.test(name);
        if (isAudio && !audio) {
          audio = att;
        } else if (isImage) {
          images.push({ url: att.url, name: att.name || "image", contentType: att.contentType || "" });
        } else {
          files.push({ url: att.url, name: att.name || "file", contentType: att.contentType || "" });
        }
      }
    }

    console.log(
      `[bridge] DM from ${message.author?.username}: text=${content ? "yes" : "no"} ` +
        `audio=${audio ? (audio.name || "yes") : "no"} images=${images.length} files=${files.length} ` +
        `cachedAttachments=${cachedAttachments.length} restAttachments=${rawAttachments.length} ` +
        `voiceFlag=${isVoiceMessage} rawFlags=${rawFlags} bridgeVersion=${BRIDGE_VERSION}`,
    );

    if (!content && !audio && images.length === 0 && files.length === 0) return;

    try { await message.channel.sendTyping(); } catch (_e) {}

    const res = await fetch(EDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-secret": BRIDGE_SECRET,
      },
      body: JSON.stringify({
        source: "bridge",
        bridgeVersion: BRIDGE_VERSION,
        content,
        audioUrl: audio ? audio.url : undefined,
        audioName: audio ? (audio.name || "") : undefined,
        audioContentType: audio ? (audio.contentType || "") : undefined,
        images: images.length ? images : undefined,
        files: files.length ? files : undefined,
        discordUserId: message.author.id,
        discordUsername: message.author.username,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("Edge error", res.status, errText.slice(0, 300));
      await message.reply("Something went wrong reaching the assistant. Try again in a moment.");
      return;
    }

    const data = await res.json().catch(() => ({}));
    const reply = (data && data.reply) || "Sorry, I couldn't generate a response.";
    const parts = chunk2000(reply);
    for (let i = 0; i < parts.length; i++) {
      if (i === 0) await message.reply(parts[i]);
      else await message.channel.send(parts[i]);
    }
  } catch (e) {
    console.error("messageCreate error:", e?.message ?? e);
    try { await message.reply("Something went wrong. Try again in a moment."); } catch (_e) {}
  }
});

console.log(`⏳ Logging in to Discord… version=${BRIDGE_VERSION}`);

client.login(DISCORD_BOT_TOKEN).catch((err) => {
  const msg = String(err?.message ?? err);
  console.error("❌ Discord login FAILED:", msg);
  if (/disallowed intents/i.test(msg)) {
    console.error(
      "👉 This means MESSAGE CONTENT INTENT is OFF. Enable it in the Discord Developer Portal → your app → Bot → Privileged Gateway Intents → toggle MESSAGE CONTENT INTENT ON → Save, then redeploy this bridge.",
    );
  }
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("❌ Unhandled rejection:", err?.message ?? err);
});
