// Testy Workera cez jeho verejné rozhranie (fetch/scheduled) so skutočným SQL nad node:sqlite.
// Navonok jediná falošná vec je GitHub API, ktoré zaznamenávame namiesto volania.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './d1-shim.mjs';

const TOKEN = 'tajny-kluc';
let env;
let githubCalls;
let githubStatus;
const realFetch = globalThis.fetch;

beforeEach(() => {
  githubCalls = [];
  githubStatus = 204;
  globalThis.fetch = async (url, init) => {
    githubCalls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(null, { status: githubStatus });
  };
  env = {
    DB: createD1(),
    API_TOKEN: TOKEN,
    GITHUB_TOKEN: 'gh',
    GITHUB_REPO: 'jano/strazca-cien',
    VAPID_PUBLIC_KEY: 'verejny',
    ASSETS: { fetch: () => new Response('<!doctype html>pwa') },
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function call(method, path, body, token = TOKEN) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = await worker.fetch(
    new Request(`https://app.test${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    env,
  );
  return { status: res.status, body: await res.json() };
}

const add = (input, extra = {}) => call('POST', '/api/products', { input, ...extra });
const report = (results, rates) => call('POST', '/api/internal/results', { results, rates });
const products = async () => (await call('GET', '/api/products')).body;
const product = async (id) => (await products()).products.find((p) => p.id === id);

async function subscribe(endpoint = 'https://push.test/1') {
  return call('POST', '/api/subscriptions', { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
}

// ---------- prístup ----------

test('API bez kľúča alebo so zlým kľúčom odmietne', async () => {
  assert.equal((await call('GET', '/api/products', null, null)).status, 401);
  assert.equal((await call('GET', '/api/products', null, 'zly-kluc')).status, 401);
  assert.equal((await call('GET', '/api/internal/jobs', null, 'tajny-kluX')).status, 401);
});

test('mimo /api servuje PWA', async () => {
  const res = await worker.fetch(new Request('https://app.test/'), env);
  assert.match(await res.text(), /pwa/);
});

test('config vráti verejný VAPID kľúč', async () => {
  assert.equal((await call('GET', '/api/config')).body.vapidPublicKey, 'verejny');
});

// ---------- pridávanie ----------

test('pridanie cez URL uloží čakajúci produkt a hneď spustí jeho kontrolu', async () => {
  const { status, body } = await add('https://www.alza.sk/sluchadla-d123.htm');
  assert.equal(status, 201);
  assert.equal(body.product.kind, 'url');
  assert.equal(body.product.status, 'pending');
  assert.equal(body.product.shop, 'alza.sk');
  assert.equal(body.product.track_url, 'https://www.alza.sk/sluchadla-d123.htm');
  assert.equal(body.dispatch.ok, true);

  assert.equal(githubCalls.length, 1);
  assert.equal(
    githubCalls[0].url,
    'https://api.github.com/repos/jano/strazca-cien/actions/workflows/check-prices.yml/dispatches',
  );
  assert.equal(githubCalls[0].headers.authorization, 'Bearer gh');
  assert.deepEqual(githubCalls[0].body, { ref: 'main', inputs: { product_id: String(body.product.id) } });
});

test('namiesto odkazu (názov, neúplná adresa) produkt nepridá a vysvetlí prečo', async () => {
  for (const input of ['iPhone 15 128GB', 'ftp://nieco', 'alza.sk']) {
    const { status, body } = await add(input);
    assert.equal(status, 400, input);
    assert.match(body.error, /odkaz na produkt/);
  }
  assert.equal((await products()).products.length, 0);
  assert.equal(githubCalls.length, 0);
});

test('prázdny vstup vráti 400 s vysvetlením', async () => {
  const { status, body } = await add('   ');
  assert.equal(status, 400);
  assert.match(body.error, /URL alebo názov/);
  assert.equal(githubCalls.length, 0);
});

test('keď GitHub odmietne spustenie, produkt sa aj tak uloží a appka dostane dôvod', async () => {
  githubStatus = 401;
  const { status, body } = await add('https://shop.test/x');
  assert.equal(status, 201);
  assert.equal(body.dispatch.ok, false);
  assert.match(body.dispatch.error, /HTTP 401/);
  assert.equal((await products()).products.length, 1);
});

// ---------- výsledky kontroly a notifikácie ----------

test('prvá zistená cena sa uloží bez notifikácie', async () => {
  const { body: added } = await add('https://shop.test/x');
  await subscribe();
  const { body } = await report([{ id: added.product.id, ok: true, price: 100, currency: 'EUR', name: 'Vec' }]);
  assert.deepEqual(body.notifications, []);

  const p = await product(added.product.id);
  assert.equal(p.status, 'ok');
  assert.equal(p.current_price, 100);
  assert.equal(p.name, 'Vec');
});

test('pokles ceny vytvorí notifikáciu a vráti zariadenia na doručenie', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  await subscribe('https://push.test/a');
  await report([{ id, ok: true, price: 100, currency: 'EUR', name: 'Slúchadlá', shop: 'shop.test' }]);
  const { body } = await report([{ id, ok: true, price: 80, currency: 'EUR' }]);

  assert.equal(body.notifications.length, 1);
  const n = body.notifications[0];
  assert.match(n.title, /Zlacnelo: Slúchadlá/);
  assert.match(n.body, /100,00\s€ → 80,00\s€ \(-20\.0 %\)/);
  assert.match(n.body, /shop\.test/);
  assert.equal(n.url, `/#p-${id}`);
  assert.deepEqual(body.subscriptions, [{ endpoint: 'https://push.test/a', keys: { p256dh: 'p', auth: 'a' } }]);
});

test('zdraženie v Kč sa ohlási ako zdraženie s kladným percentom', async () => {
  const id = (await add('https://www.alza.cz/rtx-4070')).body.product.id;
  await report([{ id, ok: true, price: 15000, currency: 'CZK' }]);
  const { body } = await report([{ id, ok: true, price: 16500, currency: 'CZK' }]);
  assert.match(body.notifications[0].title, /Zdražilo/);
  assert.match(body.notifications[0].body, /\+10\.0 %/);
  assert.match(body.notifications[0].body, /Kč/);
});

test('rovnaká cena nič nenotifikuje a nepridá záznam do histórie', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  await report([{ id, ok: true, price: 49.9, currency: 'EUR' }]);
  const { body } = await report([{ id, ok: true, price: 49.904, currency: 'EUR' }]);
  assert.deepEqual(body.notifications, []);
  const { body: hist } = await call('GET', `/api/products/${id}/history`);
  assert.equal(hist.history.length, 1);
});

test('zlyhaná kontrola si nechá poslednú cenu a zaznamená chybu', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  await report([{ id, ok: true, price: 30, currency: 'EUR' }]);
  await report([{ id, ok: false, error: 'Obchod zablokoval automatickú kontrolu (HTTP 403).' }]);
  await report([{ id, ok: false, error: 'Znova 403' }]);

  const p = await product(id);
  assert.equal(p.status, 'error');
  assert.equal(p.current_price, 30);
  assert.equal(p.last_error, 'Znova 403');
  assert.equal(p.error_count, 2);

  await report([{ id, ok: true, price: 30, currency: 'EUR' }]);
  const recovered = await product(id);
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.error_count, 0);
  assert.equal(recovered.last_error, null);
});

