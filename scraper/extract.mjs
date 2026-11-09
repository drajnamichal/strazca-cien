// Čisté funkcie bez prehliadača – dajú sa unit-testovať (node --test).

/** "1 299,90 €" | "1.299,-" | "12.99" | 1299 -> číslo alebo null */
export function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (value == null) return null;
  const text = String(value).replace(/[\u00a0\u202f\u2009]/g, ' ');
  const match = text.match(/\d[\d .,']*/);
  if (!match) return null;
  let n = match[0].trim().replace(/[ ']/g, '').replace(/[.,]+$/, '');

  const commas = (n.match(/,/g) || []).length;
  const dots = (n.match(/\./g) || []).length;
  if (commas && dots) {
    // posledný oddeľovač je desatinný
    n = n.lastIndexOf(',') > n.lastIndexOf('.') ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
  } else if (commas || dots) {
    const sep = commas ? ',' : '.';
    const count = commas || dots;
    const decimals = n.length - n.lastIndexOf(sep) - 1;
    // viac oddeľovačov alebo presne 3 číslice za ním = oddeľovač tisícov
    n = count > 1 || decimals === 3 ? n.split(sep).join('') : n.replace(sep, '.');
  }
  const num = Number(n);
  return Number.isFinite(num) && num > 0 ? num : null;
}

export function detectCurrency(text, url) {
  const t = String(text || '');
  if (/€|\bEUR\b/i.test(t)) return 'EUR';
  if (/Kč|\bCZK\b/i.test(t)) return 'CZK';
  try {
    return new URL(url).hostname.endsWith('.cz') ? 'CZK' : 'EUR';
  } catch {
    return 'EUR';
  }
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const hasType = (node, type) => asArray(node?.['@type']).some((t) => String(t).toLowerCase() === type);

function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (node && typeof node === 'object') {
    visit(node);
    Object.values(node).forEach((v) => walk(v, visit));
  }
}

/** EAN/GTIN (8 až 14 číslic) z polí schema.org */
function gtinOf(node) {
  for (const key of ['gtin13', 'gtin', 'gtin12', 'gtin14', 'gtin8', 'ean']) {
    const value = String(node?.[key] ?? '').replace(/\s/g, '');
    if (/^\d{8,14}$/.test(value)) return value;
  }
  return null;
}

function imageOf(img) {
  const first = asArray(img)[0];
  return typeof first === 'string' ? first : first?.url || first?.contentUrl || null;
}

/** 'in' | 'out' | null podľa schema.org availability */
export function stockOf(value) {
  const v = String(value || '');
  if (/OutOfStock|SoldOut|Discontinued/i.test(v)) return 'out';
  if (/InStock|LimitedAvailability|OnlineOnly|InStoreOnly/i.test(v)) return 'in';
  return null;
}

const isStrikethrough = (spec) => /StrikethroughPrice|ListPrice|SRP|MSRP/i.test(String(spec?.priceType || ''));

function offerPrices(offers) {
  const out = [];
  for (const o of asArray(offers)) {
    if (!o || typeof o !== 'object') continue;
    const currency = o.priceCurrency || asArray(o.priceSpecification)[0]?.priceCurrency || null;
    const stock = stockOf(o.availability);
    const specs = asArray(o.priceSpecification);
    const candidates = hasType(o, 'aggregateoffer')
      ? [o.lowPrice, o.price]
      : [o.price, ...specs.filter((sp) => !isStrikethrough(sp)).map((sp) => sp?.price)];
    const price = candidates.map(parsePrice).find((p) => p != null);
    const listPrice = specs.filter(isStrikethrough).map((sp) => parsePrice(sp.price)).find((p) => p != null) ?? null;
    if (price != null) out.push({ price, currency, stock, outOfStock: stock === 'out', listPrice });
    if (o.offers) out.push(...offerPrices(o.offers));
  }
  return out;
}

/** Z textov <script type="application/ld+json"> vytiahne názov, obrázok a najnižšiu cenu. */
export function extractFromJsonLd(blocks) {
  const result = { name: null, image: null, price: null, currency: null, inStock: null, listPrice: null, ean: null };
  const offers = [];
  for (const block of blocks || []) {
    let data;
    try {
      data = JSON.parse(block);
    } catch {
      continue;
    }
    walk(data, (node) => {
      if (hasType(node, 'product') || hasType(node, 'productgroup')) {
        result.name ||= node.name || null;
        result.image ||= imageOf(node.image);
        result.ean ||= gtinOf(node);
        offers.push(...offerPrices(node.offers));
        for (const variant of asArray(node.hasVariant)) offers.push(...offerPrices(variant?.offers));
      }
    });
  }
  const available = offers.filter((o) => !o.outOfStock);
  const pool = available.length ? available : offers;
  if (pool.length) {
    const best = pool.reduce((a, b) => (b.price < a.price ? b : a));
    result.price = best.price;
    result.currency = best.currency;
    result.listPrice = best.listPrice > best.price ? best.listPrice : null;
  }
  if (offers.some((o) => o.stock === 'in')) result.inStock = true;
  else if (offers.length && offers.every((o) => o.stock === 'out')) result.inStock = false;
  return result;
}

/**
 * raw = údaje zozbierané v prehliadači (pozri collectPageData v check.mjs).
 * Poradie: vlastný selektor > JSON-LD > microdata > meta tagy.
 */
export function extractPrice(raw, url) {
  const ld = extractFromJsonLd(raw.jsonLd);
  let price = null;
  let currency = null;
  let source = null;

  if (raw.selectorText != null) {
    price = parsePrice(raw.selectorText);
    currency = detectCurrency(raw.selectorText, url);
    source = 'selector';
    if (price == null) {
      return { error: 'Vlastný CSS selektor našiel element, ale nie je v ňom cena.' };
    }
  }
  if (price == null && ld.price != null) {
    price = ld.price;
    currency = ld.currency;
    source = 'json-ld';
  }
  if (price == null && raw.itemprop?.price) {
    price = parsePrice(raw.itemprop.price);
    currency = raw.itemprop.currency;
    source = 'microdata';
  }
  if (price == null && raw.meta?.amount) {
    price = parsePrice(raw.meta.amount);
    currency = raw.meta.currency;
    source = 'meta';
  }
  const stock = ld.inStock ?? (stockOf(raw.availability) === 'in' ? true : stockOf(raw.availability) === 'out' ? false : null);
  const name = ld.name || raw.meta?.title || raw.title || null;
  const image = ld.image || raw.meta?.image || null;
  const shop = raw.meta?.site || hostOf(url);

  if (price == null && stock === false) {
    return { price: null, currency: null, inStock: false, listPrice: null, ean: ld.ean, name, image, shop, source: 'stock' };
  }
  if (price == null) {
    return {
      error: raw.selectorMissing
        ? 'Vlastný CSS selektor na stránke nič nenašiel.'
        : 'Na stránke sa nenašla štruktúrovaná cena. Skús v detaile produktu doplniť CSS selektor ceny.',
    };
  }

  const cur = String(currency || '').toUpperCase();
  return {
    price,
    currency: cur === 'EUR' || cur === 'CZK' ? cur : detectCurrency('', url),
    inStock: stock,
    listPrice: listPriceFor(price, ld.listPrice, raw.strikeTexts),
    ean: ld.ean,
    name,
    image,
    shop,
    source,
  };
}

/** Prečiarknutá cena „pred zľavou“: z JSON-LD, inak najvyššia rozumná prečiarknutá cena na stránke. */
function listPriceFor(price, fromLd, strikeTexts = []) {
  const plausible = (v) => v != null && v > price && v <= price * 5;
  if (plausible(fromLd)) return fromLd;
  const candidates = strikeTexts.filter((t) => /€|Kč|EUR|CZK/i.test(t)).map(parsePrice).filter(plausible);
  return candidates.length ? Math.max(...candidates) : null;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Kurz EUR→CZK z denného XML Európskej centrálnej banky. */
export function parseEcbCzk(xml) {
  const m = String(xml || '').match(/currency=['"]CZK['"]\s+rate=['"]([\d.]+)['"]/);
  return m ? Number(m[1]) : null;
}

// ---------- zľavové kódy ----------

const CODE_RE =
  /(?:[Kk][óoÓO][Dd](?:om|u|e)?|[Kk]up[óo]n(?:om|u)?|[Cc]ode)\s*[:„"'“]?\s*([A-Z0-9][A-Z0-9_-]{1,18}[A-Z0-9])(?![A-Za-z0-9áäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ])/;
const PERCENT_RES = [
  /[-−–]\s?(\d{1,2})\s?%/,
  /(?:zľav\w*|zlav\w*|slev\w*|ušetr\w*|extra)\s*[-−–]?\s?(\d{1,2})\s?%/i,
  /(\d{1,2})\s?%\s*(?:zľav|zlav|slev)/i,
];
const MIN_ORDER_RE =
  /(?:min(?:\.|imáln\w*)?|nad|od)\s*(?:nákup\w*\s*)?(?:za\s*|v hodnote\s*)?(\d[\d\s]*(?:[,.]\d+)?)\s*(?:€|Kč|EUR|CZK)/i;
const VALID_RE = /plat[íi]\s+do\s+(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?(?:\s*(\d{4}))?/i;
const SHIPPING_RE = /doprav|poštovn|shipping/i;

const pad = (n) => String(n).padStart(2, '0');

function validUntil(text, now) {
  const m = text.match(VALID_RE);
  if (!m) return null;
  const [, day, month, year] = m;
  let y = year ? Number(year) : now.getUTCFullYear();
  let iso = `${y}-${pad(month)}-${pad(day)}`;
  const today = now.toISOString().slice(0, 10);
  // dátum bez roka, ktorý je dávno za nami (napr. 3. 1. koncom decembra), patrí do budúceho roka
  if (!year && Date.parse(iso) < now.getTime() - 60 * 86_400_000) iso = `${y + 1}-${pad(month)}-${pad(day)}`;
  return iso < today ? 'expired' : iso;
}

/**
 * Zľavový kód z textov akciových blokov na stránke.
 * Vráti { code, percent, price, min_order, valid_until } alebo null, keď si nie je istý
 * (chýba kód alebo percento, ide o dopravu, nezmyselná zľava, kód už neplatí).
 */
export function extractPromo(texts, price, currency, now = new Date()) {
  if (!(price > 0) || !texts?.length) return null;
  const sorted = [...texts].map(String).sort((a, b) => a.length - b.length);

  for (const text of sorted) {
    const code = text.match(CODE_RE)?.[1];
    if (!code || !/[A-Z]/.test(code) || SHIPPING_RE.test(text)) continue;
    const percent = PERCENT_RES.map((re) => text.match(re)?.[1]).find(Boolean);
    if (!percent || Number(percent) < 1 || Number(percent) > 90) continue;

    // podmienky hľadáme v najväčšom bloku s rovnakým kódom (banner + popis akcie)
    const context = sorted.filter((t) => t.includes(code)).at(-1);
    const valid = validUntil(context, now);
    if (valid === 'expired') return null;
    const minOrder = context.match(MIN_ORDER_RE)?.[1];

    return {
      code,
      percent: Number(percent),
      price: Math.round(price * (1 - Number(percent) / 100) * 100) / 100,
      min_order: minOrder ? parsePrice(minOrder) : null,
      valid_until: valid,
    };
  }
  return null;
}
