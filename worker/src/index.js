// Strážca cien – Cloudflare Worker
// - REST API pre PWA (/api/*), chránené tajným kľúčom API_TOKEN
// - interné API pre scraper v GitHub Actions (/api/internal/*)
// - cron každých 5 h spustí GitHub workflow so scraperom

import { shouldNotify, priorLow30, discountInfo } from './pricing.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const nowIso = () => new Date().toISOString();
const FAILURE_ALERT_AFTER = 3; // po koľkých zlyhaniach za sebou upozorniť

function authorized(request, env) {
  const header = request.headers.get('authorization') || '';
  const expected = `Bearer ${env.API_TOKEN || ''}`;
  if (!env.API_TOKEN || header.length !== expected.length) return false;
  // porovnanie v konštantnom čase
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function parseHttpUrl(value) {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

async function dispatchCheck(env, productId) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return { ok: false, error: 'Chýba GITHUB_TOKEN alebo GITHUB_REPO vo Workeri.' };
  }
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/check-prices.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'strazca-cien-worker',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ref: env.GITHUB_REF || 'main',
        inputs: productId ? { product_id: String(productId) } : {},
      }),
    },
  );
  if (res.status === 204) return { ok: true };
  return { ok: false, error: `GitHub odmietol spustenie kontroly (HTTP ${res.status}).` };
}

function formatMoney(value, currency) {
  const locale = currency === 'CZK' ? 'cs-CZ' : 'sk-SK';
  return new Intl.NumberFormat(locale, { style: 'currency', currency: currency || 'EUR' }).format(value);
}

const PRODUCT_LIST_SQL = `
  SELECT p.*,
    (SELECT price FROM prices WHERE product_id = p.id ORDER BY checked_at DESC, id DESC LIMIT 1 OFFSET 1) AS prev_price,
    (SELECT MIN(price) FROM prices WHERE product_id = p.id) AS min_price,
    (SELECT MAX(price) FROM prices WHERE product_id = p.id) AS max_price
  FROM products p`;

// ---------- verejné API pre PWA ----------

async function listProducts(env) {
  const { results } = await env.DB.prepare(`${PRODUCT_LIST_SQL} ORDER BY p.created_at DESC`).all();
  const { results: allPrices } = await env.DB.prepare(
    'SELECT product_id, price, checked_at FROM prices ORDER BY product_id, checked_at, id',
  ).all();
  const historyOf = new Map();
  for (const row of allPrices) {
    if (!historyOf.has(row.product_id)) historyOf.set(row.product_id, []);
    historyOf.get(row.product_id).push(row);
  }
  const rate = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'eur_czk'`).first();

  const products = results.map((p) => {
    const history = historyOf.get(p.id) || [];
    const { priorLow, days } = priorLow30(history);
    return {
      ...p,
      recent_prices: history.slice(-12).map((h) => h.price),
      prior_low_30d: priorLow,
      history_days: days,
      discount: discountInfo({ current: p.current_price, listPrice: p.list_price, priorLow }),
    };
  });
  return json({ products, eurCzk: rate ? Number(rate.value) : null });
}

async function addProduct(request, env) {
  const body = await request.json().catch(() => ({}));
  const input = String(body.input || '').trim();
  const market = body.market === 'cz' ? 'cz' : 'sk';
  const selector = body.selector ? String(body.selector).trim().slice(0, 300) : null;
  if (!input) return json({ error: 'Zadaj URL alebo názov produktu.' }, 400);
  if (input.length > 2000) return json({ error: 'Vstup je príliš dlhý.' }, 400);

  const url = parseHttpUrl(input);
  if (!url) {
    return json({ error: 'Vlož odkaz na produkt z e-shopu (začína sa https://).' }, 400);
  }
  const kind = 'url';
  const row = await env.DB.prepare(
    `INSERT INTO products (input, kind, market, track_url, selector, name, shop, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING *`,
  )
    .bind(
      input,
      kind,
      market,
      url ? url.toString() : null,
      selector,
      url ? null : input,
      url ? url.hostname.replace(/^www\./, '') : null,
      nowIso(),
    )
    .first();

  const dispatch = await dispatchCheck(env, row.id);
  return json({ product: row, dispatch }, 201);
}

function readNumber(body, key, { min, max }) {
  const raw = body[key];
  if (raw === null || raw === '') return { value: null };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return { error: true };
  return { value: Math.round(value * 100) / 100 };
}

async function updateProduct(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const sets = [];
  const values = [];
  let recheck = false;

  if ('selector' in body) {
    sets.push('selector = ?', "status = 'pending'", 'last_error = NULL');
    values.push(body.selector ? String(body.selector).trim().slice(0, 300) : null);
    recheck = true;
  }
  if ('target_price' in body) {
    const r = readNumber(body, 'target_price', { min: 0.01, max: 1e9 });
    if (r.error) return json({ error: 'Cieľová cena musí byť kladné číslo.' }, 400);
    sets.push('target_price = ?');
    values.push(r.value);
  }
  if ('min_change_pct' in body) {
    const r = readNumber(body, 'min_change_pct', { min: 0, max: 100 });
    if (r.error) return json({ error: 'Prah zmeny musí byť medzi 0 a 100 %.' }, 400);
    sets.push('min_change_pct = ?');
    values.push(r.value || null);
  }
  for (const key of ['notify_increase', 'notify_stock']) {
    if (key in body) {
      sets.push(`${key} = ?`);
      values.push(body[key] ? 1 : 0);
    }
  }
  if (!sets.length) return json({ error: 'Nič na zmenu.' }, 400);

  const row = await env.DB.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
    .bind(...values, id)
    .first();
  if (!row) return json({ error: 'Produkt neexistuje.' }, 404);
  const dispatch = recheck ? await dispatchCheck(env, id) : null;
  return json({ product: row, dispatch });
}

async function deleteProduct(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM prices WHERE product_id = ?').bind(id),
    env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

async function productHistory(env, id) {
  const { results } = await env.DB.prepare(
    'SELECT price, currency, checked_at FROM prices WHERE product_id = ? ORDER BY checked_at ASC, id ASC',
  )
    .bind(id)
    .all();
  return json({ history: results });
}

async function saveSubscription(request, env) {
  const body = await request.json().catch(() => ({}));
  const sub = body.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return json({ error: 'Neplatné prihlásenie na notifikácie.' }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO subscriptions (endpoint, keys_json, created_at) VALUES (?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET keys_json = excluded.keys_json`,
  )
    .bind(sub.endpoint, JSON.stringify(sub.keys), nowIso())
    .run();
  return json({ ok: true });
}

