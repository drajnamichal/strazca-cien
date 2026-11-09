// Kanárik – raz denne overí scraper na živých e-shopoch (GitHub Actions, canary.yml).
// Pri zlyhaní: červený beh v GitHube (e-mail od GitHubu), súhrn v behu a Web Push, ak je nastavené API.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createContext, checkProduct, launchBrowser } from './scrape.mjs';
import { evaluateCanary, canaryProduct, summaryMarkdown, alertText } from './canary-lib.mjs';
import { createApi } from './api.mjs';
import { sendPushes } from './push.mjs';

export async function runCanary(context, entries, { pause = 2000 } = {}) {
  const rows = [];
  for (const [i, entry] of entries.entries()) {
    let row;
    try {
      row = evaluateCanary(entry, await checkProduct(context, canaryProduct(entry, i)));
    } catch (err) {
      row = evaluateCanary(entry, null, err);
    }
    console.log(`${row.ok ? '✓' : '✗'} ${row.name}: ${row.detail}`);
    rows.push(row);
    if (pause) await new Promise((r) => setTimeout(r, pause));
  }
  return rows;
}

async function main() {
  const { default: entries } = await import('./canary.config.mjs');
  const browser = await launchBrowser();
  const context = await createContext(browser);
  const rows = await runCanary(context, entries);
  await browser.close();

  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(rows));

  const alert = alertText(rows);
  if (!alert) return;
  if (process.env.API_URL && process.env.API_TOKEN) {
    const api = createApi(process.env.API_URL, process.env.API_TOKEN);
    const { notifications, subscriptions } = await api('/api/internal/alert', { method: 'POST', body: alert });
    await sendPushes(api, notifications, subscriptions);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
