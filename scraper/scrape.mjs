// Práca s prehliadačom: načítanie stránky, zber údajov, vyhľadávanie na Heureke.
// Oddelené od check.mjs, aby sa to dalo testovať na lokálnych HTML fixtures.
import { chromium } from 'playwright';
import { extractPrice } from './extract.mjs';


/** Nastavenia, ktoré si testy môžu zmeniť (napr. bez čakania pri opakovaní). */
export const settings = { retryDelayMs: 12_000 };

/**
 * Plný Chromium v novom headless režime. Predvolený „headless shell“ sa dá
 * rozpoznať omnoho ľahšie a ochrany proti robotom ho často blokujú.
 */
// Prepínač AutomationControlled skryje navigator.webdriver; plný Chromium má aj window.chrome.
export function launchBrowser(options = {}) {
  return chromium.launch({
    channel: 'chromium',
    args: ['--disable-blink-features=AutomationControlled'],
    ...options,
  });
}

/** User-Agent bežného Chrome na rovnakom systéme, na akom prehliadač naozaj beží. */
export function userAgentFor(version, platform = process.platform) {
  const major = String(version).split('.')[0];
  const os =
    platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
    : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export async function createContext(browser) {
  const context = await browser.newContext({
    locale: 'sk-SK',
    timezoneId: 'Europe/Bratislava',
    viewport: { width: 1366, height: 900 },
    userAgent: userAgentFor(browser.version()),
  });
  // videá netreba; obrázky a fonty necháme, ich blokovanie je pre ochrany podozrivé
  // a Accept-Language ako slovenský Chrome (locale nastaví len „sk-SK“)
  await context.route('**/*', async (route) => {
    if (route.request().resourceType() === 'media') return route.abort();
    const headers = { ...(await route.request().allHeaders()), 'accept-language': ACCEPT_LANGUAGE };
    return route.fallback({ headers });
  });
  return context;
}

const ACCEPT_LANGUAGE = 'sk-SK,sk;q=0.9,cs;q=0.8,en;q=0.7';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBlocked = (status) => status === 403 || status === 429;

export async function open(page, url) {
  let response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (isBlocked(response?.status())) {
    // ochrana niekedy pustí na druhý pokus (napr. po nastavení cookies)
    await sleep(settings.retryDelayMs + Math.random() * settings.retryDelayMs * 0.5);
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  const status = response?.status() ?? 0;
  if (isBlocked(status)) {
    const title = (await page.title().catch(() => '')).trim().slice(0, 80);
    throw new Error(
      `Obchod zablokoval automatickú kontrolu (HTTP ${status}${title ? `, stránka „${title}“` : ''}). Skúsi sa to znova pri ďalšej kontrole.`,
    );
  }
  if (status >= 400) throw new Error(`Stránka vrátila HTTP ${status}.`);
  // dáme čas JS e-shopom vykresliť cenu
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

export function collectPageData(selector) {
  const q = (s) => document.querySelector(s);
  const meta = (n) => q(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute('content') || null;
  const ip = q('[itemprop="price"]');
  let selectorText = null;
  let selectorMissing = false;
  if (selector) {
    const el = q(selector);
    if (el) selectorText = el.getAttribute('content') || el.textContent;
    else selectorMissing = true;
  }
  return {
    jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent),
    meta: {
      amount: meta('product:price:amount') || meta('og:price:amount'),
      currency: meta('product:price:currency') || meta('og:price:currency'),
      title: meta('og:title'),
      image: meta('og:image'),
      site: meta('og:site_name'),
    },
    itemprop: ip
      ? {
          price: ip.getAttribute('content') || ip.textContent,
          currency: q('[itemprop="priceCurrency"]')?.getAttribute('content') || null,
        }
      : null,
    selectorText,
    selectorMissing,
    availability:
      q('[itemprop="availability"]')?.getAttribute('href') ||
      q('[itemprop="availability"]')?.getAttribute('content') ||
      null,
    // kandidáti na prečiarknutú cenu „pred zľavou“
    strikeTexts: [
      ...document.querySelectorAll(
        'del, s, [class*="old-price" i], [class*="price-old" i], [class*="original-price" i], [class*="strike" i], [class*="price--before" i]',
      ),
    ]
      .slice(0, 15)
      .map((el) => el.textContent.trim().slice(0, 60)),
    title: document.title,
  };
}

/** Produkty pridané kedysi názvom sa už nekontrolujú (Heureku appka nečíta). */
export const QUERY_UNSUPPORTED =
  'Sledovanie podľa názvu už nie je podporované. Zmaž produkt a pridaj ho odkazom z e-shopu.';

export async function checkProduct(context, product) {
  if (product.kind !== 'url' || !product.track_url) {
    return { id: product.id, ok: false, error: QUERY_UNSUPPORTED };
  }
  const page = await context.newPage();
  try {
    const trackUrl = product.track_url;
    await open(page, trackUrl);
    const raw = await page.evaluate(collectPageData, product.selector || null);
    const data = extractPrice(raw, trackUrl);
    if (data.error) return { id: product.id, ok: false, error: data.error, track_url: trackUrl };

    return {
      id: product.id,
      ok: true,
      ean: data.ean || null,
      price: data.price,
      currency: data.currency,
      in_stock: data.inStock ?? null,
      list_price: data.listPrice ?? null,
      name: data.name ? data.name.slice(0, 200) : null,
      image: data.image || null,
      shop: data.shop,
      track_url: trackUrl,
    };
  } finally {
    await page.close();
  }
}
