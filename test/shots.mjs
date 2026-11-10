// Screenshot + click-through test against the in-memory harness.
import puppeteer from '/tmp/pk/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
import fs from 'node:fs';

const OUT = process.argv[2] || '/tmp/shots';
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:8765/test/harness.html';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--font-render-hinting=none'] });
const errors = [];

async function open(query, { dark = false, w = 390, hgt = 844 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: hgt, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
  page.on('pageerror', (e) => errors.push(`${query}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${query}: console ${m.text()}`); });
  await page.goto(`${BASE}?${query}`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1700));
  return page;
}
const snap = async (page, name) => { await new Promise((r) => setTimeout(r, 700)); await page.screenshot({ path: `${OUT}/${name}.png` }); };
const tap = async (page, sel) => { await page.waitForSelector(sel, { timeout: 4000 }); await page.click(sel); };

// 1 login
let p = await open('');
await snap(p, '01-login');
await p.type('#login-user', 'admin'); await p.type('#login-pass', 'wrong');
await p.click('button[type=submit]');
await snap(p, '02-login-error');
await p.close();

// 2 admin home, light + dark
p = await open('as=admin');
await snap(p, '03-admin-home');
await p.evaluate(() => window.scrollTo(0, 600));
await snap(p, '04-admin-home-scrolled');
await p.close();
p = await open('as=admin', { dark: true });
await snap(p, '05-admin-home-dark');
await p.close();

// 3 tasks: cards, complete one, table
p = await open('as=admin');
await tap(p, '.tab[data-r="tasks"]');
await snap(p, '06-tasks-cards');
await p.evaluate(() => document.querySelectorAll('.task:not(.done) .check')[0].click());
await new Promise((r) => setTimeout(r, 300));
await snap(p, '07-task-checked');
await tap(p, '.vt:nth-child(2)');
await snap(p, '08-tasks-table');
await tap(p, '.vt:nth-child(1)');
await tap(p, '.task .icon-btn');
await snap(p, '09-task-menu');
await tap(p, '.action-row');
await snap(p, '10-task-edit');
await p.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 400));
await tap(p, '.bar-actions .icon-btn.accent');
await snap(p, '11-new-task');
await p.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 400));
await p.evaluate(() => document.querySelector('.folder-add').click());
await snap(p, '11b-folder');
await p.close();

// 4 users
p = await open('as=admin');
await tap(p, '.tab[data-r="users"]');
await snap(p, '12-users');
await tap(p, '.bar-actions .icon-btn.accent');
await p.type('#nu-name', 'ليلى حسن'); await p.type('#nu-user', 'laila');
await snap(p, '13-new-user');
await p.evaluate(() => document.querySelector('.sheet-foot .btn').click());
await new Promise((r) => setTimeout(r, 900));
await snap(p, '14-invite');
await p.close();
p = await open('as=admin', { dark: true });
await tap(p, '.tab[data-r="users"]');
await new Promise((r) => setTimeout(r, 500));
await p.evaluate(() => document.querySelectorAll('.card.user')[1].click());
await snap(p, '15-edit-user-dark');
await tap(p, '.row-btn.danger');
await snap(p, '16-confirm-delete-dark');
await p.close();

// 5 activity, profile, user role, forced password, empty, loading
p = await open('as=admin');
await tap(p, '.tab[data-r="activity"]');
await snap(p, '17-activity');
await tap(p, '.avatar-btn');
await snap(p, '18-profile');
await p.close();
p = await open('as=user');
await snap(p, '19-user-tasks');
await p.close();
p = await open('as=admin&mustchange=1');
await snap(p, '20-forced-password');
await p.close();
p = await open('as=admin&empty=1');
await tap(p, '.tab[data-r="tasks"]');
await snap(p, '21-empty');
await p.close();
p = await open('as=user&slow=1');
await snap(p, '22-loading');
await p.close();
p = await open('as=admin', { w: 340, hgt: 720 });
await tap(p, '.tab[data-r="tasks"]');
await snap(p, '23-small-screen');
const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
if (overflow) errors.push('horizontal overflow at 340px');
await p.close();

await browser.close();
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no errors');
