// Čisté pravidlá okolo cien: kedy upozorniť a či je zľava skutočná.

const DAY = 86_400_000;
const EPS = 1e-9;

/**
 * Rozhodne, či zmena ceny stojí za notifikáciu.
 * - prvá cena nikdy,
 * - zdraženie len ak je zapnuté a nie je nastavená cieľová cena,
 * - cieľová cena: len pokles na cieľ alebo pod neho,
 * - prah v %: zmena oproti cene pri poslednej notifikácii (malé poklesy sa sčítajú).
 */
export function shouldNotify(product, oldPrice, newPrice) {
  if (oldPrice == null || newPrice == null || oldPrice <= 0) return { notify: false };
  const down = newPrice < oldPrice;
  if (!down && !product.notify_increase) return { notify: false };

  const hasTarget = product.target_price != null;
  if (hasTarget && (!down || newPrice > product.target_price + 0.005)) return { notify: false };

  if (product.min_change_pct > 0) {
    const base = product.last_notified_price ?? oldPrice;
    const changePct = (Math.abs(newPrice - base) / base) * 100;
    if (changePct + EPS < product.min_change_pct) return { notify: false };
  }
  return { notify: true, reason: hasTarget ? 'target' : 'change' };
}

/**
 * Najnižšia cena platná počas 30 dní pred začiatkom aktuálnej ceny
 * (porovnávací základ podľa smernice EÚ Omnibus).
 * history: záznamy o zmenách od najstaršej, posledný je aktuálna cena.
 */
export function priorLow30(history) {
  if (!history?.length) return { priorLow: null, days: 0 };
  const currentStart = Date.parse(history.at(-1).checked_at);
  const days = Math.round((currentStart - Date.parse(history[0].checked_at)) / DAY);
  const windowStart = currentStart - 30 * DAY;

  let priorLow = null;
  for (let i = 0; i < history.length - 1; i++) {
    const validUntil = Date.parse(history[i + 1].checked_at);
    if (validUntil > windowStart) {
      priorLow = priorLow == null ? history[i].price : Math.min(priorLow, history[i].price);
    }
  }
  return { priorLow, days };
}

const pct = (from, to) => Math.round(((from - to) / from) * 100);

/**
 * Porovná zľavu, ktorú tvrdí obchod (prečiarknutá cena), so skutočnou históriou.
 * verdict: 'real' | 'misleading' (o viac ako 5 bodov menšia) | 'fake' (žiadna zľava)
 *          | 'unknown' (chýba história) | null (obchod zľavu netvrdí)
 */
export function discountInfo({ current, listPrice, priorLow }) {
  const claimedPct = listPrice > current ? pct(listPrice, current) : null;
  const realPct = priorLow > 0 && current != null ? pct(priorLow, current) : null;

  let verdict = null;
  if (claimedPct != null) {
    if (realPct == null) verdict = 'unknown';
    else if (current >= priorLow - 0.005) verdict = 'fake';
    else if (realPct < claimedPct - 5) verdict = 'misleading';
    else verdict = 'real';
  }
  return { claimedPct, realPct, verdict };
}
