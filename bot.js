const fs = require("node:fs/promises");

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const STATE_FILE = process.env.STATE_FILE || "state.json";
const FIRST_RUN_MODE = process.env.FIRST_RUN_MODE || "seed"; // seed = don't post old articles
const MAX_NEWS_PER_FEED = Number(process.env.MAX_NEWS_PER_FEED || 15);
const USER_AGENT = "SteamCS2DiscordUpdatesBot/1.0 (personal community bot)";

if (!WEBHOOK_URL) {
  console.error("Missing DISCORD_WEBHOOK_URL environment secret.");
  process.exit(1);
}

const SOURCES = [
  {
    name: "CS2 updates",
    type: "steam",
    url: "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=20&maxlength=0",
    category: "CS2 Patch / News",
  },
  {
    name: "Steam news",
    type: "steam",
    url: "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid= steam&count=20&maxlength=0",
    category: "Steam News",
    // The Steam client app news endpoint is configured below with its numeric app ID.
    appId:  steamAppId(),
  },
  {
    name: "CS2 esports",
    type: "rss",
    url: "https://news.google.com/rss/search?q=Counter-Strike+2+esports+OR+CS2+esports&hl=en-US&gl=US&ceid=US:en",
    category: "CS2 Esports",
  },
];

function steamAppId() {
  // Steam client app ID is 753; news is not consistently curated there, so this feed
  // is supplemented with an esports RSS feed and CS2's official app news.
  return 753;
}

SOURCES[1].url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${SOURCES[1].appId}&count=20&maxlength=0`;

const STATUS_URLS = [
  { name: "Steam Store", url: "https://store.steampowered.com/" },
  { name: "Steam Community", url: "https://steamcommunity.com/" },
  { name: "Steam Web API", url: "https://api.steampowered.com/" },
  { name: "Steam Status page", url: "https://steamstat.us/" },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept": "application/json, application/rss+xml, application/xml, text/xml, text/html, */*" },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return { initialized: false, seenNews: {}, status: {} };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function decodeXml(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .trim();
}

function parseRss(xml) {
  const items = [];
  const matches = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const item of matches) {
    const get = (tag) => {
      const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return match ? decodeXml(match[1].replace(/<[^>]+>/g, "").trim()) : "";
    };
    const title = get("title");
    const link = get("link");
    const pubDate = get("pubDate");
    if (title && link) items.push({ id: link, title, url: link, date: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString() });
  }
  return items;
}

async function getFeedItems(source) {
  const text = await fetchText(source.url);
  if (source.type === "steam") {
    const data = JSON.parse(text);
    return (data.appnews?.newsitems || []).map((item) => ({
      id: String(item.gid || item.url),
      title: item.title || "Untitled Steam announcement",
      url: item.url,
      date: item.date ? new Date(item.date * 1000).toISOString() : new Date().toISOString(),
      contents: String(item.contents || "").replace(/<[^>]*>/g, "").slice(0, 300),
    }));
  }
  return parseRss(text);
}

async function sendDiscord({ title, description, url, color = 0x66c0f4, footer = "Steam + CS2 Update Bot", timestamp }) {
  const payload = {
    username: "Steam + CS2 Updates",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: String(title).slice(0, 256),
      url,
      description: String(description || "").slice(0, 4000) || "Open the link for details.",
      color,
      timestamp: timestamp || new Date().toISOString(),
      footer: { text: footer },
    }],
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok || response.status === 204) return;
    const body = await response.text().catch(() => "");
    if (response.status === 429 && attempt < 3) {
      let delay = 2000;
      try { delay = Math.ceil(Number(JSON.parse(body).retry_after || 2) * 1000); } catch {}
      await sleep(Math.min(delay, 15000));
      continue;
    }
    if (response.status >= 500 && attempt < 3) {
      await sleep(attempt * 1500);
      continue;
    }
    throw new Error(`Discord webhook failed: HTTP ${response.status} ${body.slice(0, 250)}`);
  }
}

async function processNews(state) {
  for (const source of SOURCES) {
    try {
      const items = (await getFeedItems(source)).slice(0, MAX_NEWS_PER_FEED);
      const known = new Set(state.seenNews[source.name] || []);
      const fresh = items.filter((item) => !known.has(item.id)).reverse();

      // On first successful run, remember current stories without posting a backlog.
      if (!state.initialized && FIRST_RUN_MODE === "seed") {
        state.seenNews[source.name] = items.map((item) => item.id).slice(0, 200);
        console.log(`[seed] ${source.name}: remembered ${items.length} existing stories`);
        continue;
      }

      for (const item of fresh) {
        await sendDiscord({
          title: item.title,
          description: item.contents || `New item from **${source.name}**.`,
          url: item.url,
          color: source.category.includes("Esports") ? 0xf1c40f : 0x66c0f4,
          footer: source.category,
          timestamp: item.date,
        });
        console.log(`[posted] ${source.name}: ${item.title}`);
        known.add(item.id);
        await sleep(900); // avoid bursting webhook requests
      }

      state.seenNews[source.name] = [...known].slice(-200);
    } catch (error) {
      console.error(`[news error] ${source.name}: ${error.message}`);
    }
  }
  state.initialized = true;
}

async function processStatus(state) {
  // This checks whether key Steam web services are reachable. It is not a direct
  // measurement of CS2 matchmaking health or regional game-server quality.
  for (const service of STATUS_URLS) {
    let current = "up";
    let detail = "HTTP response received";
    try {
      const response = await fetch(service.url, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) {
        current = "degraded";
        detail = `HTTP ${response.status}`;
      }
    } catch (error) {
      current = "down";
      detail = error.message;
    }

    const previous = state.status[service.name];
    if (previous && previous !== current) {
      await sendDiscord({
        title: `${current === "up" ? "🟢 Recovered" : "🔴 Service issue"}: ${service.name}`,
        description: `Status changed from **${previous}** to **${current}**.\nCheck: ${service.url}\nDetails: ${detail}`,
        url: service.url,
        color: current === "up" ? 0x2ecc71 : 0xe74c3c,
        footer: "Basic reachability monitor — not official matchmaking status",
      });
      console.log(`[status] ${service.name}: ${previous} -> ${current}`);
    } else if (!previous) {
      console.log(`[status baseline] ${service.name}: ${current}`);
    }
    state.status[service.name] = current;
  }
}

async function main() {
  const state = await loadState();
  await processNews(state);
  await processStatus(state);
  await saveState(state);
  console.log(`Run finished at ${new Date().toISOString()}`);
}

main().catch((error) => {
  console.error("Fatal run error:", error);
  process.exitCode = 1;
});
