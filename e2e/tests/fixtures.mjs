// Falošný backend v pamäti, ktorý sa správa ako Worker API.
// Testy tak overujú PWA bez Cloudflare, GitHubu aj e-shopov.
import { test as base, expect } from '@playwright/test';

export const TOKEN = 'tajny-kluc';
const HOUR = 3600_000;

export class FakeBackend {
  products = [];
  history = new Map();
  requests = [];
  eurCzk = 24.3;
  failNext = null;
  failOn = null; // { method, path, status, error } – zlyhá len konkrétna požiadavka
  nextId = 1;

  /** Pridá produkt; ceny sú história od najstaršej po aktuálnu. */
  seed({ prices = [], ...fields }) {
    const id = this.nextId++;
    const now = Date.now();
    const currency = fields.currency || (fields.market === 'cz' ? 'CZK' : 'EUR');
    this.history.set(
      id,
      prices.map((price, i) => ({ price, currency, checked_at: new Date(now - (prices.length - i) * 24 * HOUR).toISOString() })),
    );
    const p = {
      id,
      input: fields.name || fields.input,
      kind: 'url',
      market: 'sk',
      track_url: 'https://shop.test/produkt',
      selector: null,
      target_price: null,
      min_change_pct: null,
      notify_increase: 1,
      notify_stock: 1,
      in_stock: null,
      list_price: null,
      ean: null,
      promo: null,
      notify_promo: 1,
      error_count: 0,
      shop: 'shop.test',
      currency,
      current_price: prices.at(-1) ?? null,
      status: prices.length ? 'ok' : 'pending',
      last_error: null,
      last_checked: prices.length ? new Date(now - 2 * HOUR).toISOString() : null,
      created_at: new Date(now - 30 * 24 * HOUR).toISOString(),
      ...fields,
    };
    this.products.unshift(p);
    return p;
  }

  /** Simuluje dokončenú kontrolu scrapera. */
  resolve(id, price, extra = {}) {
    const p = this.products.find((x) => x.id === id);
    Object.assign(p, { current_price: price, status: 'ok', last_checked: new Date().toISOString(), ...extra });
    this.history.get(id).push({ price, currency: p.currency, checked_at: new Date().toISOString() });
  }

  view(p) {
    const prices = this.history.get(p.id).map((h) => h.price);
    return {
      prev_price: prices.length > 1 ? prices.at(-2) : null,
      min_price: prices.length ? Math.min(...prices) : null,
      max_price: prices.length ? Math.max(...prices) : null,
      recent_prices: prices.slice(-12),
      prior_low_30d: null,
      history_days: prices.length,
      discount: { claimedPct: null, realPct: null, verdict: null },
      ...p,
    };
  }

  async handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    this.requests.push({ method: req.method(), path: url.pathname, body });
    const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

    if (req.headers().authorization !== `Bearer ${TOKEN}`) return reply({ error: 'Nesprávny prístupový kľúč.' }, 401);
    if (this.failOn && this.failOn.method === req.method() && this.failOn.path === url.pathname) {
      const err = this.failOn;
      this.failOn = null;
      return reply({ error: err.error }, err.status);
    }
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      return reply({ error: err.error }, err.status);
    }

    const m = url.pathname.match(/^\/api\/products\/(\d+)(\/history)?$/);
    const method = req.method();
    if (url.pathname === '/api/products' && method === 'GET') {
      return reply({ products: this.products.map((p) => this.view(p)), eurCzk: this.eurCzk });
    }
    if (url.pathname === '/api/products' && method === 'POST') {
      const isUrl = /^https?:\/\//.test(body.input.trim());
      const p = this.seed({
        input: body.input.trim(),
        name: isUrl ? null : body.input.trim(),
        kind: isUrl ? 'url' : 'query',
        market: body.market,
        shop: isUrl ? new URL(body.input).hostname : null,
        track_url: isUrl ? body.input : null,
        created_at: new Date().toISOString(),
      });
      return reply({ product: p, dispatch: { ok: true } }, 201);
    }
    if (m && m[2]) return reply({ history: this.history.get(Number(m[1])) || [] });
    if (m && method === 'PATCH') {
      const p = this.products.find((x) => x.id === Number(m[1]));
      const changes = { ...body };
      for (const k of ['notify_increase', 'notify_stock', 'notify_promo']) if (k in changes) changes[k] = changes[k] ? 1 : 0;
      if ('selector' in body) Object.assign(changes, { status: 'pending', last_error: null });
      Object.assign(p, changes);
      return reply({ product: p, dispatch: 'selector' in body ? { ok: true } : null });
    }
    if (m && method === 'DELETE') {
      this.products = this.products.filter((x) => x.id !== Number(m[1]));
      return reply({ ok: true });
    }
    if (url.pathname === '/api/check') return reply({ ok: true });
    if (url.pathname === '/api/config') return reply({ vapidPublicKey: null });
    return reply({ error: 'Neznáma požiadavka.' }, 404);
  }

  calls(method, path) {
    return this.requests.filter((r) => r.method === method && r.path === path);
  }
}

export const test = base.extend({
  backend: async ({ page }, use) => {
    const backend = new FakeBackend();
    await page.route('**/api/**', (route) => backend.handle(route));
    // externé fonty netreba, testy tak nezávisia od siete
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
    await use(backend);
  },
  /** Stránka s už uloženým prístupovým kľúčom. */
  app: async ({ page, backend }, use) => {
    await page.addInitScript((token) => {
      if (!sessionStorage.getItem('e2e-init')) {
        localStorage.setItem('sc_token', token);
        sessionStorage.setItem('e2e-init', '1');
      }
    }, TOKEN);
    await use({ page, backend });
  },
});

export { expect };
