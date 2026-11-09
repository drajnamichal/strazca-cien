// Kanárik: známe produkty, na ktorých sa raz denne overí, že scraper stále funguje.
// min/max je rozumný rozsah ceny – chytí parser, ktorý začne vracať nezmysly (napr. cenu dopravy).
// Daj sem jeden dlhodobo predávaný produkt z každého obchodu, ktorý sleduješ.
export default [
  {
    name: 'Alza.sk',
    input: 'https://www.alza.sk/maxi/nutrilon-3-advanced-batolacie-mlieko-800-g-d4821505.htm',
    kind: 'url',
    currency: 'EUR',
    min: 5,
    max: 60,
  },

  // Príklady – doplň skutočné odkazy na produkty a odkomentuj:
  // { name: 'Datart.sk', input: 'https://www.datart.sk/...', kind: 'url', currency: 'EUR', min: 50, max: 1000 },
  // { name: 'Nay.sk', input: 'https://www.nay.sk/...', kind: 'url', currency: 'EUR', min: 50, max: 1000 },
];
