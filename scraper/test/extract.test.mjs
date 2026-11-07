import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, detectCurrency, extractFromJsonLd, extractPrice, pickCheapest, parseEcbCzk } from '../extract.mjs';

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

test('pickCheapest ignoruje príslušenstvo a nerelevantné výsledky', () => {
  const items = [
    { name: 'Apple iPhone 15 128GB', url: 'u1', price: 699 },
    { name: 'Apple iPhone 15 256GB', url: 'u2', price: 829 },
    { name: 'Kryt na iPhone 15', url: 'u3', price: 9.9 },
    { name: 'Samsung Galaxy S24', url: 'u4', price: 599 },
  ];
  assert.equal(pickCheapest('iphone 15', items).url, 'u1');
});

test('pickCheapest bez zhody vráti najlacnejší z top 5', () => {
  assert.equal(pickCheapest('neexistuje', [{ name: 'A', url: 'a', price: 5 }, { name: 'B', url: 'b', price: 3 }]).url, 'b');
  assert.equal(pickCheapest('x', []), null);
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
