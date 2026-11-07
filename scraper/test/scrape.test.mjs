// Integračné testy scrapera v skutočnom Chromiu. Sieť je nahradená lokálnymi HTML fixtures,
// takže testy sú rýchle, stabilné a nezávislé od skutočných e-shopov.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createContext, checkProduct } from '../scrape.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

let browser;
let context;
let requests;

before(async () => {
  // CHROMIUM_PATH umožní spustiť testy s už nainštalovaným Chromom
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
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

test('názov produktu: nájde správny model na Heureke a sleduje jeho najnižšiu cenu', async () => {
  await serve({
    'https://www.heureka.sk/*': 'heureka-search.html',
    'https://mobilne-telefony.heureka.sk/apple-iphone-15-128gb/': 'heureka-product.html',
  });
  const r = await checkProduct(context, queryProduct('iphone 15'));
  assert.equal(r.ok, true);
  assert.equal(r.track_url, 'https://mobilne-telefony.heureka.sk/apple-iphone-15-128gb/');
  assert.equal(r.price, 689); // lowPrice zo stránky produktu, nie 699 z výsledkov
  assert.equal(r.name, 'Apple iPhone 15 128GB');
  assert.match(r.shop, /najnižšia cena/);
  assert.ok(requests.some((u) => u.includes('h%5Bfraze%5D=iphone%2015')), 'hľadalo sa podľa zadaného názvu');
});

test('názov produktu: keď stránka produktu nemá cenu, použije cenu z výsledkov vyhľadávania', async () => {
  await serve({
    'https://www.heureka.sk/*': 'heureka-search.html',
    'https://mobilne-telefony.heureka.sk/apple-iphone-15-128gb/': 'heureka-product-plain.html',
  });
  const r = await checkProduct(context, queryProduct('iphone 15'));
  assert.equal(r.ok, true);
  assert.equal(r.price, 699);
});

test('názov produktu na CZ trhu hľadá na Heureka.cz a cenu vedie v Kč', async () => {
  await serve({
    'https://www.heureka.cz/*': 'heureka-search.html',
    'https://mobilne-telefony.heureka.sk/apple-iphone-15-128gb/': 'heureka-product-plain.html',
  });
  const r = await checkProduct(context, queryProduct('iphone 15', { market: 'cz' }));
  assert.equal(r.currency, 'CZK');
  assert.ok(requests[0].startsWith('https://www.heureka.cz/'));
});

test('už nájdený produkt sa pri ďalšej kontrole znova nehľadá', async () => {
  await serve({ 'https://mobilne-telefony.heureka.sk/apple-iphone-15-128gb/': 'heureka-product.html' });
  const r = await checkProduct(
    context,
    queryProduct('iphone 15', { track_url: 'https://mobilne-telefony.heureka.sk/apple-iphone-15-128gb/' }),
  );
  assert.equal(r.price, 689);
  assert.ok(!requests.some((u) => u.startsWith('https://www.heureka.sk/')));
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

// ---------- lacnejšie v inom obchode ----------

test('produkt s EAN sa porovná s najnižšou ponukou na Heureke', async () => {
  await serve({
    'https://www.alza.sk/sony': 'shop-ean.html',
    'https://www.heureka.sk/*': 'heureka-ean-search.html',
  });
  const r = await checkProduct(context, urlProduct('https://www.alza.sk/sony'));
  assert.equal(r.price, 299);
  assert.equal(r.ean, '5901234123457');
  assert.equal(r.best_offer_price, 279);
  assert.equal(r.best_offer_url, 'https://sluchadla.heureka.sk/sony-wh-1000xm5/');
  assert.ok(requests.some((u) => u.includes('h%5Bfraze%5D=5901234123457')), 'hľadalo sa podľa EAN');
});

test('keď hľadanie EAN skončí rovno na stránke produktu, cena sa vezme z nej', async () => {
  // Heureka pri presnej zhode presmeruje na produkt; tu vráti produkt priamo na adrese hľadania
  await serve({ 'https://www.alza.sk/sony': 'shop-ean.html', 'https://www.heureka.sk/*': 'heureka-sony.html' });
  const r = await checkProduct(context, urlProduct('https://www.alza.sk/sony'));
  assert.equal(r.best_offer_price, 275);
  assert.match(r.best_offer_url, /^https:\/\/www\.heureka\.sk\//);
});

test('už nájdená stránka na Heureke sa nabudúce otvorí priamo', async () => {
  await serve({
    'https://www.alza.sk/sony': 'shop-ean.html',
    'https://sluchadla.heureka.sk/sony-wh-1000xm5/': 'heureka-sony.html',
  });
  const r = await checkProduct(
    context,
    urlProduct('https://www.alza.sk/sony', { best_offer_url: 'https://sluchadla.heureka.sk/sony-wh-1000xm5/' }),
  );
  assert.equal(r.best_offer_price, 275);
  assert.ok(!requests.some((u) => u.startsWith('https://www.heureka.sk/')));
});

test('keď Heureka produkt nepozná, porovnanie sa vynuluje', async () => {
  await serve({ 'https://www.alza.sk/sony': 'shop-ean.html', 'https://www.heureka.sk/*': 'heureka-empty.html' });
  const r = await checkProduct(context, urlProduct('https://www.alza.sk/sony'));
  assert.equal(r.ok, true);
  assert.equal(r.best_offer_price, null);
  assert.equal(r.best_offer_url, null);
});

test('zlyhanie Heureky nepokazí kontrolu ceny a porovnanie sa neodošle', async () => {
  await serve({ 'https://www.alza.sk/sony': 'shop-ean.html', 'https://www.heureka.sk/*': { status: 403 } });
  const r = await checkProduct(context, urlProduct('https://www.alza.sk/sony'));
  assert.equal(r.ok, true);
  assert.equal(r.price, 299);
  assert.equal('best_offer_price' in r, false);
});

test('bez EAN, s vypnutým upozornením alebo pri produkte z hľadania sa Heureka nevolá', async () => {
  await serve({ 'https://shop.test/sony': 'shop-jsonld.html', 'https://www.alza.sk/sony': 'shop-ean.html' });
  await checkProduct(context, urlProduct('https://shop.test/sony'));
  await checkProduct(context, urlProduct('https://www.alza.sk/sony', { notify_elsewhere: 0 }));
  assert.ok(!requests.some((u) => u.includes('heureka')));
});

// ---------- kanárik nad fixtures ----------

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
