import assert from "node:assert/strict";
import { test } from "node:test";
import { __allKeys, defaultLang, isRtl, pick, plain, setLang, t } from "../src/ui/i18n.ts";
import { STAGES } from "../src/ui/stages.ts";

test("every English key has an Arabic translation", () => {
  const { en, ar } = __allKeys();
  assert.deepEqual([...ar].sort(), [...en].sort());
});

test("interpolation and direction", () => {
  setLang("en");
  assert.equal(t("clips", { n: 3 }), "3 clip(s)");
  assert.equal(isRtl(), false);
  setLang("ar");
  assert.equal(plain(t("camGuest")), "كاميرا الضيف");
  assert.equal(plain(t("camHost")), "كاميرا المذيع");
  assert.equal(plain(t("camWide")), "كاميرا الوايد");
  assert.equal(plain(t("appName")), "مجموعة الملتيميديا والذكاء الاصطناعي");
  assert.equal(isRtl(), true);
  assert.ok(t("cutHelp").startsWith("\u202B"), "Arabic text carries a right-to-left embedding");
  setLang("en");
  assert.equal(plain(t("appName")), "Multimedia & AI Group");
});

test("Arabic is the default when Premiere runs in Arabic", () => {
  assert.equal(defaultLang("ar_AE"), "ar");
  assert.equal(defaultLang("en_US"), "en");
  assert.equal(defaultLang(undefined), "en");
});

test("every stage is written in both languages", () => {
  for (const s of STAGES) {
    for (const text of [s.title, s.short, s.goal, ...s.approach, ...s.limits]) {
      assert.ok(text.en.length > 0 && text.ar.length > 0, s.id);
      assert.match(text.ar, /[؀-ۿ]/, `${s.id}: Arabic text expected`);
    }
  }
  setLang("ar");
  assert.equal(plain(pick(STAGES[0]!.title)), "المزامنة وبناء التايم لاين");
  setLang("en");
});
