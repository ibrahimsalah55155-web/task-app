/**
 * Records the explainer: drives the demo page step by step, each step timed to
 * its voice-over line, then mixes the voice-over and encodes an MP4.
 *
 *   node record.cjs <demoDir> <voDir> <out.mp4>
 * Requires: demo server on :47950, engine on :47820 (see README in this folder).
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const [demoDir, voDir, outFile] = process.argv.slice(2);
const lines = JSON.parse(fs.readFileSync(path.join(__dirname, "vo.json"), "utf8"));
const durs = JSON.parse(fs.readFileSync(path.join(voDir, "durations.json"), "utf8"));
const text = Object.fromEntries(lines.map((l) => [l.id, l.text]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CARD = (n) => `.content > .card:nth-child(${n})`;

(async () => {
  const browser = await chromium.launch({ args: ["--no-proxy-server", "--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: path.join(demoDir, "rec"), size: { width: 1920, height: 1080 } },
  });
  const page = await context.newPage();
  const t0 = Date.now();
  const log = [];
  page.on("pageerror", (e) => console.error("pageerror", String(e)));
  await page.goto("http://127.0.0.1:47950/");
  await page.waitForSelector(".lang-btn");
  await sleep(1500);

  const demo = (fn, ...args) => page.evaluate(([f, a]) => window.demo[f](...a), [fn, args]);
  const scrollTo = (sel) => page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "start", behavior: "smooth" }), sel);
  const hl = (sel) => demo("highlight", sel);

  async function step(id, act) {
    const start = Date.now();
    log.push({ id, at: (start - t0) / 1000 });
    await demo("caption", text[id]);
    await act();
    const remain = durs[id] * 1000 + 700 - (Date.now() - start);
    if (remain > 0) await sleep(remain);
    await hl(null);
  }

  await step("intro", async () => {
    await sleep(1500);
    await hl(".right.pane");
  });
  await step("engine", async () => {
    await scrollTo(CARD(3));
    await sleep(600);
    await hl(CARD(3));
    await sleep(5000);
    await hl(".header-right");
  });
  await step("lang", async () => {
    await sleep(2500);
    await hl(".lang-btn");
    await sleep(800);
    await page.click(".lang-btn");
    await sleep(600);
    await hl(".app");
  });
  await step("project", async () => {
    await scrollTo(CARD(1));
    await sleep(800);
    await hl(CARD(1));
    await sleep(6000);
    await hl(".tracks");
    await sleep(2000);
    await hl(".timeline-pane");
  });
  await step("inspect", async () => {
    await scrollTo(CARD(4));
    await sleep(1200);
    await hl(`${CARD(4)} .btn-primary`);
    await sleep(1200);
    await page.click(`${CARD(4)} .btn-primary`);
    await sleep(2500);
    await hl(null);
    await page.evaluate(() => { const c = document.querySelector(".content"); c.scrollTo({ top: c.scrollTop + 420, behavior: "smooth" }); });
  });
  await step("cut1", async () => {
    await scrollTo(CARD(2));
    await sleep(1500);
    await demo("setPlayhead", 4);
    await demo("setInOut", 4, 6);
    await hl(".timeline-pane");
    await sleep(3500);
    await hl(`${CARD(2)} .btn-primary`);
  });
  await step("cut2", async () => {
    await page.click(`${CARD(2)} .btn-primary`);
    await sleep(2500);
    await hl(".timeline-pane");
    await sleep(6000);
    await hl(`${CARD(2)}`);
    await sleep(4000);
    await hl(".bins-pane");
  });
  await step("motion", async () => {
    await page.click(".nav-item >> nth=6");
    await sleep(1500);
    await hl(".tpl-grid");
  });
  await step("lt1", async () => {
    await page.click(".tpl >> nth=0");
    await scrollTo(CARD(2));
    await sleep(800);
    const f0 = page.locator(".field-input").nth(0);
    const f1 = page.locator(".field-input").nth(1);
    await f0.fill("");
    await f0.pressSequentially("د.هبة حريري", { delay: 70 });
    await f1.fill("");
    await f1.pressSequentially("أخصائية علاج نفسي وإرشاد تربوي", { delay: 45 });
    await sleep(1400);
    await hl(".preview");
    await demo("setPlayhead", 1);
    await sleep(1200);
    await hl(`${CARD(2)} .btn-primary`);
    await sleep(700);
    await page.click(`${CARD(2)} .btn-primary`);
  });
  await step("lt2", async () => {
    await sleep(2500);
    await hl(".timeline-pane");
    await sleep(3500);
    await hl(".monitor");
    await demo("setPlayhead", 1);
    await sleep(500);
    await demo("play");
    await sleep(6500);
    await demo("pause");
    await demo("setPlayhead", 4);
  });
  await step("title", async () => {
    await scrollTo(CARD(1));
    await page.click(".tpl >> nth=1");
    await sleep(1500);
    await scrollTo(CARD(2));
    await demo("setPlayhead", 3.5);
    await sleep(1500);
    await page.click(`${CARD(2)} .btn-primary`);
    await sleep(2500);
    await hl(".timeline-pane");
    await demo("setPlayhead", 3.5);
    await demo("play");
    await sleep(4300);
    await demo("pause");
  });
  await step("edit", async () => {
    await scrollTo(CARD(3));
    await sleep(800);
    await hl(".placed >> nth=0");
    await page.locator(".placed .btn").nth(0).click();
    await sleep(800);
    await scrollTo(CARD(2));
    const f1 = page.locator(".field-input").nth(1);
    await f1.fill("");
    await f1.pressSequentially("جزءًا من يومك", { delay: 80 });
    await sleep(900);
    await page.click(`${CARD(2)} .btn-primary`);
    await sleep(2500);
    await hl(".monitor");
    await demo("setPlayhead", 3.5);
    await demo("play");
    await sleep(3800);
    await demo("pause");
  });
  await step("logo", async () => {
    await page.click(".nav-item >> nth=8");
    await sleep(1000);
    await hl(CARD(2));
    await sleep(1500);
    await page.locator(`${CARD(2)} .btn`).nth(0).click();
    await sleep(1200);
    await page.click(".nav-item >> nth=6");
    await sleep(800);
    await hl(".tpl-grid");
  });
  await step("outro", async () => {
    await page.click(".nav-item >> nth=0");
    await sleep(600);
    await demo("setPlayhead", 0);
  });
  await demo("caption", "");
  await sleep(1500);
  const video = page.video();
  await context.close();
  await browser.close();
  const raw = await video.path();
  fs.writeFileSync(path.join(demoDir, "timeline.json"), JSON.stringify(log, null, 2));

  // ---- audio: place each line at its step start ----
  const inputs = [];
  const filters = [];
  log.forEach((s, i) => {
    inputs.push("-i", path.join(voDir, `${s.id}.wav`));
    filters.push(`[${i}]adelay=${Math.round(s.at * 1000)}|${Math.round(s.at * 1000)},aresample=48000[a${i}]`);
  });
  const mix = `${filters.join(";")};${log.map((_, i) => `[a${i}]`).join("")}amix=inputs=${log.length}:normalize=0,loudnorm=I=-16:TP=-1.5[out]`;
  const voWav = path.join(demoDir, "vo_mix.wav");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...inputs, "-filter_complex", mix, "-map", "[out]", "-ac", "2", voWav]);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", raw, "-i", voWav, "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "25",
    "-af", "apad", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", outFile]);
  console.log("done", outFile, JSON.stringify(log));
})();
