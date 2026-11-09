// Strážca cien – PWA (bez build kroku)
const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  token: localStorage.getItem('sc_token') || '',
  products: [],
  eurCzk: null,
  convert: localStorage.getItem('sc_convert') === '1',
  vapidKey: null,
  pollTimer: null,
};

class AuthError extends Error {}

// ---------- pomocné ----------
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function money(value, currency = 'EUR') {
  if (value == null) return '–';
  const locale = currency === 'CZK' ? 'cs-CZ' : 'sk-SK';
  const whole = currency === 'CZK' && Number.isInteger(value);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(value);
}

function convertedText(value, currency) {
  if (!state.convert || !state.eurCzk || value == null) return '';
  return currency === 'CZK'
    ? `≈ ${money(value / state.eurCzk, 'EUR')}`
    : `≈ ${money(Math.round(value * state.eurCzk), 'CZK')}`;
}

function relTime(iso) {
  if (!iso) return 'zatiaľ nekontrolované';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'kontrola práve teraz';
  if (min < 60) return `kontrola pred ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `kontrola pred ${h} h`;
  return `kontrola pred ${Math.round(h / 24)} dňami`;
}

const dateFmt = new Intl.DateTimeFormat('sk-SK', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3500);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${state.token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(data.error || 'Nesprávny prístupový kľúč.');
  if (!res.ok) throw new Error(data.error || `Server vrátil chybu ${res.status}.`);
  return data;
}

// ---------- prvé spustenie ----------
function showSetup(message = '') {
  $('#app').hidden = true;
  $('#setup').hidden = false;
  $('#setup-error').textContent = message;
  $('#token').focus();
}

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.token = $('#token').value.trim();
  try {
    await loadProducts();
    localStorage.setItem('sc_token', state.token);
    $('#setup').hidden = true;
    $('#app').hidden = false;
    init();
    consumeShare(); // zdieľanie, ktoré čakalo na prihlásenie
  } catch (err) {
    $('#setup-error').textContent = err.message;
  }
});

// ---------- dáta ----------
async function loadProducts() {
  const data = await api('/api/products');
  state.products = data.products;
  state.eurCzk = data.eurCzk;
  $('#skeleton').hidden = true;
  renderList();
  renderSummary();
  schedulePolling();
}

function schedulePolling() {
  clearTimeout(state.pollTimer);
  if (state.products.some((p) => p.status === 'pending')) {
    state.pollTimer = setTimeout(() => loadProducts().catch(() => {}), 10_000);
  }
}

function plural(n, one, few, many) {
  return n === 1 ? one : n >= 2 && n <= 4 ? few : many;
}

function renderSummary() {
  const n = state.products.length;
  if (!n) return ($('#summary').textContent = 'Pridaj prvý produkt a ozvem sa, keď sa zmení cena.');
  const latest = state.products.map((p) => p.last_checked).filter(Boolean).sort().at(-1);
  const cheaper = state.products.filter((p) => p.prev_price != null && p.current_price < p.prev_price).length;
  const parts = [`${n} ${plural(n, 'produkt', 'produkty', 'produktov')}`];
  if (cheaper) parts.push(`${cheaper} ${plural(cheaper, 'zlacnel', 'zlacneli', 'zlacnelo')}`);
  if (latest) parts.push(relTime(latest));
  $('#summary').textContent = parts.join(', ');
}

// ---------- zoznam ----------
const currencyOf = (p) => p.currency || (p.market === 'cz' ? 'CZK' : 'EUR');

function stateLine(p) {
  if (p.status === 'pending') {
    return `<span class="item-state pending">${p.kind === 'query' ? 'Hľadám najnižšiu cenu…' : 'Zisťujem cenu…'}</span>`;
  }
  if (p.status === 'error') return `<span class="item-state error">Kontrola zlyhala, otvor detail</span>`;
  return '';
}

function deltaHtml(p) {
  if (p.prev_price == null || p.current_price == null) return '';
  const diff = p.current_price - p.prev_price;
  if (Math.abs(diff) < 0.005) return '';
  const down = diff < 0;
  return `<span class="delta ${down ? 'down' : 'up'}">${down ? '▼' : '▲'} ${money(Math.abs(diff), currencyOf(p))}</span>`;
}

function isBelowTarget(p) {
  return p.target_price != null && p.current_price != null && p.current_price <= p.target_price + 0.005;
}

/** Jeden najdôležitejší štítok k produktu, inak mini-graf. */
function badgeHtml(p) {
  if (p.in_stock === 0) return '<span class="badge out">vypredané</span>';
  if (p.promo) return `<span class="badge promo">s kódom ${esc(p.promo.code)}: ${money(p.promo.price, currencyOf(p))}</span>`;
  const d = p.discount || {};
  if (d.verdict === 'fake') return '<span class="badge warn">falošná zľava</span>';
  if (d.verdict === 'misleading') return `<span class="badge warn">zľava len ${Math.max(d.realPct, 0)} %</span>`;
  if (isBelowTarget(p)) return '<span class="lowest">pod cieľovou cenou</span>';
  if (isLowest(p)) return '<span class="lowest">najnižšia doteraz</span>';
  return sparkHtml(p);
}

function isLowest(p) {
  return p.current_price != null && p.max_price > p.min_price && Math.abs(p.current_price - p.min_price) < 0.005;
}

function thumbHtml(p) {
  const letter = esc((p.name || p.input || '?').trim().charAt(0).toUpperCase());
  return p.image
    ? `<img class="thumb" src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-letter="${letter}">`
    : `<span class="thumb" aria-hidden="true">${letter}</span>`;
}

function sparkHtml(p) {
  const v = (p.recent_prices || []).filter((x) => x > 0);
  if (v.length < 2) return '';
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * 72).toFixed(1)},${(18 - ((y - lo) / span) * 16).toFixed(1)}`);
  const trend = v.at(-1) < v[0] ? 'down' : v.at(-1) > v[0] ? 'up' : '';
  return `<svg class="spark ${trend}" viewBox="0 0 72 20" preserveAspectRatio="none" aria-hidden="true"><path d="M${pts.join(' L')}"/></svg>`;
}

