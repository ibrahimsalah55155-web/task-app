
import puppeteer from '/tmp/pk/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
import fs from 'node:fs';
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:8765/test/harness.html';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(q, wait = 2600) {
  const p = await browser.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  p.on('pageerror', (e) => errors.push(q + ': ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(q + ': ' + m.text()); });
  await p.goto(BASE + '?' + q, { waitUntil: 'networkidle0' }); await sleep(wait); return p;
}
const snap = async (p, n) => { await sleep(600); await p.screenshot({ path: `${OUT}/${n}.png` }); };
let p = await open('', 300);
await snap(p, '00-splash-mid');
await sleep(1500); await snap(p, '01-login');
await p.close();
p = await open('as=user', 2400);       // should auto-focus task 3 and flash
await p.screenshot({ path: `${OUT}/02-user-focus.png` });
await sleep(400); await snap(p, '02b-user-focus');
await p.evaluate(() => document.querySelector('.tab[data-r="chat"]').click());
await snap(p, '03-chat');
await p.evaluate(() => document.querySelector('.composer .icon-btn.ghost').click());
await snap(p, '04-emoji');
await p.close();
p = await open('as=admin', 3200);
await snap(p, '05-admin-home');
await p.evaluate(() => window.__live('notifications', { eventType: 'INSERT', new: { id: 99, user_id: 'a1', kind: 'task_completed', title: 'تم إنجاز مهمة · عمر خالد', body: 'تجهيز عرض تقديمي لاجتماع العميل', task_id: 2, created_at: new Date().toISOString() } }));
await sleep(700); await p.screenshot({ path: `${OUT}/06-banner.png` });
await p.evaluate(() => document.querySelector('.tab[data-r="tasks"]').click());
await snap(p, '07-tasks-grouped');
await p.evaluate(() => window.scrollTo(0, 2200)); await snap(p, '08-tasks-month');
await p.evaluate(() => document.querySelector('.tab[data-r="reports"]').click());
await snap(p, '09-report');
await p.evaluate(() => document.querySelector('.rep-user').click());
await snap(p, '10-user-archive');
await p.close();
p = await open('as=admin', 3000);
await p.evaluate(() => document.querySelector('.bell').click());
await snap(p, '11-notifs');
await p.close();
await browser.close();
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no errors');
