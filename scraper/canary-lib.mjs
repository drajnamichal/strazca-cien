// Čistá logika kanárika: vyhodnotenie výsledku, súhrn a text upozornenia.

const firstLine = (text) => String(text || '').split('\n')[0].slice(0, 200);

/** Overí, že scraper z obchodu stále vytiahne rozumnú cenu. */
export function evaluateCanary(entry, result, error = null) {
  const fail = (detail) => ({ name: entry.name, ok: false, detail: firstLine(detail) });
  if (error) return fail(error.message);
  if (!result?.ok) return fail(result?.error || 'Neznáma chyba.');
  if (result.price == null && result.in_stock === false) {
    return { name: entry.name, ok: true, detail: 'vypredané (parser funguje, cenu obchod neukazuje)' };
  }
  if (entry.currency && result.currency !== entry.currency) {
    return fail(`mena ${result.currency} namiesto ${entry.currency}`);
  }
  if (result.price < entry.min || result.price > entry.max) {
    return fail(`cena ${result.price} ${result.currency} je mimo očakávaného rozsahu ${entry.min}–${entry.max}`);
  }
  return { name: entry.name, ok: true, detail: `${result.price} ${result.currency}` };
}

/** Položku konfigurácie premení na produkt, aký dostáva scraper z Workera. */
export function canaryProduct(entry, id) {
  return {
    id,
    kind: entry.kind,
    market: entry.market || 'sk',
    input: entry.input,
    track_url: entry.kind === 'url' ? entry.input : null,
    selector: entry.selector || null,
    notify_elsewhere: 0, // kanárik testuje len samotný obchod
  };
}

const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);

export function summaryMarkdown(rows) {
  const failed = rows.filter((r) => !r.ok).length;
  const lines = [
    '## Kanárik: kontrola živých e-shopov',
    '',
    failed ? `**${failed} z ${rows.length} obchodov zlyhalo.**` : `Všetkých ${rows.length} obchodov funguje.`,
    '',
    '| | Obchod | Výsledok |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${String(r.detail).replace(/\|/g, '\\|')} |`),
  ];
  return lines.join('\n') + '\n';
}

export function alertText(rows) {
  const failed = rows.filter((r) => !r.ok);
  if (!failed.length) return null;
  return {
    title: `Kanárik: ${failed.length} ${plural(failed.length, 'obchod zlyhal', 'obchody zlyhali', 'obchodov zlyhalo')}`,
    body: failed.map((r) => `${r.name}: ${r.detail}`).join('; ').slice(0, 240),
  };
}
