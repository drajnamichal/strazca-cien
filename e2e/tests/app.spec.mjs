import { test, expect, TOKEN } from './fixtures.mjs';

const row = (page, text) => page.getByRole('listitem').filter({ hasText: text });
const addField = (page) => page.getByLabel('URL alebo názov produktu');

test.describe('prvé spustenie', () => {
  test('nesprávny kľúč ukáže chybu, správny otvorí appku a zostane uložený', async ({ page, backend }) => {
    backend.seed({ name: 'Sony WH-1000XM5', prices: [349, 299.9] });
    await page.goto('/');

    await page.getByLabel('Prístupový kľúč').fill('zly');
    await page.getByRole('button', { name: 'Otvoriť appku' }).click();
    await expect(page.getByRole('alert')).toHaveText('Nesprávny prístupový kľúč.');

    await page.getByLabel('Prístupový kľúč').fill(TOKEN);
    await page.getByRole('button', { name: 'Otvoriť appku' }).click();
    await expect(row(page, 'Sony WH-1000XM5')).toBeVisible();

    await page.reload();
    await expect(row(page, 'Sony WH-1000XM5')).toBeVisible();
    await expect(page.getByLabel('Prístupový kľúč')).toBeHidden();
  });

  test('keď server kľúč prestane prijímať, appka vypýta nový', async ({ app: { page, backend } }) => {
    await page.goto('/');
    await expect(page.getByText('Zatiaľ nič nesleduješ.')).toBeVisible();
    backend.failNext = { status: 401, error: 'Nesprávny prístupový kľúč.' };
    await addField(page).fill('https://shop.test/x');
    await page.getByRole('button', { name: 'Sledovať' }).click();
    await expect(page.getByLabel('Prístupový kľúč')).toBeVisible();
  });
});

test.describe('pridávanie produktov', () => {
  test('prázdny zoznam vyzve na pridanie', async ({ app: { page } }) => {
    await page.goto('/');
    await expect(page.getByText('Zatiaľ nič nesleduješ.')).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveCount(0);
  });

  test('príklad z prázdneho stavu sa ťuknutím vloží do poľa', async ({ app: { page } }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'iPhone 16 128GB' }).click();
    await expect(addField(page)).toHaveValue('iPhone 16 128GB');
    await expect(addField(page)).toBeFocused();
  });

  test('odkaz na produkt sa pridá a čaká na zistenie ceny', async ({ app: { page, backend } }) => {
    await page.goto('/');
    await addField(page).fill('https://www.alza.sk/sluchadla-d123.htm');
    await expect(page.getByText('Appka bude sledovať cenu priamo na tejto stránke.')).toBeVisible();
    await page.getByRole('button', { name: 'Sledovať' }).click();

    await expect(row(page, 'www.alza.sk')).toContainText('Zisťujem cenu…');
    await expect(addField(page)).toHaveValue('');
    await expect(page.getByRole('status').filter({ hasText: 'Pridané' })).toBeVisible();
    expect(backend.calls('POST', '/api/products')[0].body).toEqual({
      input: 'https://www.alza.sk/sluchadla-d123.htm',
      market: 'sk',
    });
  });

  test('názov na CZ trhu sa pošle s trhom cz a cena sa doplní sama, keď ju scraper nájde', async ({
    app: { page, backend },
  }) => {
    await page.clock.install();
    await page.goto('/');
    await page.getByRole('radio', { name: 'CZ, Kč' }).check();
    await addField(page).fill('iPhone 15 128GB');
    await page.getByRole('button', { name: 'Sledovať' }).click();

    await expect(row(page, 'iPhone 15 128GB')).toContainText('Hľadám najnižšiu cenu…');
    expect(backend.calls('POST', '/api/products')[0].body.market).toBe('cz');

    const id = backend.products[0].id;
    backend.resolve(id, 16990, { name: 'Apple iPhone 15 128GB', shop: 'najnižšia cena na heureka.cz' });
    await page.clock.runFor(11_000);

    const item = row(page, 'Apple iPhone 15 128GB');
    await expect(item).toContainText(/16\s990\sKč/);
    await expect(item).not.toContainText('Hľadám');
  });

  test('chyba servera pri pridaní sa zobrazí a vstup zostane', async ({ app: { page, backend } }) => {
    await page.goto('/');
    backend.failNext = { status: 500, error: 'Chyba servera: D1 nedostupná' };
    await addField(page).fill('lego 42115');
    await page.getByRole('button', { name: 'Sledovať' }).click();
    await expect(page.getByRole('alert')).toHaveText('Chyba servera: D1 nedostupná');
    await expect(addField(page)).toHaveValue('lego 42115');
  });
});

