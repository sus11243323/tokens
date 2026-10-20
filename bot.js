const fs = require("node:fs/promises");

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const STATE_FILE = process.env.STATE_FILE || "state.json";
const FIRST_RUN_MODE = process.env.FIRST_RUN_MODE || "seed";
const UA = "SteamDB-CS2-Update-Radar/2.0";

if (!WEBHOOK) {
  console.error("Missing DISCORD_WEBHOOK_URL repository secret.");
  process.exit(1);
}

const targets = [
  {
    key: "cs2", name: "Counter-Strike 2", emoji: "🎯", color: 0xf0a22e, appid: 730,
    db: "https://steamdb.info/app/730/patchnotes/",
    history: "https://steamdb.info/app/730/history/",
    official: "https://steamcommunity.com/app/730/announcements/"
  },
  {
    key: "steamClient", name: "Steam Client", emoji: "🖥️", color: 0x66c0f4, appid: 250,
    db: "https://steamdb.info/app/250/patchnotes/",
    history: "https://steamdb.info/app/250/history/",
    official: "https://store.steampowered.com/news/app/250"
  }
];

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept": "text/html,application/json,*/*" },
        signal: AbortSignal.timeout(18000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (i < attempts) await wait(1000 * i);
    }
  }
  throw lastError;
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, "utf8")); }
  catch { return { initialized: false, changelists: {}, news: {} }; }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function decodeHtml(s = "") {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function getChangelist(html) {
  const text = decodeHtml(html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " "));
  const match = text.match(/Last\s+Changenumber\s*:?\s*(\d{5,})/i);
  if (!match) throw new Error("Could not read SteamDB changelist. SteamDB markup or access may have changed.");
  return match[1];
}

async function sendEmbed(embed) {
  const payload = {
    username: "SteamDB Update Radar",
    avatar_url: "https://store.steampowered.com/favicon.ico",
    allowed_mentions: { parse: [] },
    embeds: [{
      ...embed,
      timestamp: new Date().toISOString(),
      footer: {
        text: "STEAMDB UPDATE RADAR • Checks every 5 minutes",
        icon_url: "https://steamdb.info/favicon.ico"
      }
    }]
  };

  for (let i = 1; i <= 3; i++) {
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    if (res.ok || res.status === 204) return;
    const body = await res.text().catch(() => "");
    if (res.status === 429 && i < 3) {
      let ms = 2500;
      try { ms = Math.ceil(Number(JSON.parse(body).retry_after || 2) * 1000); } catch {}
      await wait(Math.min(ms, 20000));
      continue;
    }
    if (res.status >= 500 && i < 3) { await wait(i * 1500); continue; }
    throw new Error(`Discord HTTP ${res.status}: ${body.slice(0, 250)}`);
  }
}

async function checkSteamDB(state) {
  for (const t of targets) {
    try {
      const current = getChangelist(await fetchText(t.db));
      const previous = state.changelists[t.key];

      if (!previous) {
        state.changelists[t.key] = current;
        console.log(`[baseline] ${t.name}: #${current}`);
      } else if (current !== previous) {
        await sendEmbed({
          title: `${t.emoji} ${t.name} — NEW STEAMDB CHANGE`,
          url: t.db,
          color: t.color,
          description: [
            `SteamDB detected a new changelist for **${t.name}**.`,
            "",
            `**Previous changelist:** \`#${previous}\``,
            `**Current changelist:** \`#${current}\``,
            "",
            "A changelist can include backend, configuration, or content changes; it does not always mean a player-facing patch."
          ].join("\n"),
          fields: [
            { name: "🔎 Patch notes", value: `[Open SteamDB patch notes](${t.db})`, inline: true },
            { name: "🧾 Changelist history", value: `[Inspect history](${t.history})`, inline: true },
            { name: "📣 Official news", value: `[Valve announcements](${t.official})`, inline: true }
          ]
        });
        state.changelists[t.key] = current;
        console.log(`[alert] ${t.name}: ${previous} -> ${current}`);
      } else {
        console.log(`[unchanged] ${t.name}: #${current}`);
      }
    } catch (err) {
      console.error(`[SteamDB] ${t.name}: ${err.message}`);
    }
    await wait(700);
  }
}

async function checkOfficialNews(state) {
  for (const t of targets) {
    const key = t.key;
    try {
      const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${t.appid}&count=10&maxlength=700`;
      const data = await fetchJson(url);
      const item = data.appnews?.newsitems?.[0];
      if (!item) { console.log(`[news] No item returned for ${t.name}`); continue; }

      const id = String(item.gid || item.url || item.title);
      const old = state.news[key];
      if (!old) {
        state.news[key] = id;
        console.log(`[news baseline] ${t.name}: ${item.title}`);
      } else if (id !== old) {
        const summary = String(item.contents || "")
          .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n")
          .replace(/<[^>]*>/g, "").replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim().slice(0, 1700);

        await sendEmbed({
          title: `📣 Official ${t.name} announcement`,
          url: item.url || t.official,
          color: t.color,
          description: `${summary || "A new official Steam announcement was published."}\n\n[Read the original announcement](${item.url || t.official})`,
          fields: [
            { name: "SteamDB", value: `[Track ${t.name} on SteamDB](${t.db})`, inline: true },
            { name: "Published", value: item.date ? `<t:${Number(item.date)}:R>` : "Recently", inline: true }
          ]
        });
        state.news[key] = id;
        console.log(`[official news] ${t.name}: ${item.title}`);
      } else {
        console.log(`[news unchanged] ${t.name}`);
      }
    } catch (err) {
      console.error(`[official news] ${t.name}: ${err.message}`);
    }
    await wait(700);
  }
}

async function main() {
  const state = await loadState();
  state.changelists ||= {};
  state.news ||= {};
  await checkSteamDB(state);
  await checkOfficialNews(state);
  state.initialized = true;
  await saveState(state);
  console.log(`Finished ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
