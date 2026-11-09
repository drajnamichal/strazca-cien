import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, detectCurrency, extractFromJsonLd, extractPrice, parseEcbCzk } from '../extract.mjs';

test('parsePrice zvláda slovenské, české aj strojové formáty', () => {
  const cases = [
    ['1 299,90 €', 1299.9],
    ['1\u00a0299 Kč', 1299],
    ['1.299,-', 1299],
    ['12,99 €', 12.99],
    ['12.99', 12.99],
    ['1299.00', 1299],
    ['1,299.50', 1299.5],
    ['od 349 €', 349],
    ['2.499.000', 2499000],
    [499, 499],
    ['zadarmo', null],
    [0, null],
  ];
  for (const [input, expected] of cases) assert.equal(parsePrice(input), expected, String(input));
});

test('detectCurrency podľa textu a domény', () => {
  assert.equal(detectCurrency('99 €'), 'EUR');
  assert.equal(detectCurrency('99 Kč'), 'CZK');
  assert.equal(detectCurrency('', 'https://www.alza.cz/x'), 'CZK');
  assert.equal(detectCurrency('', 'https://www.alza.sk/x'), 'EUR');
});

test('JSON-LD Product s Offer', () => {
  const r = extractFromJsonLd([
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Slúchadlá X',
      image: ['https://e.sk/a.jpg'],
      offers: { '@type': 'Offer', price: '89.90', priceCurrency: 'EUR', availability: 'https://schema.org/InStock' },
    }),
  ]);
  assert.deepEqual(r, { name: 'Slúchadlá X', image: 'https://e.sk/a.jpg', price: 89.9, currency: 'EUR', inStock: true, listPrice: null, ean: null });
});

test('JSON-LD AggregateOffer (porovnávače) berie lowPrice', () => {
  const r = extractFromJsonLd([
    JSON.stringify({
      '@graph': [
        { '@type': 'WebPage' },
        { '@type': ['Product'], name: 'Mobil', offers: { '@type': 'AggregateOffer', lowPrice: 649, highPrice: 799, priceCurrency: 'EUR' } },
      ],
    }),
  ]);
  assert.equal(r.price, 649);
});

test('JSON-LD uprednostní skladom pred vypredanou ponukou', () => {
  const r = extractFromJsonLd([
    JSON.stringify({
      '@type': 'Product',
      name: 'Y',
      offers: [
        { '@type': 'Offer', price: 10, priceCurrency: 'EUR', availability: 'OutOfStock' },
        { '@type': 'Offer', price: 12, priceCurrency: 'EUR', availability: 'InStock' },
      ],
    }),
  ]);
  assert.equal(r.price, 12);
});

test('poškodený JSON-LD nezhodí extrakciu', () => {
  assert.equal(extractFromJsonLd(['{nie je json', '']).price, null);
});

test('extractPrice: vlastný selektor má prednosť, inak meta tagy', () => {
  const base = { jsonLd: [], meta: { amount: '50', currency: 'EUR' }, itemprop: null, title: 'T' };
  assert.equal(extractPrice({ ...base, selectorText: '45,90 €' }, 'https://x.sk').price, 45.9);
  assert.equal(extractPrice({ ...base, selectorText: null }, 'https://x.sk').price, 50);
  assert.match(extractPrice({ ...base, meta: {}, selectorText: null }, 'https://x.sk').error, /CSS selektor/);
});

test('parseEcbCzk', () => {
  assert.equal(parseEcbCzk("<Cube currency='USD' rate='1.08'/><Cube currency='CZK' rate='24.335'/>"), 24.335);
});

// ---------- dostupnosť a prečiarknutá cena ----------

const ld = (offers) => JSON.stringify({ '@type': 'Product', name: 'P', offers });

test('dostupnosť z JSON-LD: skladom, vypredané, neznáma', () => {
  assert.equal(extractFromJsonLd([ld({ '@type': 'Offer', price: 10, availability: 'https://schema.org/InStock' })]).inStock, true);
  assert.equal(extractFromJsonLd([ld({ '@type': 'Offer', price: 10, availability: 'http://schema.org/OutOfStock' })]).inStock, false);
  assert.equal(extractFromJsonLd([ld({ '@type': 'Offer', price: 10 })]).inStock, null);
  assert.equal(
    extractFromJsonLd([ld([
      { '@type': 'Offer', price: 10, availability: 'OutOfStock' },
      { '@type': 'Offer', price: 12, availability: 'LimitedAvailability' },
    ])]).inStock,
    true,
    'stačí jedna dostupná ponuka',
  );
});

test('prečiarknutá cena z JSON-LD (StrikethroughPrice)', () => {
  const r = extractFromJsonLd([ld({
    '@type': 'Offer', price: 299, priceCurrency: 'EUR',
    priceSpecification: [{ '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/StrikethroughPrice', price: 399 }],
  })]);
  assert.equal(r.price, 299);
  assert.equal(r.listPrice, 399);
});

