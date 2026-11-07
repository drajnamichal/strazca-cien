// Odoslanie Web Push notifikácií; mŕtve zariadenia (404/410) odhlási vo Workeri.
import webpush from 'web-push';

export async function sendPushes(api, notifications, subscriptions, env = process.env) {
  if (!notifications.length || !subscriptions.length) return;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    console.warn('Chýbajú VAPID kľúče, notifikácie sa neodošlú.');
    return;
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@example.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
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
