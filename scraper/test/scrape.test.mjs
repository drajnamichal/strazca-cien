// Integračné testy scrapera v skutočnom Chromiu. Sieť je nahradená lokálnymi HTML fixtures,
// takže testy sú rýchle, stabilné a nezávislé od skutočných e-shopov.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, checkProduct, launchBrowser, settings, QUERY_UNSUPPORTED } from '../scrape.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

let browser;
let context;
let requests;

before(async () => {
  // CHROMIUM_PATH umožní spustiť testy s už nainštalovaným Chromom
  browser = await launchBrowser({ executablePath: process.env.CHROMIUM_PATH || undefined });
  settings.retryDelayMs = 0; // v testoch bez čakania
});
after(async () => {
  await browser?.close();
});

beforeEach(async () => {
  context = await createContext(browser);
  requests = [];
});
afterEach(async () => {
  await context.close();
});

/** Zaregistruje odpovede: { 'https://url': 'fixture.html' | { status } } */
async function serve(map) {
  await context.route('**/*', (route) => {
    const url = route.request().url();
    requests.push(url);
    const key = Object.keys(map).find((k) => (k.endsWith('*') ? url.startsWith(k.slice(0, -1)) : url === k));
    if (!key) return route.fulfill({ status: 404, body: 'not found' });
    const value = map[key];
    if (typeof value === 'object') return route.fulfill({ status: value.status, body: 'blocked' });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture(value) });
  });
}

const urlProduct = (track_url, extra = {}) => ({ id: 1, kind: 'url', market: 'sk', track_url, selector: null, ...extra });
const queryProduct = (input, extra = {}) => ({ id: 2, kind: 'query', market: 'sk', input, track_url: null, selector: null, ...extra });

test('URL produktu: cena, názov a obchod zo štruktúrovaných dát', async () => {
  await serve({ 'https://shop.test/sony': 'shop-jsonld.html' });
  const r = await checkProduct(context, urlProduct('https://shop.test/sony'));
  assert.equal(r.ok, true);
  assert.equal(r.price, 299.9);
  assert.equal(r.currency, 'EUR');
  assert.equal(r.name, 'Sony WH-1000XM5');
  assert.equal(r.shop, 'Testovací obchod');
});

test('URL produktu: cenu doplnenú JavaScriptom po načítaní tiež nájde', async () => {
  await serve({ 'https://shop.test/mixer': 'shop-js.html' });
  const r = await checkProduct(context, urlProduct('https://shop.test/mixer'));
  assert.equal(r.price, 59.99);
});

test('URL bez štruktúrovanej ceny vráti chybu s radou, s CSS selektorom cenu nájde', async () => {
  await serve({ 'https://shop.test/kavovar': 'shop-plain.html' });
  const without = await checkProduct(context, urlProduct('https://shop.test/kavovar'));
  assert.equal(without.ok, false);
  assert.match(without.error, /CSS selektor/);

  const withSelector = await checkProduct(context, urlProduct('https://shop.test/kavovar', { selector: '.cena' }));
  assert.equal(withSelector.ok, true);
  assert.equal(withSelector.price, 849);
});