// ---------- interné API pre scraper ----------

async function jobs(env, url) {
  const id = Number(url.searchParams.get('id')) || null;
  // Pri jednorazovej kontrole vezmeme daný produkt + všetky čakajúce
  // (GitHub drží len jeden čakajúci beh, takže sa nič nestratí).
  const stmt = id
    ? env.DB.prepare(`SELECT * FROM products WHERE id = ? OR status = 'pending'`).bind(id)
    : env.DB.prepare('SELECT * FROM products');
  const { results } = await stmt.all();
  return json({ products: results });
}

function priceChangeNotification(p, name, shop, oldPrice, price, currency, reason) {
  const down = price < oldPrice;
  const pct = ((price - oldPrice) / oldPrice) * 100;
  const label = reason === 'target' ? 'Cieľová cena dosiahnutá' : down ? '▼ Zlacnelo' : '▲ Zdražilo';
  return {
    title: `${label}: ${name}`.slice(0, 120),
    body:
      `${formatMoney(oldPrice, currency)} → ${formatMoney(price, currency)} (${pct > 0 ? '+' : ''}${pct.toFixed(1)} %)` +
      (reason === 'target' ? `, cieľ ${formatMoney(p.target_price, currency)}` : '') +
      (shop ? `, ${shop}` : ''),
    url: `/#p-${p.id}`,
    tag: `product-${p.id}`,
  };
}