function renderList() {
  const list = $('#list');
  $('#empty').hidden = state.products.length > 0;
  list.innerHTML = state.products
    .map((p) => {
      const cur = currencyOf(p);
      const conv = convertedText(p.current_price, cur);
      const pending = p.status === 'pending' && p.current_price == null;
      const label = p.name || p.input;
      return `<li class="row"><button class="item" type="button" data-id="${p.id}">
        ${thumbHtml(p)}
        <span class="item-name">${esc(p.name || p.input)}</span>
        <span class="item-main">
          <span class="item-meta">${esc(p.shop || '')}${p.shop ? ', ' : ''}${relTime(p.last_checked)}${p.target_price != null ? `, cieľ ${money(p.target_price, cur)}` : ''}</span>
          ${stateLine(p)}
          ${badgeHtml(p)}
        </span>
        <span class="item-right">
          <span class="tag ${p.current_price == null ? 'none' : ''} ${pending ? 'pending' : ''}" data-tag>${money(p.current_price, cur)}</span>
          ${deltaHtml(p)}
          ${conv ? `<span class="converted">${conv}</span>` : ''}
        </span>
      </button>
      <a class="heureka-link" href="${esc(heurekaSearchUrl(label, cur))}" target="_blank" rel="noopener"
         aria-label="Porovnať ceny na Heureke: ${esc(label)}">Heureka <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a>
    </li>`;
    })
    .join('');
}

// nenačítaný obrázok nahradí monogram
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('thumb')) return;
    const span = document.createElement('span');
    span.className = 'thumb';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = img.dataset.letter || '';
    img.replaceWith(span);
  },
  true,
);

$('#list').addEventListener('click', (e) => {
  const btn = e.target.closest('.item');
  if (btn) openDetail(Number(btn.dataset.id), btn.querySelector('[data-tag]'));
});

// ---------- pridanie ----------
const addInput = $('#add-input');
const ICON_SEARCH = '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>';
const ICON_LINK = '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>';