test('CSS selektor, ktorý na stránke nič nenájde, sa ohlási ako chyba', async () => {
  await serve({ 'https://shop.test/kavovar': 'shop-plain.html' });
  const r = await checkProduct(context, urlProduct('https://shop.test/kavovar', { selector: '.neexistuje' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /nič nenašiel/);
});

test('zablokovaný prístup (HTTP 403) skončí zrozumiteľnou chybou', async () => {
  await serve({ 'https://shop.test/blok': { status: 403 } });
  await assert.rejects(checkProduct(context, urlProduct('https://shop.test/blok')), /zablokoval/);
});

test('akcia: zistí dostupnosť aj prečiarknutú cenu „pred zľavou“', async () => {
  await serve({ 'https://shop.test/vysavac': 'shop-sale.html' });
  const r = await checkProduct(context, urlProduct('https://shop.test/vysavac'));
  assert.equal(r.ok, true);
  assert.equal(r.price, 229);
  assert.equal(r.list_price, 379);
  assert.equal(r.in_stock, true);
});

test('vypredaný produkt bez ceny sa vráti ako vypredaný, nie ako chyba', async () => {
  await serve({ 'https://shop.test/konzola': 'shop-soldout.html' });
  const r = await checkProduct(context, urlProduct('https://shop.test/konzola'));
  assert.equal(r.ok, true);
  assert.equal(r.price, null);
  assert.equal(r.in_stock, false);
  assert.equal(r.name, 'Herná konzola | Obchod');
});

test('kanárik prejde skutočnou cestou scrapera a nahlási zlyhaný obchod', async () => {
  const { runCanary } = await import('../canary.mjs');
  await serve({ 'https://shop.test/sony': 'shop-jsonld.html', 'https://shop.test/blok': { status: 403 } });
  const rows = await runCanary(
    context,
    [
      { name: 'Dobrý obchod', input: 'https://shop.test/sony', kind: 'url', currency: 'EUR', min: 100, max: 500 },
      { name: 'Blokujúci obchod', input: 'https://shop.test/blok', kind: 'url', currency: 'EUR', min: 1, max: 10 },
    ],
    { pause: 0 },
  );
  assert.deepEqual(rows.map((r) => r.ok), [true, false]);
  assert.match(rows[1].detail, /zablokoval/);
});

// ---------- menej nápadný prehliadač, opakovanie pri blokovaní ----------

test('prehliadač sa neprezradí ako automatizovaný', async () => {
  await serve({ 'https://shop.test/': 'shop-plain.html' });
  const page = await context.newPage();
  await page.goto('https://shop.test/');
  const info = await page.evaluate(() => ({
    webdriver: navigator.webdriver,
    ua: navigator.userAgent,
    languages: navigator.languages,
    hasChrome: typeof window.chrome === 'object',
  }));
  await page.close();
  assert.ok(!info.webdriver, 'navigator.webdriver nie je true');
  assert.doesNotMatch(info.ua, /Headless/i);
  assert.match(info.ua, /Chrome\/\d+/);
  assert.equal(info.languages[0], 'sk-SK');
  assert.ok(info.hasChrome, 'window.chrome existuje ako v bežnom Chrome');
});

test('posiela hlavičky ako bežný prehliadač po slovensky', async () => {
  // skutočný lokálny server: vidí hlavičky tak, ako odídu do siete
  const { createServer } = await import('node:http');
  let headers;
  const server = createServer((req, res) => {
    headers = req.headers;
    res.end('<title>ok</title>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.close();
  server.close();
  assert.equal(headers['accept-language'], 'sk-SK,sk;q=0.9,cs;q=0.8,en;q=0.7');
  assert.doesNotMatch(headers['user-agent'], /Headless/i);
});

test('pri jednorazovom 403 to skúsi znova a uspeje', async () => {
  let calls = 0;
  await context.route('https://shop.test/obcas', (route) => {
    calls++;
    return calls === 1
      ? route.fulfill({ status: 403, contentType: 'text/html', body: '<title>Prístup odmietnutý</title>' })
      : route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture('shop-jsonld.html') });
  });
  const r = await checkProduct(context, urlProduct('https://shop.test/obcas'));
  assert.equal(r.ok, true);
  assert.equal(r.price, 299.9);
  assert.equal(calls, 2);
});

test('trvalé blokovanie skončí chybou s nadpisom stránky pre diagnostiku', async () => {
  await context.route('https://shop.test/stale', (route) =>
    route.fulfill({ status: 403, contentType: 'text/html', body: '<title>Just a moment...</title>' }),
  );
  await assert.rejects(checkProduct(context, urlProduct('https://shop.test/stale')), (err) => {
    assert.match(err.message, /zablokoval automatickú kontrolu \(HTTP 403/);
    assert.match(err.message, /Just a moment/);
    return true;
  });
});

test('produkt pridaný kedysi názvom sa nekontroluje a nikam sa nechodí', async () => {
  await serve({});
  const r = await checkProduct(context, queryProduct('iphone 15'));
  assert.deepEqual(r, { id: 2, ok: false, error: QUERY_UNSUPPORTED });
  assert.deepEqual(requests, []);
});

test('EAN zo stránky obchodu sa pošle ďalej (pre odkaz na Heureku v appke)', async () => {
  await serve({ 'https://www.alza.sk/sony': 'shop-ean.html' });
  const r = await checkProduct(context, urlProduct('https://www.alza.sk/sony'));
  assert.equal(r.ean, '5901234123457');
  assert.equal(r.price, 299);
  assert.deepEqual(requests, ['https://www.alza.sk/sony'], 'žiadna iná stránka sa neotvára');
});

// ---------- zľavové kódy ----------

test('na stránke s akciou rozpozná zľavový kód a cenu po zľave', async () => {
  await serve({ 'https://www.eobuv.sk/geox': 'shop-promo.html' });
  const r = await checkProduct(context, urlProduct('https://www.eobuv.sk/geox'));
  assert.equal(r.price, 87.99, 'hlavná sledovaná cena sa nemení');
  assert.equal(r.promo.code, 'SINGLE');
  assert.equal(r.promo.percent, 20);
  assert.equal(r.promo.price, 70.39);
  assert.equal(r.promo.min_order, 75);
  assert.match(r.promo.valid_until, /^\d{4}-11-11$/);
});

test('stránka bez kódu vráti promo null', async () => {
  await serve({ 'https://shop.test/sony': 'shop-jsonld.html' });
  const r = await checkProduct(context, urlProduct('https://shop.test/sony'));
  assert.equal(r.promo, null);
});
