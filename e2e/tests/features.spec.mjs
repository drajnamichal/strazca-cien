import { test, expect, TOKEN } from './fixtures.mjs';

const row = (page, text) => page.getByRole('listitem').filter({ hasText: text });

test.describe('pridanie cez zdieľanie', () => {
  test('zdieľaný odkaz z e-shopu sa hneď pridá a adresa sa vyčistí', async ({ app: { page, backend } }) => {
    await page.goto('/?title=Slúchadlá&text=Pozri%20toto&url=https%3A%2F%2Fwww.alza.sk%2Fsony-d123.htm');
    await expect(row(page, 'www.alza.sk')).toBeVisible();
    expect(backend.calls('POST', '/api/products')[0].body.input).toBe('https://www.alza.sk/sony-d123.htm');
    await expect(page.getByRole('status').filter({ hasText: 'Pridané zo zdieľania' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test('odkaz schovaný v zdieľanom texte sa nájde', async ({ app: { page, backend } }) => {
    await page.goto(`/?text=${encodeURIComponent('Mrkni sem https://www.datart.sk/kavovar-x.html, je v akcii')}`);
    await expect(row(page, 'www.datart.sk')).toBeVisible();
    expect(backend.calls('POST', '/api/products')[0].body.input).toBe('https://www.datart.sk/kavovar-x.html');
  });

  test('zdieľaný text bez odkazu sa hľadá ako názov produktu', async ({ app: { page, backend } }) => {
    await page.goto('/?text=Sony%20WH-1000XM5');
    await expect(row(page, 'Sony WH-1000XM5')).toContainText('Hľadám najnižšiu cenu…');
    expect(backend.calls('POST', '/api/products')[0].body).toEqual({ input: 'Sony WH-1000XM5', market: 'sk' });
  });

  test('zdieľanie pred prihlásením sa dokončí po zadaní kľúča', async ({ page, backend }) => {
    await page.goto('/?url=https%3A%2F%2Fwww.nay.sk%2Ftv');
    await page.getByLabel('Prístupový kľúč').fill(TOKEN);
    await page.getByRole('button', { name: 'Otvoriť appku' }).click();
    await expect(row(page, 'www.nay.sk')).toBeVisible();
    expect(backend.calls('POST', '/api/products')).toHaveLength(1);
  });

  test('keď server kľúč odmietne až pri pridávaní, zdieľaný odkaz sa po prihlásení nestratí', async ({
    app: { page, backend },
  }) => {
    backend.failOn = { method: 'POST', path: '/api/products', status: 401, error: 'Nesprávny prístupový kľúč.' };
    await page.goto('/?url=https%3A%2F%2Fwww.alza.sk%2Fx');
    await page.getByLabel('Prístupový kľúč').fill(TOKEN);
    await page.getByRole('button', { name: 'Otvoriť appku' }).click();
    await expect(row(page, 'www.alza.sk')).toBeVisible();
    expect(backend.calls('POST', '/api/products')).toHaveLength(2);
  });

  test('obnovenie stránky po zdieľaní produkt nepridá druhýkrát', async ({ app: { page, backend } }) => {
    await page.goto('/?url=https%3A%2F%2Fwww.alza.sk%2Fx');
    await expect(row(page, 'www.alza.sk')).toBeVisible();
    await page.reload();
    await expect(row(page, 'www.alza.sk')).toBeVisible();
    expect(backend.calls('POST', '/api/products')).toHaveLength(1);
  });
});

test.describe('cieľová cena a prah notifikácie', () => {
  test('nastavenia upozornení sa uložia a cieľ vidno v zozname', async ({ app: { page, backend } }) => {
    const p = backend.seed({ name: 'Sony WH-1000XM5', shop: 'alza.sk', prices: [299] });
    await page.goto('/');
    await row(page, 'Sony').click();
    const detail = page.getByRole('dialog');

    await detail.getByLabel('Cieľová cena (€)').fill('249,90');
    await detail.getByLabel('Len pri zmene aspoň o (%)').fill('5');
    await detail.getByLabel('Upozorniť aj na zdraženie').uncheck();
    await detail.getByRole('button', { name: 'Uložiť upozornenia' }).click();

    await expect(page.getByRole('status').filter({ hasText: 'Upozornenia uložené' })).toBeVisible();
    expect(backend.calls('PATCH', `/api/products/${p.id}`)[0].body).toEqual({
      target_price: 249.9,
      min_change_pct: 5,
      notify_increase: false,
      notify_stock: true,
      notify_elsewhere: true,
    });
    await detail.getByRole('button', { name: 'Zavrieť' }).click();
    await expect(row(page, 'Sony')).toContainText(/cieľ 249,90\s€/);
  });

  test('vymazaná cieľová cena sa pošle ako zrušená', async ({ app: { page, backend } }) => {
    const p = backend.seed({ name: 'Mixér', prices: [60], target_price: 50, min_change_pct: 10 });
    await page.goto('/');
    await row(page, 'Mixér').click();
    const detail = page.getByRole('dialog');
    await expect(detail.getByLabel('Cieľová cena (€)')).toHaveValue('50');
    await detail.getByLabel('Cieľová cena (€)').fill('');
    await detail.getByLabel('Len pri zmene aspoň o (%)').fill('');
    await detail.getByRole('button', { name: 'Uložiť upozornenia' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Upozornenia uložené' })).toBeVisible();
    const body = backend.calls('PATCH', `/api/products/${p.id}`)[0].body;
    expect(body.target_price).toBeNull();
    expect(body.min_change_pct).toBeNull();
  });

  test('cena pod cieľom dostane v zozname štítok', async ({ app: { page, backend } }) => {
    backend.seed({ name: 'Pod cieľom', prices: [300, 240], target_price: 250 });
    backend.seed({ name: 'Nad cieľom', prices: [300, 280], target_price: 250 });
    await page.goto('/');
    await expect(row(page, 'Pod cieľom')).toContainText('pod cieľovou cenou');
    await expect(row(page, 'Nad cieľom')).not.toContainText('pod cieľovou cenou');
  });

  test('pri produkte v Kč je cieľ v Kč', async ({ app: { page, backend } }) => {
    backend.seed({ name: 'iPhone', market: 'cz', currency: 'CZK', prices: [16990] });
    await page.goto('/');
    await row(page, 'iPhone').click();
    await expect(page.getByRole('dialog').getByLabel('Cieľová cena (Kč)')).toBeVisible();
  });
});

test.describe('falošné zľavy', () => {
  test('zľava od zdraženej ceny sa označí ako falošná a detail vysvetlí prečo', async ({ app: { page, backend } }) => {
    backend.seed({
      name: 'Robotický vysávač R9',
      prices: [200, 260, 230],
      list_price: 380,
      prior_low_30d: 200,
      history_days: 40,
      discount: { claimedPct: 39, realPct: -15, verdict: 'fake' },
    });
    await page.goto('/');
    await expect(row(page, 'Robotický')).toContainText('falošná zľava');

    await row(page, 'Robotický').click();
    const card = page.getByRole('region', { name: 'Falošná zľava' });
    await expect(card).toContainText(/Obchod uvádza zľavu 39 % z ceny 380,00\s€/);
    await expect(card).toContainText(/najlacnejšie za 200,00\s€/);
    await expect(card).toContainText('teraz je o 15 % drahší');
  });

  test('zavádzajúca zľava ukáže skutočné percento', async ({ app: { page, backend } }) => {
    backend.seed({
      name: 'Kávovar',
      prices: [300, 270],
      list_price: 400,
      prior_low_30d: 300,
      history_days: 35,
      discount: { claimedPct: 33, realPct: 10, verdict: 'misleading' },
    });
    await page.goto('/');
    await expect(row(page, 'Kávovar')).toContainText('zľava len 10 %');
    await row(page, 'Kávovar').click();
    await expect(page.getByRole('region', { name: 'Zľava je menšia, než sa tvári' })).toContainText(/len 10 %/);
  });

  test('skutočná zľava sa potvrdí a krátka história sa priznáva', async ({ app: { page, backend } }) => {
    backend.seed({
      name: 'Mixér',
      prices: [300, 240],
      list_price: 300,
      prior_low_30d: 300,
      history_days: 12,
      discount: { claimedPct: 20, realPct: 20, verdict: 'real' },
    });
    await page.goto('/');
    await expect(row(page, 'Mixér')).not.toContainText('falošná');
    await row(page, 'Mixér').click();
    const card = page.getByRole('region', { name: 'Zľava je skutočná' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Vyhodnotené z histórie za 12 dní.');
  });
});

test.describe('znova skladom', () => {
  test('vypredaný produkt je označený v zozname aj v detaile', async ({ app: { page, backend } }) => {
    backend.seed({ name: 'Herná konzola', prices: [499], in_stock: 0 });
    await page.goto('/');
    await expect(row(page, 'Herná konzola')).toContainText('vypredané');
    await row(page, 'Herná konzola').click();
    await expect(page.getByRole('dialog')).toContainText('Momentálne vypredané. Dám vedieť, keď bude znova skladom.');
  });

  test('upozornenie na sklad sa dá vypnúť', async ({ app: { page, backend } }) => {
    const p = backend.seed({ name: 'Herná konzola', prices: [499], in_stock: 0 });
    await page.goto('/');
    await row(page, 'Herná konzola').click();
    const detail = page.getByRole('dialog');
    await detail.getByLabel('Upozorniť, keď bude znova skladom').uncheck();
    await detail.getByRole('button', { name: 'Uložiť upozornenia' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Upozornenia uložené' })).toBeVisible();
    expect(backend.calls('PATCH', `/api/products/${p.id}`)[0].body.notify_stock).toBe(false);
  });
});

test.describe('lacnejšie v inom obchode', () => {
  const sony = {
    name: 'Sony WH-1000XM5',
    shop: 'alza.sk',
    prices: [299],
    ean: '5901234123457',
    best_offer_price: 279,
    best_offer_url: 'https://sluchadla.heureka.sk/sony-wh-1000xm5/',
  };

  test('zoznam aj detail ukážu, že inde je lacnejšie, s odkazom na ponuky', async ({ app: { page, backend } }) => {
    backend.seed(sony);
    await page.goto('/');
    await expect(row(page, 'Sony')).toContainText(/inde od 279,00\s€/);
    await row(page, 'Sony').click();
    const card = page.getByRole('region', { name: 'Inde lacnejšie' });
    await expect(card).toContainText(/Na Heureke od 279,00\s€, o 7 % lacnejšie než v alza\.sk/);
    await expect(card.getByRole('link', { name: 'Pozrieť ponuky' })).toHaveAttribute('href', sony.best_offer_url);
  });

  test('keď je ponuka inde rovnaká alebo drahšia, nič sa neukazuje', async ({ app: { page, backend } }) => {
    backend.seed({ ...sony, best_offer_price: 298 });
    await page.goto('/');
    await expect(row(page, 'Sony')).not.toContainText('inde od');
    await row(page, 'Sony').click();
    await expect(page.getByRole('region', { name: 'Inde lacnejšie' })).toHaveCount(0);
  });

  test('upozornenie na lacnejšiu ponuku sa dá vypnúť', async ({ app: { page, backend } }) => {
    const p = backend.seed(sony);
    await page.goto('/');
    await row(page, 'Sony').click();
    await page.getByRole('dialog').getByLabel('Upozorniť, keď bude inde lacnejšie').uncheck();
    await page.getByRole('dialog').getByRole('button', { name: 'Uložiť upozornenia' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Upozornenia uložené' })).toBeVisible();
    expect(backend.calls('PATCH', `/api/products/${p.id}`)[0].body.notify_elsewhere).toBe(false);
  });

  test('pri produkte z hľadania (už najlacnejší) sa porovnanie neponúka', async ({ app: { page, backend } }) => {
    const p = backend.seed({ name: 'iPhone 15', kind: 'query', prices: [699] });
    await page.goto('/');
    await row(page, 'iPhone').click();
    const detail = page.getByRole('dialog');
    await expect(detail.getByLabel('Upozorniť, keď bude inde lacnejšie')).toHaveCount(0);
    await detail.getByRole('button', { name: 'Uložiť upozornenia' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Upozornenia uložené' })).toBeVisible();
    expect('notify_elsewhere' in backend.calls('PATCH', `/api/products/${p.id}`)[0].body).toBe(false);
  });
});

test.describe('opakované zlyhanie', () => {
  test('detail ukáže, koľkokrát po sebe kontrola zlyhala', async ({ app: { page, backend } }) => {
    backend.seed({ name: 'Kávovar', prices: [99], status: 'error', error_count: 3, last_error: 'Obchod zablokoval automatickú kontrolu (HTTP 403).' });
    backend.seed({ name: 'Mixér', prices: [49], status: 'error', error_count: 1, last_error: 'Timeout' });
    await page.goto('/');
    await row(page, 'Kávovar').click();
    await expect(page.getByRole('dialog')).toContainText('Zlyhalo 3× po sebe.');
    await page.getByRole('dialog').getByRole('button', { name: 'Zavrieť' }).click();
    await row(page, 'Mixér').click();
    await expect(page.getByRole('dialog')).not.toContainText('po sebe');
  });
});