test.describe('zoznam', () => {
  test('ukáže cenovku, pokles, zdraženie aj zlyhanú kontrolu', async ({ app: { page, backend } }) => {
    backend.seed({ name: 'Sony WH-1000XM5', shop: 'alza.sk', prices: [319, 279.9] });
    backend.seed({ name: 'Apple iPhone 15', market: 'cz', currency: 'CZK', prices: [16490, 16990] });
    backend.seed({ name: 'Kávovar X', status: 'error', last_error: 'Na stránke sa nenašla štruktúrovaná cena.' });
    await page.goto('/');

    const sony = row(page, 'Sony WH-1000XM5');
    await expect(sony).toContainText(/279,90\s€/);
    await expect(sony).toContainText(/▼ 39,10\s€/);
    await expect(sony).toContainText('alza.sk, kontrola pred 2 h');

    await expect(row(page, 'Apple iPhone 15')).toContainText(/▲ 500\sKč/);
    await expect(row(page, 'Kávovar X')).toContainText('Kontrola zlyhala, otvor detail');
  });

  test('hlavička zhrnie počet produktov a koľko zlacnelo', async ({ app: { page, backend } }) => {
    backend.seed({ name: 'A', prices: [10, 8] });
    backend.seed({ name: 'B', prices: [10, 12] });
    backend.seed({ name: 'C', prices: [5] });
    await page.goto('/');
    await expect(page.locator('#summary')).toHaveText('3 produkty, 1 zlacnel, kontrola pred 2 h');
  });

  test('produkt na najnižšej cene doteraz dostane štítok', async ({ app: { page, backend } }) => {
    backend.seed({ name: 'Na minime', prices: [120, 100, 90] });
    backend.seed({ name: 'Nad minimom', prices: [120, 90, 100] });
    await page.goto('/');
    await expect(row(page, 'Na minime')).toContainText('najnižšia doteraz');
    await expect(row(page, 'Nad minimom')).not.toContainText('najnižšia doteraz');
  });

  test('stránka sa nikdy neposúva do strany, ani s dlhými názvami', async ({ app: { page, backend } }) => {
    backend.seed({
      name: 'Veľmi dlhý názov produktu Samsung Galaxy S25 Ultra 512GB Titanium Silverblue s darčekom',
      shop: 'velmi-dlha-domena-obchodu-s-elektronikou.sk',
      prices: [1499, 1299.9],
    });
    await page.goto('/');
    await expect(page.getByRole('listitem')).toHaveCount(1);
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test('prepočet mien sa zapína v nastaveniach a pamätá si ho', async ({ app: { page, backend } }) => {
    backend.seed({ name: 'Sony WH-1000XM5', prices: [100] });
    await page.goto('/');
    await expect(row(page, 'Sony')).not.toContainText('≈');

    await page.getByRole('button', { name: 'Nastavenia' }).click();
    await page.getByLabel('Zobraziť aj prepočet na druhú menu podľa kurzu ECB').check();
    await page.getByRole('dialog').getByRole('button', { name: 'Zavrieť' }).click();
    await expect(row(page, 'Sony')).toContainText(/≈ 2\s430\sKč/);

    await page.reload();
    await expect(row(page, 'Sony')).toContainText(/≈ 2\s430\sKč/);
  });

  test('tlačidlo v nastaveniach spustí kontrolu všetkých cien', async ({ app: { page, backend } }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Nastavenia' }).click();
    await page.getByRole('button', { name: 'Skontrolovať všetky teraz' }).click();
    await expect(page.getByText('Kontrola beží, výsledky budú o pár minút.')).toBeVisible();
    expect(backend.calls('POST', '/api/check')).toHaveLength(1);
  });
});

test.describe('detail produktu', () => {
  test('ukáže cenu, štatistiky, graf a históriu zmien', async ({ app: { page, backend } }) => {
    backend.seed({ name: 'Sony WH-1000XM5', prices: [349, 329, 279.9] });
    await page.goto('/');
    await row(page, 'Sony').click();

    const detail = page.getByRole('dialog', { name: 'Sony WH-1000XM5' });
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('term').filter({ hasText: 'Najnižšia' }).locator('+ dd')).toHaveText(/279,90\s€/);
    await expect(detail.getByRole('term').filter({ hasText: 'Najvyššia' }).locator('+ dd')).toHaveText(/349,00\s€/);
    await expect(detail.getByRole('img', { name: /Vývoj ceny od 349,00\s€ po 279,90\s€/ })).toBeVisible();
    await expect(detail.locator('#history li')).toHaveCount(3);
    await expect(detail.locator('#history li').first()).toContainText(/279,90\s€/);
    await expect(detail.getByRole('link', { name: 'Otvoriť v obchode' })).toHaveAttribute('href', 'https://shop.test/produkt');

    await detail.getByRole('button', { name: 'Zavrieť' }).click();
    await expect(detail).toBeHidden();
  });

  test('odkaz z notifikácie (#p-ID) otvorí rovno detail produktu', async ({ app: { page, backend } }) => {
    const p = backend.seed({ name: 'Mixér Z', prices: [59.99] });
    await page.goto(`/#p-${p.id}`);
    await expect(page.getByRole('dialog', { name: 'Mixér Z' })).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('Graf sa zobrazí po prvej zmene ceny.');
  });

  test('pri zlyhanej kontrole ukáže dôvod a uloží vlastný CSS selektor', async ({ app: { page, backend } }) => {
    const p = backend.seed({ name: 'Kávovar X', status: 'error', last_error: 'Na stránke sa nenašla štruktúrovaná cena.' });
    await page.goto('/');
    await row(page, 'Kávovar X').click();

    const detail = page.getByRole('dialog', { name: 'Kávovar X' });
    await expect(detail).toContainText('Na stránke sa nenašla štruktúrovaná cena.');
    await detail.getByPlaceholder('napr. .price-box__price').fill('.cena');
    await detail.getByRole('button', { name: 'Uložiť a skontrolovať' }).click();

    await expect(detail).toBeHidden();
    expect(backend.calls('PATCH', `/api/products/${p.id}`)[0].body).toEqual({ selector: '.cena' });
    await expect(row(page, 'Kávovar X')).toContainText('Zisťujem cenu…');
  });

  test('pri produkte hľadanom podľa názvu nie je CSS selektor, odkaz vedie na ponuky', async ({ app: { page, backend } }) => {
    backend.seed({ name: 'Apple iPhone 15', kind: 'query', prices: [699], track_url: 'https://heureka.test/iphone' });
    await page.goto('/');
    await row(page, 'Apple iPhone 15').click();
    const detail = page.getByRole('dialog');
    await expect(detail.getByRole('link', { name: 'Otvoriť ponuky obchodov' })).toBeVisible();
    await expect(detail.getByText('Vlastný CSS selektor ceny')).toHaveCount(0);
  });

  test('prestať sledovať sa dá až po potvrdení', async ({ app: { page, backend } }) => {
    backend.seed({ name: 'Sony WH-1000XM5', prices: [299] });
    await page.goto('/');

    await row(page, 'Sony').click();
    page.once('dialog', (d) => d.dismiss());
    await page.getByRole('button', { name: 'Prestať sledovať' }).click();
    expect(backend.calls('DELETE', '/api/products/1')).toHaveLength(0);

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Prestať sledovať' }).click();
    await expect(page.getByText('Zatiaľ nič nesleduješ.')).toBeVisible();
    expect(backend.calls('DELETE', '/api/products/1')).toHaveLength(1);
  });
});
