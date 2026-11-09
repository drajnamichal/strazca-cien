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