const raw = (extra) => ({ jsonLd: [], meta: { amount: '299.90', currency: 'EUR' }, itemprop: null, title: 'T', strikeTexts: [], ...extra });

test('prečiarknutá cena zo stránky: berie len rozumnú vyššiu cenu', () => {
  assert.equal(extractPrice(raw({ strikeTexts: ['349,00 €'] }), 'https://x.sk').listPrice, 349);
  assert.equal(extractPrice(raw({ strikeTexts: ['199,00 €'] }), 'https://x.sk').listPrice, null, 'nižšia nie je pôvodná cena');
  assert.equal(extractPrice(raw({ strikeTexts: ['9 999,00 €'] }), 'https://x.sk').listPrice, null, 'viac ako 5× je nezmysel');
  assert.equal(extractPrice(raw({ strikeTexts: ['Doprava zadarmo', '379,00 €', '349 €'] }), 'https://x.sk').listPrice, 379);
});

test('dostupnosť z microdata, keď JSON-LD chýba', () => {
  assert.equal(extractPrice(raw({ availability: 'http://schema.org/OutOfStock' }), 'https://x.sk').inStock, false);
  assert.equal(extractPrice(raw({ availability: 'https://schema.org/InStock' }), 'https://x.sk').inStock, true);
  assert.equal(extractPrice(raw({}), 'https://x.sk').inStock, null);
});

test('vypredaný produkt bez ceny nie je chyba', () => {
  const r = extractPrice(raw({ meta: {}, availability: 'OutOfStock' }), 'https://x.sk');
  assert.equal(r.error, undefined);
  assert.equal(r.price, null);
  assert.equal(r.inStock, false);
});

// ---------- EAN ----------

test('EAN z JSON-LD: gtin13, gtin, číslo aj text, neplatné ignoruje', () => {
  const ean = (fields) => extractFromJsonLd([JSON.stringify({ '@type': 'Product', name: 'P', offers: { price: 1 }, ...fields })]).ean;
  assert.equal(ean({ gtin13: '5901234123457' }), '5901234123457');
  assert.equal(ean({ gtin: 4006381333931 }), '4006381333931');
  assert.equal(ean({ gtin8: '96385074' }), '96385074');
  assert.equal(ean({ gtin13: 'nie-je-ean' }), null);
  assert.equal(ean({}), null);
  assert.equal(extractPrice(raw({ jsonLd: [JSON.stringify({ '@type': 'Product', gtin13: '5901234123457', offers: { price: 5 } })] }), 'https://x.sk').ean, '5901234123457');
});

// ---------- zľavové kódy ----------
import { extractPromo } from '../extract.mjs';

const NOW = new Date('2026-11-09T10:00:00Z');
const eobuv = [
  'extra -20% Kód: SINGLE · Platí do 11 . 11',
  "extra -20% Kód: SINGLE · Platí do 11 . 11 SINGLES' DAY Extra -20% zľava na nákup tohto produktu, pri nákupe za min. 75 € v košíku SINGLE Ďalšie produkty v akcii",
];

test('rozpozná kód, percento, minimálny nákup a platnosť (eobuv.sk)', () => {
  assert.deepEqual(extractPromo(eobuv, 87.99, 'EUR', NOW), {
    code: 'SINGLE',
    percent: 20,
    price: 70.39,
    min_order: 75,
    valid_until: '2026-11-11',
  });
});

test('rôzne zápisy kódu a meny', () => {
  const r = extractPromo(['Zadajte kupón LETO15 a získajte zľavu 15 % na celý nákup nad 1 000 Kč'], 2000, 'CZK', NOW);
  assert.equal(r.code, 'LETO15');
  assert.equal(r.percent, 15);
  assert.equal(r.price, 1700);
  assert.equal(r.min_order, 1000);
  assert.equal(r.valid_until, null);
  assert.equal(extractPromo(['S kódom BLACK-FRIDAY ušetríte −25 %'], 100, 'EUR', NOW).code, 'BLACK-FRIDAY');
});

test('keď si nie je istý, nič nevráti', () => {
  const none = (texts) => extractPromo(texts, 100, 'EUR', NOW);
  assert.equal(none(['Najlepšia cena na trhu']), null, 'bez kódu');
  assert.equal(none(['Kód: SINGLE']), null, 'bez percenta');
  assert.equal(none(['Zľavový kód nájdete v e-maile, ušetríte 10 %']), null, 'bežné slovo nie je kód');
  assert.equal(none(['Kód DOPRAVA10: zľava 10 % na dopravu']), null, 'kód na dopravu');
  assert.equal(none(['Kód: MEGA -95 %']), null, 'nezmyselné percento');
  assert.equal(none(['Kód: SINGLE -20 % Platí do 1. 11.']), null, 'kód už neplatí');
  assert.equal(none([]), null);
});

test('platnosť cez koniec roka patrí do budúceho roka', () => {
  const dec = new Date('2026-12-28T10:00:00Z');
  assert.equal(extractPromo(['Kód: NEWYEAR -10 % platí do 3. 1.'], 100, 'EUR', dec).valid_until, '2027-01-03');
});
