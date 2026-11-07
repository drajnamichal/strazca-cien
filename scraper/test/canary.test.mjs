import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCanary, canaryProduct, summaryMarkdown, alertText } from '../canary-lib.mjs';

const entry = { name: 'Alza.sk', input: 'https://www.alza.sk/x', kind: 'url', currency: 'EUR', min: 100, max: 500 };
const ok = (extra = {}) => ({ ok: true, price: 299, currency: 'EUR', in_stock: true, ...extra });

test('kanárik prejde, keď cena a mena dávajú zmysel', () => {
  assert.deepEqual(evaluateCanary(entry, ok()), { name: 'Alza.sk', ok: true, detail: '299 EUR' });
});

test('kanárik zlyhá pri chybe kontroly aj pri výnimke', () => {
  assert.deepEqual(evaluateCanary(entry, { ok: false, error: 'Obchod zablokoval automatickú kontrolu (HTTP 403).' }), {
    name: 'Alza.sk', ok: false, detail: 'Obchod zablokoval automatickú kontrolu (HTTP 403).',
  });
  assert.equal(evaluateCanary(entry, null, new Error('Timeout 45000ms exceeded.\nstack')).detail, 'Timeout 45000ms exceeded.');
});

test('kanárik zlyhá, keď parser vráti nezmyselnú cenu alebo inú menu', () => {
  assert.match(evaluateCanary(entry, ok({ price: 2.99 })).detail, /mimo očakávaného rozsahu 100–500/);
  assert.equal(evaluateCanary(entry, ok({ price: 2.99 })).ok, false);
  assert.equal(evaluateCanary(entry, ok({ price: 5000 })).ok, false);
  assert.match(evaluateCanary(entry, ok({ currency: 'CZK' })).detail, /mena CZK namiesto EUR/);
});

test('vypredaný produkt nie je chyba parsera, len varovanie', () => {
  const r = evaluateCanary(entry, ok({ price: null, in_stock: false }));
  assert.equal(r.ok, true);
  assert.match(r.detail, /vypredané/);
});

test('z položky konfigurácie vznikne produkt pre scraper', () => {
  assert.deepEqual(canaryProduct(entry, 3), {
    id: 3, kind: 'url', market: 'sk', input: 'https://www.alza.sk/x', track_url: 'https://www.alza.sk/x', selector: null, notify_elsewhere: 0,
  });
  const q = canaryProduct({ name: 'Heureka CZ', input: 'iPhone 15', kind: 'query', market: 'cz' }, 0);
  assert.equal(q.track_url, null);
  assert.equal(q.market, 'cz');
});

test('súhrn pre GitHub a text upozornenia', () => {
  const rows = [
    { name: 'Alza.sk', ok: true, detail: '299 EUR' },
    { name: 'Nay.sk', ok: false, detail: 'HTTP 403' },
  ];
  const md = summaryMarkdown(rows);
  assert.match(md, /\| ✅ \| Alza\.sk \| 299 EUR \|/);
  assert.match(md, /\| ❌ \| Nay\.sk \| HTTP 403 \|/);
  assert.match(md, /1 z 2 obchodov zlyhalo/);
  assert.deepEqual(alertText(rows), { title: 'Kanárik: 1 obchod zlyhal', body: 'Nay.sk: HTTP 403' });
  assert.equal(alertText([...rows, { name: 'Mall.sk', ok: false, detail: 'x' }]).title, 'Kanárik: 2 obchody zlyhali');
  assert.equal(alertText([rows[0]]), null);
});
