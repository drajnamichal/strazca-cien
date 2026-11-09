// Odoslanie Web Push notifikácií; mŕtve zariadenia (404/410) odhlási vo Workeri.
import webpush from 'web-push';

const FALLBACK_SUBJECT = 'mailto:admin@example.com';

/** web-push vyžaduje „mailto:…“ alebo https URL; holý e-mail doplní, nezmysel nahradí. */
export function vapidSubject(value) {
  const v = String(value ?? '').trim();
  if (/^mailto:\S+@\S+$/i.test(v) || /^https:\/\/\S+$/i.test(v)) return v;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
  if (v) console.warn('VAPID_SUBJECT nemá tvar mailto:e-mail ani https URL, použije sa predvolený.');
  return FALLBACK_SUBJECT;
}

export async function sendPushes(api, notifications, subscriptions, env = process.env) {
  if (!notifications.length || !subscriptions.length) return;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn('Chýbajú VAPID kľúče, notifikácie sa neodošlú.');
    return;
  }
  webpush.setVapidDetails(vapidSubject(env.VAPID_SUBJECT), env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const gone = new Set();
  for (const n of notifications) {
    for (const s of subscriptions) {
      try {
        await webpush.sendNotification(s, JSON.stringify(n), { TTL: 24 * 3600, urgency: 'high' });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) gone.add(s.endpoint);
        else console.warn('Push zlyhal:', err.statusCode, err.body);
      }
    }
  }
  if (gone.size) await api('/api/internal/subscriptions/remove', { method: 'POST', body: { endpoints: [...gone] } });
  console.log(`Odoslané notifikácie: ${notifications.length} × ${subscriptions.length} zariadení.`);
}