test('zoznam vracia predošlú, najnižšiu a najvyššiu cenu aj kurz ECB', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  await report([{ id, ok: true, price: 120, currency: 'EUR' }], { CZK: 24.31 });
  await report([{ id, ok: true, price: 90, currency: 'EUR' }]);
  await report([{ id, ok: true, price: 110, currency: 'EUR' }]);

  const list = await products();
  assert.equal(list.eurCzk, 24.31);
  const p = list.products[0];
  assert.equal(p.current_price, 110);
  assert.equal(p.prev_price, 90);
  assert.equal(p.min_price, 90);
  assert.equal(p.max_price, 120);

  const { body } = await call('GET', `/api/products/${id}/history`);
  assert.deepEqual(body.history.map((h) => h.price), [120, 90, 110]);
});

test('výsledok pre zmazaný produkt sa ticho ignoruje', async () => {
  const { status, body } = await report([{ id: 999, ok: true, price: 5 }]);
  assert.equal(status, 200);
  assert.deepEqual(body.notifications, []);
});

// ---------- úlohy pre scraper ----------

test('jednorazová kontrola vráti daný produkt a všetky čakajúce, plná kontrola všetky', async () => {
  const a = (await add('https://shop.test/a')).body.product.id;
  const b = (await add('https://shop.test/b')).body.product.id;
  const c = (await add('https://shop.test/c')).body.product.id;
  await report([
    { id: a, ok: true, price: 1 },
    { id: b, ok: true, price: 2 },
  ]);

  const single = (await call('GET', `/api/internal/jobs?id=${a}`)).body.products.map((p) => p.id).sort();
  assert.deepEqual(single, [a, c]);
  const all = (await call('GET', '/api/internal/jobs')).body.products.map((p) => p.id).sort();
  assert.deepEqual(all, [a, b, c]);
});

