// Kanárik: známe produkty, na ktorých sa raz denne overí, že scraper stále funguje.
// min/max je rozumný rozsah ceny – chytí parser, ktorý začne vracať nezmysly (napr. cenu dopravy).
// Daj sem jeden dlhodobo predávaný produkt z každého obchodu, ktorý sleduješ.
export default [
  { name: 'Heureka.sk (hľadanie)', input: 'Apple iPhone 15 128GB', kind: 'query', market: 'sk', currency: 'EUR', min: 300, max: 1500 },
  { name: 'Heureka.cz (hľadanie)', input: 'Apple iPhone 15 128GB', kind: 'query', market: 'cz', currency: 'CZK', min: 8000, max: 40000 },

  // Príklady – doplň skutočné odkazy na produkty a odkomentuj:
  // { name: 'Alza.sk', input: 'https://www.alza.sk/...', kind: 'url', currency: 'EUR', min: 50, max: 1000 },
  // { name: 'Datart.sk', input: 'https://www.datart.sk/...', kind: 'url', currency: 'EUR', min: 50, max: 1000 },
  // { name: 'Nay.sk', input: 'https://www.nay.sk/...', kind: 'url', currency: 'EUR', min: 50, max: 1000 },
  // { name: 'Alza.cz', input: 'https://www.alza.cz/...', kind: 'url', currency: 'CZK', min: 1000, max: 30000 },
];
