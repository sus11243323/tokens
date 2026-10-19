# Steam + CS2 Discord Updates Bot

Node.js 20 bot that checks Steam app news and a CS2 esports RSS search, sends new stories to a Discord webhook, and alerts when selected Steam web pages change reachability. GitHub Actions runs it on a five-minute schedule.

## Feeds and limitations

- CS2 news: Steam's official `ISteamNews/GetNewsForApp` endpoint for app ID 730.
- Steam news: app ID 753 (Steam Community). This feed may not contain every general Steam announcement.
- Esports: Google News RSS search for Counter-Strike 2 esports.
- Status: basic reachability checks for Steam Store, Community, Web API, and the Steam Status website. This is **not** official CS2 matchmaking telemetry and does not assess regional game server health.
- First run seeds current articles without posting a backlog. Later runs post unseen stories only.
- The bot keeps up to 200 seen IDs per feed in `state.json`; GitHub Actions commits changes to preserve deduplication between runs.

## Set up

1. Create a Discord webhook in **Server Settings → Integrations → Webhooks → New Webhook**. Copy its URL.
2. Create a GitHub repository and upload all files from this folder, including `.github/workflows/updates.yml`.
3. In GitHub, open **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `DISCORD_WEBHOOK_URL`
   - Value: your Discord webhook URL
4. In **Settings → Actions → General**, make sure workflows are allowed to create and approve pull requests is not required; the workflow needs `contents: write` permission. If repository defaults override workflow permissions, set Workflow permissions to **Read and write permissions**.
5. Open **Actions**, enable workflows if prompted, select **Steam and CS2 Discord updates**, then click **Run workflow**.
6. Check the job logs and your Discord channel. The first run normally establishes a baseline and posts no old articles.
7. Leave the workflow enabled. GitHub scheduled workflows may be delayed during high load and are not guaranteed to start exactly every five minutes.

## Run locally

Requires Node.js 20 or newer.

Linux/macOS:
```bash
export DISCORD_WEBHOOK_URL="paste-your-webhook-url-here"
node bot.js
```

PowerShell:
```powershell
$env:DISCORD_WEBHOOK_URL="paste-your-webhook-url-here"
node bot.js
```

Local mode performs one polling pass and exits. GitHub Actions is what schedules repeated runs.

## Security and troubleshooting

- Never commit the webhook URL. If it leaks, regenerate it in Discord.
- If Discord returns 429, the bot waits and retries. Temporary server errors are retried.
- If Git push fails, verify the workflow has `contents: write` permission and no branch protection rule blocks the bot.
- Steam/RSS feeds and page layouts can change; check the Actions logs if a feed stops working.
- The GitHub repository's `state.json` is updated automatically after successful runs. Do not manually clear it unless you want to risk reposting old stories.