// ---------- úpravy, mazanie, notifikácie ----------

test('zmena CSS selektora vráti produkt do čakania a spustí kontrolu', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  await report([{ id, ok: false, error: 'bez ceny' }]);
  const { body } = await call('PATCH', `/api/products/${id}`, { selector: ' .cena ' });
  assert.equal(body.product.selector, '.cena');
  assert.equal(body.product.status, 'pending');
  assert.equal(githubCalls.at(-1).body.inputs.product_id, String(id));
  assert.equal((await call('PATCH', '/api/products/999', { selector: 'x' })).status, 404);
});

test('zmazanie odstráni produkt aj jeho históriu', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  await report([{ id, ok: true, price: 10 }]);
  await call('DELETE', `/api/products/${id}`);
  assert.equal((await products()).products.length, 0);
  assert.deepEqual((await call('GET', `/api/products/${id}/history`)).body.history, []);
});

test('prihlásenie na notifikácie: neplatné odmietne, rovnaké zariadenie neduplikuje, mŕtve odstráni', async () => {
  assert.equal((await call('POST', '/api/subscriptions', { subscription: { endpoint: 'x' } })).status, 400);
  await subscribe('https://push.test/1');
  await subscribe('https://push.test/1');
  await subscribe('https://push.test/2');
  await call('POST', '/api/internal/subscriptions/remove', { endpoints: ['https://push.test/2'] });

  const id = (await add('https://shop.test/x')).body.product.id;
  await report([{ id, ok: true, price: 10 }]);
  const { body } = await report([{ id, ok: true, price: 9 }]);
  assert.deepEqual(body.subscriptions.map((s) => s.endpoint), ['https://push.test/1']);
});

test('ručná kontrola všetkých cien spustí workflow bez ID produktu', async () => {
  const { status } = await call('POST', '/api/check');
  assert.equal(status, 200);
  assert.deepEqual(githubCalls[0].body.inputs, {});
});

test('cron každých 5 hodín spustí kontrolu všetkých produktov', async () => {
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(githubCalls.length, 1);
  assert.deepEqual(githubCalls[0].body.inputs, {});
});

test('zoznam vracia posledných 12 cien od najstaršej pre mini-graf', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  for (let i = 1; i <= 14; i++) await report([{ id, ok: true, price: i * 10, currency: 'EUR' }]);
  const p = await product(id);
  assert.deepEqual(p.recent_prices, [30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140]);
});

// ---------- upozornenia: cieľová cena, prah, zdraženie ----------

