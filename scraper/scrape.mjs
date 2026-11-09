// Práca s prehliadačom: načítanie stránky, zber údajov, vyhľadávanie na Heureke.
// Oddelené od check.mjs, aby sa to dalo testovať na lokálnych HTML fixtures.
import { chromium } from 'playwright';
import { extractPrice, extractFromJsonLd, parsePrice, pickCheapest, hostOf } from './extract.mjs';

export const HEUREKA = { sk: 'https://www.heureka.sk', cz: 'https://www.heureka.cz' };

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

// Heuristika pre výsledky vyhľadávania na Heureke: nájde najmenšie bloky,
// ktoré obsahujú nadpis s odkazom a cenu. Nezávisí od konkrétnych CSS tried.
export function collectSearchResults() {
  const priceRe = /(\d[\d\s\u00a0.,]*)\s*(€|Kč)/;
  const candidates = [...document.querySelectorAll('li, article, section, div')].filter((el) => {
    const text = el.innerText || '';
    return text.length < 1500 && priceRe.test(text) && el.querySelector('h2 a, h3 a, a h2, a h3');
  });
  const innermost = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
  return innermost.map((el) => {
    const heading = el.querySelector('h2, h3');
    const link = heading.closest('a') || heading.querySelector('a');
    return {
      name: heading.innerText.trim(),
      url: link?.href || null,
      priceText: (el.innerText.match(priceRe) || [])[0] || null,
      image: el.querySelector('img')?.src || null,
    };
  });
}

/** Výsledky vyhľadávania na Heureke: [{ name, url, price, image }] */
export async function searchItems(page, query, market) {
  const base = HEUREKA[market] || HEUREKA.sk;
  // najprv titulná stránka (cookies, ako keď človek príde na web), potom hľadanie
  await open(page, `${base}/`);
  await sleep(800 + Math.random() * 1200);
  await open(page, `${base}/?h%5Bfraze%5D=${encodeURIComponent(query)}`);

  const fromDom = await page.evaluate(collectSearchResults);
  // doplnkovo: ItemList v JSON-LD, ak ho stránka má
  const ldBlocks = await page.$$eval('script[type="application/ld+json"]', (s) => s.map((x) => x.textContent));
  const fromLd = [];
  for (const block of ldBlocks) {
    try {
      const data = JSON.parse(block);
      for (const el of [].concat(data?.itemListElement || [])) {
        const item = el.item || el;
        const info = extractFromJsonLd([JSON.stringify({ ...item, '@type': 'Product' })]);
        if (item.url && info.price) fromLd.push({ name: item.name, url: item.url, price: info.price, image: info.image });
      }
    } catch {
      /* ignoruj */
    }
  }

  const items = [
    ...fromLd,
    ...fromDom.map((i) => ({ ...i, price: parsePrice(i.priceText) })),
  ].filter((i) => i.url && /heureka\.(sk|cz)/.test(i.url) && !i.url.includes('?'));

  // presná zhoda (napr. podľa EAN) môže Heureka rovno presmerovať na stránku produktu
  if (!items.length) {
    const product = extractFromJsonLd(ldBlocks);
    if (product.price) items.push({ name: product.name, url: page.url(), price: product.price, image: product.image });
  }
  return items;
}

export async function searchHeureka(page, product) {
  const items = await searchItems(page, product.input, product.market);
  const best = pickCheapest(product.input, items);
  if (!best) throw new Error(`Pre „${product.input}“ sa na Heureke nenašiel žiadny produkt s cenou.`);
  return best;
}

/**
 * Najnižšia ponuka rovnakého produktu (podľa EAN) na Heureke.
 * Vráti {} keď porovnanie neprebehlo (chyba, bez EAN, vypnuté) – Worker si nechá posledný výsledok.
 */
export async function findElsewhere(page, product, data) {
  const enabled = product.kind === 'url' && product.notify_elsewhere !== 0 && data.price != null;
  if (!enabled || (!data.ean && !product.best_offer_url)) return {};
  const market = data.currency === 'CZK' ? 'cz' : 'sk';
  try {
    if (product.best_offer_url) {
      await open(page, product.best_offer_url);
      const offer = extractPrice(await page.evaluate(collectPageData, null), product.best_offer_url);
      if (offer.price) return { best_offer_price: offer.price, best_offer_url: product.best_offer_url };
      // stránka na Heureke sa zmenila, skúsime znova hľadať podľa EAN
    }
    if (!data.ean) return {};
    const hit = (await searchItems(page, data.ean, market))[0];
    return hit ? { best_offer_price: hit.price, best_offer_url: hit.url } : { best_offer_price: null, best_offer_url: null };
  } catch (err) {
    console.warn(`  porovnanie na Heureke zlyhalo: ${err.message.split('\n')[0]}`);
    return {};
  }
}

export async function checkProduct(context, product) {
  const page = await context.newPage();
  try {
    let trackUrl = product.track_url;
    let searchHit = null;

    if (product.kind === 'query' && !trackUrl) {
      searchHit = await searchHeureka(page, product);
      trackUrl = searchHit.url;
    }

    await open(page, trackUrl);
    const raw = await page.evaluate(collectPageData, product.selector || null);
    let data = extractPrice(raw, trackUrl);

    // Záloha pre Heureku: cenu vezmeme z výsledkov vyhľadávania
    if (data.error && product.kind === 'query') {
      searchHit ||= await searchHeureka(page, product);
      data = {
        price: searchHit.price,
        currency: product.market === 'cz' ? 'CZK' : 'EUR',
        name: searchHit.name,
        image: searchHit.image,
      };
      trackUrl = searchHit.url;
    }
    if (data.error) return { id: product.id, ok: false, error: data.error, track_url: trackUrl };

    const elsewhere = await findElsewhere(page, product, data);
    return {
      id: product.id,
      ok: true,
      ...elsewhere,
      ean: data.ean || null,
      price: data.price,
      currency: data.currency,
      in_stock: data.inStock ?? null,
      list_price: data.listPrice ?? null,
      name: data.name ? data.name.slice(0, 200) : null,
      image: data.image || null,
      shop: product.kind === 'query' ? `najnižšia cena na ${hostOf(trackUrl)}` : data.shop,
      track_url: trackUrl,
    };
  } finally {
    await page.close();
  }
}