const isUrl = (text) => /^https?:\/\/\S+$/i.test(text.trim());

/** Odkaz na vyhľadávanie na Heureke – appka Heureku nečíta, len ju otvorí tebe. */
function heurekaSearchUrl(query, currency = 'EUR') {
  const host = currency === 'CZK' ? 'https://www.heureka.cz' : 'https://www.heureka.sk';
  return `${host}/?h%5Bfraze%5D=${encodeURIComponent(String(query).trim().slice(0, 120))}`;
}

function updateHint() {
  const text = addInput.value.trim();
  $('#field-icon').innerHTML = !text || isUrl(text) ? ICON_LINK : ICON_SEARCH;
  const hint = $('#add-hint');
  if (!text) hint.textContent = 'Vlož odkaz na produkt z e-shopu.';
  else if (isUrl(text)) hint.textContent = 'Appka bude sledovať cenu priamo na tejto stránke.';
  else {
    hint.innerHTML = `Appka sleduje produkty cez odkaz z e-shopu. <a href="${esc(heurekaSearchUrl(text))}" target="_blank" rel="noopener">Hľadať „${esc(text.slice(0, 60))}“ na Heureke</a> a potom vlož odkaz z obchodu.`;
  }
}
addInput.addEventListener('input', updateHint);

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  $('#add-error').textContent = '';
  if (!isUrl(addInput.value)) {
    $('#add-error').textContent = 'Vlož odkaz na produkt z e-shopu (začína sa https://).';
    return;
  }
  button.disabled = true;
  try {
    const { dispatch } = await api('/api/products', {
      method: 'POST',
      body: { input: addInput.value.trim() },
    });
    addInput.value = '';
    updateHint();
    toast(dispatch?.ok ? 'Pridané. Cena bude o minútu–dve.' : `Pridané. Cena sa zistí pri ďalšej kontrole. ${dispatch?.error || ''}`);
    await loadProducts();
  } catch (err) {
    if (err instanceof AuthError) return showSetup(err.message);
    $('#add-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

// sklo pod hlavičkou dostane linku, až keď sa obsah posunie pod ňu
addEventListener('scroll', () => $('#top').classList.toggle('scrolled', scrollY > 4), { passive: true });

// ---------- detail ----------
function chartSvg(history, currency) {
  if (history.length < 2) {
    return '<p class="muted">Graf sa zobrazí po prvej zmene ceny.</p>';
  }
  const W = 340, H = 170, padL = 6, padR = 10, padT = 22, padB = 30;
  const pts = history.map((h) => ({ t: new Date(h.checked_at).getTime(), v: h.price }));
  pts.push({ t: Date.now(), v: pts.at(-1).v }); // schodový graf končí dnes
  const t0 = pts[0].t, t1 = pts.at(-1).t || t0 + 1;
  const vals = pts.map((p) => p.v);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 0.01) { lo -= 1; hi += 1; }
  const x = (t) => padL + ((t - t0) / Math.max(t1 - t0, 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  let d = `M${x(pts[0].t)},${y(pts[0].v)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].t)} V${y(pts[i].v)}`;
  const area = `${d} V${H - padB} H${x(pts[0].t)} Z`;
  const last = pts.at(-1);
  const steps = pts.slice(1, -1).map((p) => `<circle class="step" cx="${x(p.t)}" cy="${y(p.v)}" r="3"/>`).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Vývoj ceny od ${money(history[0].price, currency)} po ${money(last.v, currency)}">
    <defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" class="fill-top"/><stop offset="1" class="fill-bottom"/></linearGradient></defs>
    <line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(hi)}" y2="${y(hi)}"/>
    <line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(lo)}" y2="${y(lo)}"/>
    <path d="${area}" fill="url(#chart-fill)"/>
    <path class="line" d="${d}"/>
    ${steps}
    <circle class="dot" cx="${x(last.t)}" cy="${y(last.v)}" r="5.5"/>
    <text x="${padL}" y="${H - 6}">${dateFmt.format(t0)}</text>
    <text x="${W - padR}" y="${H - 6}" text-anchor="end">dnes</text>
    <text x="${padL}" y="${y(hi) - 7}">${money(hi, currency)}</text>
    <text x="${padL}" y="${y(lo) - 7}">${money(lo, currency)}</text>
  </svg>`;
}

function discountHtml(p) {
  const d = p.discount || {};
  if (!d.verdict) return '';
  const cur = currencyOf(p);
  const list = money(p.list_price, cur);
  const prior = money(p.prior_low_30d, cur);
  const texts = {
    fake: [
      'Falošná zľava',
      `Obchod uvádza zľavu ${d.claimedPct} % z ceny ${list}. Za 30 dní pred touto cenou bol produkt najlacnejšie za ${prior}, ` +
        (d.realPct < 0 ? `takže teraz je o ${-d.realPct} % drahší.` : 'takže teraz nie je lacnejší.'),
    ],
    misleading: [
      'Zľava je menšia, než sa tvári',
      `Obchod uvádza zľavu ${d.claimedPct} %, ale oproti najnižšej cene za 30 dní (${prior}) je to len ${d.realPct} %.`,
    ],
    real: ['Zľava je skutočná', `Zľava ${d.claimedPct} % sedí s históriou: najnižšia cena za 30 dní bola ${prior}.`],
    unknown: ['Zľavu zatiaľ neviem overiť', `Obchod uvádza zľavu ${d.claimedPct} % z ceny ${list}, ale história cien je zatiaľ krátka.`],
  };
  const [title, text] = texts[d.verdict];
  const note = d.verdict !== 'unknown' && p.history_days < 30 ? `<p class="muted">Vyhodnotené z histórie za ${p.history_days} dní.</p>` : '';
  return `<section class="discount ${d.verdict}" aria-labelledby="discount-title">
      <h3 id="discount-title">${title}</h3>
      <p>${text}</p>${note}
    </section>`;
}

function promoHtml(p) {
  const promo = p.promo;
  if (!promo) return '';
  const cur = currencyOf(p);
  const [y, m, d] = (promo.valid_until || '').split('-').map(Number);
  const conditions = [
    promo.min_order ? `Pri nákupe od ${money(promo.min_order, cur)}.` : null,
    promo.valid_until ? `Platí do ${d}. ${m}. ${y}.` : null,
  ].filter(Boolean);
  return `<section class="promo" aria-labelledby="promo-title">
      <h3 id="promo-title">Zľavový kód</h3>
      <div class="promo-code">
        <code>${esc(promo.code)}</code>
        <button class="btn" type="button" data-copy="${esc(promo.code)}" aria-label="Kopírovať kód ${esc(promo.code)}">Kopírovať</button>
      </div>
      <p>S kódom v košíku ${money(promo.price, cur)} (−${promo.percent} %).</p>
      ${conditions.length ? `<p class="muted small">${conditions.join(' ')}</p>` : ''}
      <p class="muted small">Kód appka našla na stránke obchodu. Sledovaná cena zostáva bez kódu.</p>
    </section>`;
}

function alertsHtml(p) {
  const symbol = currencyOf(p) === 'CZK' ? 'Kč' : '€';
  const fmt = (v) => (v == null ? '' : String(v));
  return `<section class="alerts" aria-labelledby="alerts-title">
      <h3 id="alerts-title">Upozornenia</h3>
      <form id="alerts-form" class="stack" novalidate>
        <div class="alerts-grid">
          <label>Cieľová cena (${symbol})
            <input id="target" type="text" inputmode="decimal" autocomplete="off" value="${fmt(p.target_price)}" placeholder="žiadna">
          </label>
          <label>Len pri zmene aspoň o (%)
            <input id="min-change" type="text" inputmode="decimal" autocomplete="off" value="${fmt(p.min_change_pct)}" placeholder="každá zmena">
          </label>
        </div>
        <p class="muted small">S cieľovou cenou upozorním len na pokles na cieľ alebo pod neho.</p>
        <label class="check"><input id="notify-increase" type="checkbox" ${p.notify_increase !== 0 ? 'checked' : ''}><span>Upozorniť aj na zdraženie</span></label>
        <label class="check"><input id="notify-stock" type="checkbox" ${p.notify_stock !== 0 ? 'checked' : ''}><span>Upozorniť, keď bude znova skladom</span></label>
        <label class="check"><input id="notify-promo" type="checkbox" ${p.notify_promo !== 0 ? 'checked' : ''}><span>Upozorniť na nové zľavové kódy</span></label>
        <p id="alerts-error" class="error" role="alert"></p>
        <button class="btn primary" type="submit">Uložiť upozornenia</button>
      </form>
    </section>`;
}

function detailHtml(p) {
  const cur = currencyOf(p);
  const conv = convertedText(p.current_price, cur);
  const shortDate = new Date(p.created_at).toLocaleDateString('sk-SK', { day: 'numeric', month: 'numeric', year: '2-digit' });
  const linkIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
  return `
    <div class="sheet-head">
      <div class="detail-head">
        ${thumbHtml(p)}
        <div>
          <h2 id="detail-name">${esc(p.name || p.input)}</h2>
          <p class="detail-meta">${esc(p.shop || '')}${p.shop ? ', ' : ''}${relTime(p.last_checked)}</p>
        </div>
      </div>
      <button class="icon-btn" type="button" data-close aria-label="Zavrieť">✕</button>
    </div>
    <div class="detail-price">
      <span class="tag big ${p.current_price == null ? 'none' : ''}" style="view-transition-name: price-tag">${money(p.current_price, cur)}</span>
      ${deltaHtml(p)}
      ${isLowest(p) ? '<span class="lowest">najnižšia cena doteraz</span>' : ''}
      ${conv ? `<span class="converted">${conv}</span>` : ''}
    </div>
    ${p.status === 'error' ? `<p class="detail-error">${esc(p.last_error)}${p.error_count >= 2 ? ` Zlyhalo ${p.error_count}× po sebe.` : ''}</p>` : ''}
    ${p.status === 'pending' ? `<p class="muted">${p.kind === 'query' ? 'Hľadám najnižšiu cenu…' : 'Zisťujem cenu…'}</p>` : ''}
    ${p.in_stock === 0 ? `<p class="stock-note">Momentálne vypredané.${p.notify_stock !== 0 ? ' Dám vedieť, keď bude znova skladom.' : ''}</p>` : ''}
    ${promoHtml(p)}
    ${discountHtml(p)}
    <dl class="stats">
      <div><dt>Najnižšia</dt><dd>${money(p.min_price, cur)}</dd></div>
      <div><dt>Najvyššia</dt><dd>${money(p.max_price, cur)}</dd></div>
      <div><dt>Sledované od</dt><dd>${shortDate}</dd></div>
    </dl>
    <div id="chart"><p class="muted">Načítavam históriu…</p></div>
    <div class="links">
      ${p.track_url && p.kind === 'url' ? `<a class="link-btn" href="${esc(p.track_url)}" target="_blank" rel="noopener">Otvoriť v obchode ${linkIcon}</a>` : ''}
      <a class="link-btn" href="${esc(heurekaSearchUrl(p.name || p.input, cur))}" target="_blank" rel="noopener">Porovnať ceny na Heureke ${linkIcon}</a>
    </div>
    ${p.kind === 'url' ? `
    <details class="advanced" ${p.status === 'error' ? 'open' : ''}>
      <summary>Vlastný CSS selektor ceny</summary>
      <form id="selector-form" class="stack">
        <p class="muted" style="margin:0">Použi, ak appka na stránke nenájde cenu. V prehliadači klikni pravým na cenu, zvoľ Preskúmať a skopíruj selektor.</p>
        <label for="selector" class="visually-hidden">CSS selektor</label>
        <input id="selector" type="text" value="${esc(p.selector || '')}" placeholder="napr. .price-box__price">
        <button class="btn primary" type="submit">Uložiť a skontrolovať</button>
      </form>
    </details>` : ''}
    ${alertsHtml(p)}
    <ul id="history" class="history"></ul>
    <button id="delete" class="btn danger" type="button">Prestať sledovať</button>
  `;
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

async function openDetail(id, sourceTag = null) {
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  const dlg = $('#detail');
  const show = () => {
    if (sourceTag) sourceTag.style.viewTransitionName = '';
    dlg.innerHTML = detailHtml(p);
    dlg.showModal();
  };

  // cenovka zo zoznamu plynulo „preletí“ do detailu
  if (sourceTag && document.startViewTransition && !reduceMotion.matches) {
    sourceTag.style.viewTransitionName = 'price-tag';
    await document.startViewTransition(show).updateCallbackDone.catch(show);
  } else {
    show();
  }
  history.replaceState(null, '', `#p-${id}`);
  const cur = currencyOf(p);

  $('#delete', dlg).addEventListener('click', async () => {
    if (!confirm('Prestať sledovať tento produkt? História cien sa zmaže.')) return;
    try {
      await api(`/api/products/${id}`, { method: 'DELETE' });
      dlg.close();
      toast('Produkt odstránený.');
      loadProducts();
    } catch (err) {
      toast(err.message);
    }
  });
  $('[data-copy]', dlg)?.addEventListener('click', async (e) => {
    const code = e.currentTarget.dataset.copy;
    try {
      await navigator.clipboard.writeText(code);
      toast(`Kód ${code} skopírovaný.`);
    } catch {
      toast(`Kód: ${code}`);
    }
  });
  $('#alerts-form', dlg).addEventListener('submit', async (e) => {
    e.preventDefault();
    const num = (sel) => {
      const raw = $(sel, dlg).value.trim().replace(/\s/g, '').replace(',', '.');
      return raw === '' ? null : Number(raw);
    };
    const body = {
      target_price: num('#target'),
      min_change_pct: num('#min-change'),
      notify_increase: $('#notify-increase', dlg).checked,
      notify_stock: $('#notify-stock', dlg).checked,
      notify_promo: $('#notify-promo', dlg).checked,
    };
    if (Number.isNaN(body.target_price) || Number.isNaN(body.min_change_pct)) {
      $('#alerts-error', dlg).textContent = 'Zadaj číslo, napríklad 249,90.';
      return;
    }
    try {
      const { product: saved } = await api(`/api/products/${id}`, { method: 'PATCH', body });
      Object.assign(p, saved);
      $('#alerts-error', dlg).textContent = '';
      toast('Upozornenia uložené.');
      renderList();
    } catch (err) {
      $('#alerts-error', dlg).textContent = err.message;
    }
  });
  $('#selector-form', dlg)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/products/${id}`, { method: 'PATCH', body: { selector: $('#selector', dlg).value } });
      dlg.close();
      toast('Uložené. Cena sa skontroluje o minútu–dve.');
      loadProducts();
    } catch (err) {
      toast(err.message);
    }
  });

  try {
    const { history: rows } = await api(`/api/products/${id}/history`);
    $('#chart', dlg).innerHTML = chartSvg(rows, cur);
    $('#history', dlg).innerHTML = rows
      .slice(-12)
      .reverse()
      .map((h) => `<li><span>${dateFmt.format(new Date(h.checked_at))}</span><span>${money(h.price, h.currency)}</span></li>`)
      .join('');
  } catch (err) {
    $('#chart', dlg).innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// zatváranie dialógov: tlačidlo ✕ aj klik mimo panela
for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === dlg) dlg.close();
  });
  dlg.addEventListener('close', () => {
    if (location.hash) history.replaceState(null, '', location.pathname);
  });
}

// ---------- nastavenia ----------
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function refreshPushState() {
  const stateEl = $('#push-state');
  const btn = $('#push-btn');
  btn.hidden = false;
  if (isIos && !isStandalone) {
    stateEl.textContent = 'Na iPhone fungujú notifikácie len z appky na ploche. V Safari ťukni na Zdieľať, potom Pridať na plochu, a otvor appku odtiaľ.';
    btn.hidden = true;
    return;
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    stateEl.textContent = 'Tento prehliadač notifikácie nepodporuje.';
    btn.hidden = true;
    return;
  }
  if (Notification.permission === 'denied') {
    stateEl.textContent = 'Notifikácie sú zablokované. Povoľ ich v nastaveniach prehliadača pre túto stránku.';
    btn.hidden = true;
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  stateEl.textContent = sub ? 'Zapnuté na tomto zariadení.' : 'Vypnuté na tomto zariadení.';
  btn.textContent = sub ? 'Poslať prihlásenie znova' : 'Zapnúť notifikácie';
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

$('#push-btn').addEventListener('click', async () => {
  try {
    if (!state.vapidKey) state.vapidKey = (await api('/api/config')).vapidPublicKey;
    if (!state.vapidKey) throw new Error('Vo Workeri chýba VAPID_PUBLIC_KEY.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notifikácie neboli povolené.');
    const reg = await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(state.vapidKey) }));
    await api('/api/subscriptions', { method: 'POST', body: { subscription: sub.toJSON() } });
    toast('Notifikácie zapnuté.');
  } catch (err) {
    toast(err.message);
  }
  refreshPushState();
});

$('#open-settings').addEventListener('click', () => {
  $('#convert').checked = state.convert;
  $('#check-msg').textContent = '';
  $('#settings').showModal();
  refreshPushState();
});

$('#convert').addEventListener('change', (e) => {
  state.convert = e.target.checked;
  localStorage.setItem('sc_convert', state.convert ? '1' : '0');
  renderList();
  if (state.convert && !state.eurCzk) toast('Kurz sa načíta pri najbližšej kontrole cien.');
});

$('#check-now').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    await api('/api/check', { method: 'POST' });
    $('#check-msg').textContent = 'Kontrola beží, výsledky budú o pár minút.';
  } catch (err) {
    $('#check-msg').textContent = err.message;
  } finally {
    e.target.disabled = false;
  }
});

$('#logout').addEventListener('click', () => {
  localStorage.removeItem('sc_token');
  state.token = '';
  $('#settings').close();
  showSetup();
});

// ---------- zdieľanie do appky (Web Share Target, iOS Skratky) ----------
function readShare() {
  const params = new URLSearchParams(location.search);
  const parts = ['url', 'text', 'title'].map((k) => params.get(k)).filter(Boolean);
  if (!parts.length) return null;
  const url = parts.join(' ').match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.;!?]+$/, '');
  const text = (params.get('text') || params.get('title') || '').trim();
  return (url || text).slice(0, 2000) || null;
}

const sharedInput = readShare();
if (sharedInput) {
  sessionStorage.setItem('sc_share', sharedInput);
  history.replaceState(null, '', location.pathname);
}

async function consumeShare() {
  const input = sessionStorage.getItem('sc_share');
  if (!input) return;
  sessionStorage.removeItem('sc_share');
  if (!isUrl(input)) {
    addInput.value = input;
    updateHint();
    $('#add-error').textContent = 'Zdieľaný text neobsahuje odkaz na produkt. Nájdi ho na Heureke a pridaj odkaz z obchodu.';
    return;
  }
  try {
    await api('/api/products', { method: 'POST', body: { input } });
    toast('Pridané zo zdieľania. Cena bude o minútu–dve.');
    await loadProducts();
  } catch (err) {
    if (err instanceof AuthError) {
      sessionStorage.setItem('sc_share', input);
      return showSetup(err.message);
    }
    addInput.value = input;
    updateHint();
    $('#add-error').textContent = err.message;
  }
}

// ---------- štart ----------
let initialized = false;
function init() {
  if (initialized) return;
  initialized = true;
  consumeShare();
  const m = location.hash.match(/^#p-(\d+)$/);
  if (m) openDetail(Number(m[1]));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadProducts().catch(() => {});
  });
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'open-product') openDetail(Number(e.data.id));
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

(async () => {
  if (!state.token) return showSetup();
  $('#app').hidden = false;
  try {
    await loadProducts();
    init();
  } catch (err) {
    if (err instanceof AuthError) showSetup(err.message);
    else toast(err.message);
  }
})();
