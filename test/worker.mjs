// Exercises the Worker's fetch/scheduled handlers (dashboard + API) offline.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

register('./html-loader.mjs', import.meta.url);
const worker = (await import('../src/index.js')).default;

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  first: async () => db.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => db.prepare(sql).run(...args),
});
const env = { DB: { prepare: (s) => stmt(s), batch: async (l) => Promise.all(l.map((s) => s.run())) }, DASHBOARD_PASSWORD: 'hunter2', JUPITER_API_KEY: 'k', JUP_RPS: '1000' };

globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (u.pathname.startsWith('/tokens/v2/')) return new Response('[]');
  if (u.pathname === '/price/v3') return new Response('{}');
  return new Response('nope', { status: 404 });
};

const call = (path, init = {}) => worker.fetch(new Request('https://bot.example' + path, init), env);

const page = await call('/');
assert.equal(page.status, 200);
assert.match(await page.text(), /<title>Alt Bot<\/title>/);

assert.equal((await call('/api/state')).status, 401);
assert.equal((await call('/api/state', { headers: { 'x-dash-key': 'wrong!!' } })).status, 401);

const auth = { 'x-dash-key': 'hunter2' };
let s = await (await call('/api/state', { headers: auth })).json();
assert.equal(s.mode, 'paper');
assert.equal(s.equity, 1000);
assert.equal(s.paused, false);

assert.deepEqual(await (await call('/api/pause', { method: 'POST', headers: auth })).json(), { ok: true });
s = await (await call('/api/state', { headers: auth })).json();
assert.equal(s.paused, true);

const run = await (await call('/api/run', { method: 'POST', headers: auth })).json();
assert.equal(run.mode, 'paper');
assert.equal(run.bought, 0);

let waited;
await worker.scheduled({}, env, { waitUntil: (p) => (waited = p) });
await waited;

// Fast loop: the cron kicks the Ticker, which keeps re-arming its own alarm.
const { FastMonitor: Ticker } = await import('../src/index.js');
let alarmAt = null;
const storage = { getAlarm: async () => alarmAt, setAlarm: async (t) => { alarmAt = t; } };
const ticker = new Ticker({ storage }, { ...env, TICK_SECONDS: '5' });
await ticker.fetch(new Request('https://ticker/kick'));
assert.ok(alarmAt && alarmAt <= Date.now() + 1000, 'kick arms the alarm right away');
const before = Date.now();
await ticker.alarm();
assert.ok(alarmAt >= before + 4900 && alarmAt <= Date.now() + 5100, 'next tick ~5s later');
const kicked = alarmAt;
await ticker.fetch(new Request('https://ticker/kick'));
assert.equal(alarmAt, kicked, 'kick leaves a healthy loop alone');
const tickerEnv = { ...env, FAST_MONITOR: { idFromName: () => 'id', get: () => ticker } };
alarmAt = null;
await worker.scheduled({}, tickerEnv, { waitUntil: (p) => (waited = p) });
await waited;
assert.ok(alarmAt, 'cron restarts a dead loop');

assert.deepEqual(await (await call('/api/reset-paper', { method: 'POST', headers: auth })).json(), { ok: true });
console.log('worker entry + fast loop: 13 checks passed');