async function saveResults(request, env) {
  const body = await request.json().catch(() => ({}));
  const results = Array.isArray(body.results) ? body.results : [];
  const checkedAt = nowIso();
  const notifications = [];
  const statements = [];

  for (const r of results) {
    const p = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(r.id).first();
    if (!p) continue;
    const stock = r.in_stock === true ? 1 : r.in_stock === false ? 0 : null;
    const hasPrice = r.price > 0;

    if (!r.ok || (!hasPrice && stock !== 0)) {
      const error = String(r.error || 'Cenu sa nepodarilo zistiť.').slice(0, 500);
      if (p.error_count + 1 === FAILURE_ALERT_AFTER) {
        notifications.push({
          title: `Sledovanie zlyháva: ${p.name || p.input}`.slice(0, 120),
          body: `${FAILURE_ALERT_AFTER}× po sebe: ${error}`.slice(0, 240),
          url: `/#p-${p.id}`,
          tag: `failing-${p.id}`,
        });
      }
      statements.push(
        env.DB.prepare(
          `UPDATE products SET status = 'error', last_error = ?, error_count = error_count + 1,
             last_checked = ?, track_url = COALESCE(?, track_url) WHERE id = ?`,
        ).bind(error, checkedAt, r.track_url || null, p.id),
      );
      continue;
    }

    const name = r.name || p.name || p.input;
    const shop = r.shop || p.shop;

    // vypredané a obchod cenu neukazuje: necháme poslednú známu cenu
    if (!hasPrice) {
      statements.push(
        env.DB.prepare(
          `UPDATE products SET in_stock = 0, status = 'ok', last_error = NULL, error_count = 0,
             name = COALESCE(?, name), last_checked = ? WHERE id = ?`,
        ).bind(r.name || null, checkedAt, p.id),
      );
      continue;
    }

    const price = Math.round(r.price * 100) / 100;
    const currency = r.currency || p.currency || (p.market === 'cz' ? 'CZK' : 'EUR');
    const sameCurrency = p.currency === currency;
    const changed = p.current_price == null || !sameCurrency || Math.abs(p.current_price - price) >= 0.005;
    const listPrice = r.list_price > price ? Math.round(r.list_price * 100) / 100 : null;
    let lastNotified = p.current_price == null || !sameCurrency ? price : p.last_notified_price;

    if (p.in_stock === 0 && stock === 1 && p.notify_stock) {
      notifications.push({
        title: `Znova skladom: ${name}`.slice(0, 120),
        body: `${formatMoney(price, currency)}${shop ? `, ${shop}` : ''}`,
        url: `/#p-${p.id}`,
        tag: `product-${p.id}`,
      });
      lastNotified = price;
    } else if (changed && sameCurrency) {
      const decision = shouldNotify(p, p.current_price, price);
      if (decision.notify) {
        notifications.push(priceChangeNotification(p, name, shop, p.current_price, price, currency, decision.reason));
        lastNotified = price;
      }
    }

    statements.push(
      env.DB.prepare(
        `UPDATE products SET current_price = ?, currency = ?, name = COALESCE(?, name),
           image = COALESCE(?, image), shop = COALESCE(?, shop), track_url = COALESCE(?, track_url),
           in_stock = COALESCE(?, in_stock), list_price = ?, last_notified_price = ?,
           ean = COALESCE(?, ean),
           status = 'ok', last_error = NULL, error_count = 0, last_checked = ? WHERE id = ?`,
      ).bind(
        price, currency, r.name || null, r.image || null, r.shop || null, r.track_url || null,
        stock, listPrice, lastNotified, r.ean || null, checkedAt, p.id,
      ),
    );
    if (changed) {
      statements.push(
        env.DB.prepare('INSERT INTO prices (product_id, price, currency, checked_at) VALUES (?, ?, ?, ?)').bind(
          p.id, price, currency, checkedAt,
        ),
      );
    }
  }

  if (body.rates?.CZK > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES ('eur_czk', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).bind(String(body.rates.CZK)),
    );
  }
  if (statements.length) await env.DB.batch(statements);

  const subscriptions = notifications.length ? await allSubscriptions(env) : [];
  return json({ notifications, subscriptions });
}

async function allSubscriptions(env) {
  const { results } = await env.DB.prepare('SELECT endpoint, keys_json FROM subscriptions').all();
  return results.map((s) => ({ endpoint: s.endpoint, keys: JSON.parse(s.keys_json) }));
}

async function internalAlert(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.title) return json({ error: 'Chýba nadpis upozornenia.' }, 400);
  const notification = {
    title: String(body.title).slice(0, 120),
    body: String(body.body || '').slice(0, 240),
    url: '/',
    tag: 'canary',
  };
  return json({ notifications: [notification], subscriptions: await allSubscriptions(env) });
}

async function removeSubscriptions(request, env) {
  const body = await request.json().catch(() => ({}));
  const endpoints = Array.isArray(body.endpoints) ? body.endpoints : [];
  if (endpoints.length) {
    await env.DB.batch(endpoints.map((e) => env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(e)));
  }
  return json({ ok: true, removed: endpoints.length });
}

// ---------- router ----------

async function handleApi(request, env, url) {
  if (!authorized(request, env)) return json({ error: 'Nesprávny prístupový kľúč.' }, 401);

  const path = url.pathname;
  const method = request.method;
  const productMatch = path.match(/^\/api\/products\/(\d+)(\/history)?$/);

  if (path === '/api/config' && method === 'GET') return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY || null });
  if (path === '/api/products' && method === 'GET') return listProducts(env);
  if (path === '/api/products' && method === 'POST') return addProduct(request, env);
  if (productMatch) {
    const id = Number(productMatch[1]);
    if (productMatch[2] && method === 'GET') return productHistory(env, id);
    if (!productMatch[2] && method === 'PATCH') return updateProduct(request, env, id);
    if (!productMatch[2] && method === 'DELETE') return deleteProduct(env, id);
  }
  if (path === '/api/check' && method === 'POST') {
    const result = await dispatchCheck(env);
    return json(result, result.ok ? 200 : 502);
  }
  if (path === '/api/subscriptions' && method === 'POST') return saveSubscription(request, env);

  if (path === '/api/internal/jobs' && method === 'GET') return jobs(env, url);
  if (path === '/api/internal/results' && method === 'POST') return saveResults(request, env);
  if (path === '/api/internal/subscriptions/remove' && method === 'POST') return removeSubscriptions(request, env);
  if (path === '/api/internal/alert' && method === 'POST') return internalAlert(request, env);

  return json({ error: 'Neznáma požiadavka.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: `Chyba servera: ${err.message}` }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatchCheck(env));
  },
};
