const { Client, GatewayIntentBits, Partials, ChannelType } = require("discord.js");
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const EDGE_URL = process.env.EDGE_URL;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
if (!DISCORD_BOT_TOKEN || !EDGE_URL || !BRIDGE_SECRET) {
  console.error("Missing env vars"); process.exit(1);
}
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});
client.once("ready", () => { console.log(`✅ Bridge online as ${client.user.tag}`); });
function chunk2000(text) {
  const chunks = []; let remaining = (text || "").trim() || "(no response)";
  while (remaining.length > 2000) {
    let cut = remaining.lastIndexOf("\n", 2000);
    if (cut < 1000) cut = 2000;
    chunks.push(remaining.slice(0, cut)); remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining); return chunks;
}
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== ChannelType.DM) return;
  const content = (message.content || "").trim(); if (!content) return;
  try { await message.channel.sendTyping(); } catch (_e) {}
  const res = await fetch(EDGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bridge-secret": BRIDGE_SECRET },
    body: JSON.stringify({ source: "bridge", content, discordUserId: message.author.id, discordUsername: message.author.username }),
  });
  if (!res.ok) { await message.reply("Something went wrong. Try again."); return; }
  const data = await res.json().catch(() => ({}));
  const parts = chunk2000(data?.reply || "Sorry, no response.");
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) await message.reply(parts[i]);
    else await message.channel.send(parts[i]);
  }
});
client.login(DISCORD_BOT_TOKEN);
