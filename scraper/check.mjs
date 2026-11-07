// Scraper – beží v GitHub Actions (cron cez Cloudflare Worker každých 5 h alebo na požiadanie).
import { chromium } from 'playwright';
import { parseEcbCzk } from './extract.mjs';
import { createContext, checkProduct } from './scrape.mjs';
import { createApi } from './api.mjs';
import { sendPushes } from './push.mjs';

const { API_URL, API_TOKEN, PRODUCT_ID } = process.env;
if (!API_URL || !API_TOKEN) {
  console.error('Chýba API_URL alebo API_TOKEN.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = createApi(API_URL, API_TOKEN);

async function fetchRates() {
  try {
    const res = await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
    const czk = parseEcbCzk(await res.text());
    return czk ? { CZK: czk } : null;
  } catch {
    return null;
  }
}

async function main() {
  const { products } = await api(`/api/internal/jobs${PRODUCT_ID ? `?id=${encodeURIComponent(PRODUCT_ID)}` : ''}`);
  console.log(`Kontrolujem ${products.length} produktov.`);
  if (!products.length) return;

  const browser = await chromium.launch();
  const context = await createContext(browser);

  const results = [];
  for (const product of products) {
    try {
      const r = await checkProduct(context, product);
      results.push(r);
      console.log(r.ok ? `✓ #${product.id} ${r.price ?? "vypredané"} ${r.currency ?? ""}${r.list_price ? ` (pred zľavou ${r.list_price})` : ""}` : `✗ #${product.id} ${r.error}`);
    } catch (err) {
      results.push({ id: product.id, ok: false, error: err.message.split('\n')[0].slice(0, 300) });
      console.log(`✗ #${product.id} ${err.message.split('\n')[0]}`);
    }
    await sleep(1500 + Math.random() * 2500); // šetrne k e-shopom
  }
  await browser.close();

  const { notifications, subscriptions } = await api('/api/internal/results', {
    method: 'POST',
    body: { results, rates: await fetchRates() },
  });
  await sendPushes(api, notifications, subscriptions);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