const alerts = (id, body) => call('PATCH', `/api/products/${id}`, body);

test('nastavenie upozornení sa uloží bez novej kontroly a bez zmeny stavu', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  await report([{ id, ok: true, price: 300 }]);
  githubCalls = [];
  const { status, body } = await alerts(id, { target_price: 249.9, min_change_pct: 5, notify_increase: false, notify_stock: false });
  assert.equal(status, 200);
  assert.equal(body.product.target_price, 249.9);
  assert.equal(body.product.min_change_pct, 5);
  assert.equal(body.product.notify_increase, 0);
  assert.equal(body.product.notify_stock, 0);
  assert.equal(body.product.status, 'ok');
  assert.equal(githubCalls.length, 0);

  const cleared = await alerts(id, { target_price: null, min_change_pct: null });
  assert.equal(cleared.body.product.target_price, null);
  assert.equal(cleared.body.product.min_change_pct, null);
});

test('neplatné hodnoty upozornení odmietne', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  assert.equal((await alerts(id, { target_price: -5 })).status, 400);
  assert.equal((await alerts(id, { target_price: 'lacno' })).status, 400);
  assert.equal((await alerts(id, { min_change_pct: 150 })).status, 400);
});

test('s cieľovou cenou príde notifikácia až po jej dosiahnutí', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  await subscribe();
  await alerts(id, { target_price: 250 });
  await report([{ id, ok: true, price: 300, name: 'Slúchadlá' }]);
  assert.deepEqual((await report([{ id, ok: true, price: 260 }])).body.notifications, []);

  const { body } = await report([{ id, ok: true, price: 249 }]);
  assert.equal(body.notifications.length, 1);
  assert.match(body.notifications[0].title, /Cieľová cena dosiahnutá: Slúchadlá/);
  assert.match(body.notifications[0].body, /260,00\s€ → 249,00\s€/);
});

test('prah v percentách sčíta malé poklesy od poslednej notifikácie', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  await subscribe();
  await alerts(id, { min_change_pct: 5 });
  await report([{ id, ok: true, price: 100 }]);
  assert.equal((await report([{ id, ok: true, price: 98 }])).body.notifications.length, 0);
  assert.equal((await report([{ id, ok: true, price: 94 }])).body.notifications.length, 1);
  // ďalšia notifikácia až pri −5 % od 94
  assert.equal((await report([{ id, ok: true, price: 92 }])).body.notifications.length, 0);
  assert.equal((await report([{ id, ok: true, price: 89 }])).body.notifications.length, 1);
});

test('vypnuté upozornenia na zdraženie', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  await alerts(id, { notify_increase: false });
  await report([{ id, ok: true, price: 100 }]);
  assert.equal((await report([{ id, ok: true, price: 120 }])).body.notifications.length, 0);
  assert.equal((await report([{ id, ok: true, price: 110 }])).body.notifications.length, 1);
});

// ---------- znova skladom ----------

test('vypredaný produkt bez ceny si nechá poslednú cenu a označí sa ako vypredaný', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  await report([{ id, ok: true, price: 50, in_stock: true }]);
  const { body } = await report([{ id, ok: true, price: null, in_stock: false }]);
  assert.deepEqual(body.notifications, []);
  const p = await product(id);
  assert.equal(p.status, 'ok');
  assert.equal(p.in_stock, 0);
  assert.equal(p.current_price, 50);
});

test('keď je produkt znova skladom, príde jedna notifikácia aj s cenou', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  await subscribe();
  await report([{ id, ok: true, price: 50, in_stock: false, name: 'Konzola' }]);
  const { body } = await report([{ id, ok: true, price: 45, in_stock: true }]);
  assert.equal(body.notifications.length, 1);
  assert.match(body.notifications[0].title, /Znova skladom: Konzola/);
  assert.match(body.notifications[0].body, /45,00\s€/);
  assert.equal((await product(id)).in_stock, 1);
});

