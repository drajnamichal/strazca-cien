import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldNotify, priorLow30, discountInfo } from '../src/pricing.js';

const product = (fields = {}) => ({
  target_price: null,
  min_change_pct: null,
  notify_increase: 1,
  last_notified_price: null,
  ...fields,
});

// ---------- kedy poslať notifikáciu ----------

test('bez nastavení upozorní na každú zmenu', () => {
  assert.equal(shouldNotify(product(), 100, 99.9).notify, true);
  assert.equal(shouldNotify(product(), 100, 101).notify, true);
});

test('prvá zistená cena nikdy neupozorní', () => {
  assert.equal(shouldNotify(product(), null, 50).notify, false);
});

test('vypnuté zdraženie: upozorní len na pokles', () => {
  const p = product({ notify_increase: 0 });
  assert.equal(shouldNotify(p, 100, 110).notify, false);
  assert.equal(shouldNotify(p, 100, 90).notify, true);
});

test('cieľová cena: upozorní až keď cena klesne na cieľ alebo pod neho', () => {
  const p = product({ target_price: 250 });
  assert.equal(shouldNotify(p, 300, 260).notify, false);
  const hit = shouldNotify(p, 260, 250);
  assert.equal(hit.notify, true);
  assert.equal(hit.reason, 'target');
  assert.equal(shouldNotify(p, 250, 240).notify, true, 'ďalší pokles pod cieľom tiež');
  assert.equal(shouldNotify(p, 240, 245).notify, false, 'zdraženie pod cieľom nie');
});

test('prah v percentách sa počíta od ceny pri poslednej notifikácii, nie od poslednej zmeny', () => {
  const p = product({ min_change_pct: 5, last_notified_price: 100 });
  assert.equal(shouldNotify(p, 100, 98).notify, false);
  // postupné malé poklesy sa sčítajú: 100 → 98 → 96 → 94,5 (−5,5 %)
  assert.equal(shouldNotify(p, 98, 96).notify, false);
  assert.equal(shouldNotify(p, 96, 94.5).notify, true);
});

test('prah bez predošlej notifikácie sa počíta od predošlej ceny', () => {
  const p = product({ min_change_pct: 10 });
  assert.equal(shouldNotify(p, 100, 91).notify, false);
  assert.equal(shouldNotify(p, 100, 90).notify, true);
});

test('cieľ aj prah naraz: musia platiť obe podmienky', () => {
  const p = product({ target_price: 250, min_change_pct: 10, last_notified_price: 270 });
  assert.equal(shouldNotify(p, 255, 249).notify, false, 'pod cieľom, ale len −7,8 % od poslednej notifikácie');
  assert.equal(shouldNotify(p, 255, 243).notify, true);
});

// ---------- najnižšia cena za 30 dní pred zľavou ----------

const day = (n) => new Date(Date.UTC(2026, 9, 1) + n * 86400_000).toISOString();

test('30-dňové minimum berie ceny platné v 30 dňoch pred začiatkom aktuálnej ceny', () => {
  const history = [
    { price: 200, checked_at: day(0) },  // platila do dňa 20, teda aj na začiatku okna (deň 10)
    { price: 260, checked_at: day(20) }, // „zdražené pred akciou“
    { price: 230, checked_at: day(40) }, // aktuálna „zľava“
  ];
  const r = priorLow30(history);
  assert.equal(r.priorLow, 200);
  assert.equal(r.days, 40);
});

test('ceny staršie ako 30 dní pred akciou sa nepočítajú', () => {
  const history = [
    { price: 150, checked_at: day(0) },
    { price: 260, checked_at: day(5) },
    { price: 230, checked_at: day(60) },
  ];
  assert.equal(priorLow30(history).priorLow, 260);
});

test('bez predošlej ceny nie je s čím porovnať', () => {
  assert.equal(priorLow30([{ price: 99, checked_at: day(0) }]).priorLow, null);
  assert.equal(priorLow30([]).priorLow, null);
});

// ---------- verdikt o zľave ----------

test('zľava od zdraženej ceny je falošná', () => {
  const d = discountInfo({ current: 230, listPrice: 380, priorLow: 200 });
  assert.equal(d.claimedPct, 39);
  assert.equal(d.realPct, -15);
  assert.equal(d.verdict, 'fake');
});

test('zľava výrazne menšia, než tvrdí obchod, je zavádzajúca', () => {
  const d = discountInfo({ current: 270, listPrice: 400, priorLow: 300 });
  assert.equal(d.claimedPct, 33);
  assert.equal(d.realPct, 10);
  assert.equal(d.verdict, 'misleading');
});

test('zľava, ktorá sedí s históriou, je reálna', () => {
  assert.equal(discountInfo({ current: 240, listPrice: 300, priorLow: 300 }).verdict, 'real');
});

test('bez prečiarknutej ceny verdikt nie je, ale skutočný pokles áno', () => {
  const d = discountInfo({ current: 90, listPrice: null, priorLow: 100 });
  assert.equal(d.verdict, null);
  assert.equal(d.realPct, 10);
});

test('bez histórie sa zľava nedá overiť', () => {
  const d = discountInfo({ current: 90, listPrice: 150, priorLow: null });
  assert.equal(d.claimedPct, 40);
  assert.equal(d.verdict, 'unknown');
});
