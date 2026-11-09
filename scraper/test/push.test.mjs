import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vapidSubject } from '../push.mjs';

test('VAPID subject: holý e-mail sa doplní na mailto:, platné tvary zostanú', () => {
  assert.equal(vapidSubject('michal@example.com'), 'mailto:michal@example.com');
  assert.equal(vapidSubject('  michal@example.com '), 'mailto:michal@example.com');
  assert.equal(vapidSubject('mailto:michal@example.com'), 'mailto:michal@example.com');
  assert.equal(vapidSubject('https://strazca-cien.drajna.workers.dev'), 'https://strazca-cien.drajna.workers.dev');
});

test('VAPID subject: chýbajúci alebo nezmyselný sa nahradí predvoleným', () => {
  assert.equal(vapidSubject(undefined), 'mailto:admin@example.com');
  assert.equal(vapidSubject(''), 'mailto:admin@example.com');
  assert.equal(vapidSubject('môj email'), 'mailto:admin@example.com');
});