test('upozornenie na sklad sa dá vypnúť a neznáma dostupnosť ho nespustí', async () => {
  const a = (await add('https://shop.test/a')).body.product.id;
  await alerts(a, { notify_stock: false });
  await report([{ id: a, ok: true, price: 50, in_stock: false }]);
  assert.equal((await report([{ id: a, ok: true, price: 50, in_stock: true }])).body.notifications.length, 0);

  const b = (await add('https://shop.test/b')).body.product.id;
  await report([{ id: b, ok: true, price: 50, in_stock: false }]);
  await report([{ id: b, ok: true, price: 50 }]);
  assert.equal((await product(b)).in_stock, 0, 'bez údaja o sklade sa stav nemení');
});

// ---------- falošné zľavy ----------

test('zoznam vyhodnotí zľavu obchodu voči najnižšej cene za 30 dní', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T10:00:00Z') });
  const id = (await add('https://shop.test/x')).body.product.id;
  await report([{ id, ok: true, price: 200 }]);
  t.mock.timers.setTime(Date.parse('2026-10-21T10:00:00Z'));
  await report([{ id, ok: true, price: 260 }]); // zdražené pred akciou
  t.mock.timers.setTime(Date.parse('2026-11-10T10:00:00Z'));
  await report([{ id, ok: true, price: 230, list_price: 380 }]); // „zľava 39 %“

  const p = await product(id);
  assert.equal(p.list_price, 380);
  assert.equal(p.prior_low_30d, 200);
  assert.equal(p.history_days, 40);
  assert.deepEqual(p.discount, { claimedPct: 39, realPct: -15, verdict: 'fake' });
});

test('keď obchod prestane uvádzať prečiarknutú cenu, zľava zmizne', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  await report([{ id, ok: true, price: 100, list_price: 150 }]);
  await report([{ id, ok: true, price: 100 }]);
  const p = await product(id);
  assert.equal(p.list_price, null);
  assert.equal(p.discount.verdict, null);
});

// ---------- opakované zlyhanie ----------

test('po treťom zlyhaní za sebou príde jedna notifikácia, po zotavení sa počíta odznova', async () => {
  const id = (await add('https://shop.test/x')).body.product.id;
  await subscribe();
  await report([{ id, ok: true, price: 10, name: 'Mixér' }]);
  const fail = (error = 'Obchod zablokoval automatickú kontrolu (HTTP 403).') => report([{ id, ok: false, error }]);

  assert.equal((await fail()).body.notifications.length, 0);
  assert.equal((await fail()).body.notifications.length, 0);
  const third = (await fail()).body;
  assert.equal(third.notifications.length, 1);
  assert.match(third.notifications[0].title, /Sledovanie zlyháva: Mixér/);
  assert.match(third.notifications[0].body, /3× po sebe.*HTTP 403/);
  assert.equal(third.subscriptions.length, 1);
  assert.equal((await fail()).body.notifications.length, 0, 'štvrté zlyhanie už nie');

  await report([{ id, ok: true, price: 10 }]);
  await fail();
  await fail();
  assert.equal((await fail()).body.notifications.length, 1);
});

// ---------- upozornenie z kanárika ----------

test('interné upozornenie vráti notifikáciu a zariadenia na doručenie', async () => {
  await subscribe('https://push.test/k');
  const { status, body } = await call('POST', '/api/internal/alert', { title: 'Kanárik: 2 obchody zlyhali', body: 'Alza.sk, Nay.sk' });
  assert.equal(status, 200);
  assert.deepEqual(body.notifications, [{ title: 'Kanárik: 2 obchody zlyhali', body: 'Alza.sk, Nay.sk', url: '/', tag: 'canary' }]);
  assert.deepEqual(body.subscriptions.map((s) => s.endpoint), ['https://push.test/k']);
  assert.equal((await call('POST', '/api/internal/alert', {})).status, 400);
});
