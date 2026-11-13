/**
 * Arabic / English interface text. The language button in the header switches
 * between them; Arabic also switches the layout to right-to-left.
 * Log lines and diagnostics stay in English so support can read them.
 */

import { finishAr, finishEn } from "./i18n_finish.ts";
import { phasesAr, phasesEn } from "./i18n_phases.ts";

export type Lang = "ar" | "en";

const en = {
  ...phasesEn,
  ...finishEn,
  appName: "Multimedia & AI Group",
  appSub: "Podcast Studio",
  langButton: "عربي",
  langButtonTitle: "Switch the interface to Arabic",

  navDashboard: "Dashboard",
  navSettings: "Settings",

  camGuest: "Guest Camera",
  camHost: "Host Camera",
  camWide: "Wide Camera",
  micGuest: "Guest Mic",
  micHost: "Host Mic",

  premiere: "Premiere",
  version: "Version",
  uxp: "UXP",
  system: "System",
  apis: "{ok}/{all} APIs",
  apiAvailability: "API availability",
  oldPremiere: "Premiere {min} or newer is recommended. Older builds miss features some stages need.",
  hostUnknown: "Host information unavailable.",
  yes: "yes",
  no: "no",
  missing: "missing",

  project: "Project",
  file: "File",
  sequences: "Sequences",
  noProject: "Open a project in Premiere.",
  noSequence: "No active sequence. Open one in the Timeline.",
  frame: "Frame",
  frameRate: "Frame rate",
  duration: "Duration",
  playhead: "Playhead",
  captions: "Captions",
  captionTracks: "{n} track(s)",
  clips: "{n} clip(s)",
  mediaFiles: "Media files",
  noFileItems: "(+{n} items without a file)",
  refresh: "Refresh",
  reading: "Reading…",
  createBins: "Create project bins",
  addMarker: "Add test marker",
  addMarkerTitle: "Adds a comment marker at the playhead (undoable) to check timeline edits",
  connected: "connected",
  none: "none",
  error: "error",

  engine: "Engine",
  engineBuiltIn: "Built into the plugin. Starts by itself and stops with Premiere.",
  engineStarting: "Starting the engine…",
  engineRunning: "running",
  engineStartingPill: "starting",
  engineStopped: "stopped",
  engineOffline: "Not reachable.",
  engineExternalHelp: "Development mode: start the engine yourself, then press Retry.",
  restartEngine: "Restart engine",
  retry: "Retry",
  pairPrompt: "Enter the pairing code shown in the engine window.",
  pair: "Pair",
  pairing: "Pairing…",
  machine: "Machine",
  gpu: "GPU",
  gpuNone: "none detected (CPU mode)",
  aiPackages: "AI packages (needed from the next phases)",
  ffprobe: "FFprobe",
  found: "found",

  inspectTitle: "Media inspection",
  inspectHelp: "Reads every file used in the active sequence: frame rate, timecode, audio, and sync risks.",
  inspect: "Inspect sequence media",
  cancel: "Cancel",
  needEngine: "Waiting for the engine",
  needSequence: "Open a sequence first",
  okCount: "{ok}/{all} ok",
  check: "check",

  cutTitle: "Cut engine test",
  cutHelp: "Mark In and Out on the timeline, then press the button. A new sequence is built with that range removed from every camera and microphone at once. The original sequence is not touched.",
  cutRun: "Remove In→Out into a new sequence",
  cutNeedInOut: "Set In and Out points on the timeline first.",
  cutNeed263: "Needs Premiere 26.3 or newer (subclip API).",
  cutStep_read: "Reading the timeline",
  cutStep_subclips: "Preparing segments",
  cutStep_clone: "Copying the sequence",
  cutStep_place: "Placing the cuts",
  cutStep_verify: "Verifying every cut",
  cutStep_done: "Done",
  cutResultOk: "Done: “{name}”. All {n} pieces verified frame-exact. Removed {removed}.",
  cutResultBad: "“{name}” was built but {bad} of {n} pieces differ from the plan. First: {first}",
  cutFailed: "The cut test failed: {msg}",

  stageNotBuilt: "Phase {n} · not built yet",
  stageHow: "How it will work",
  stageLimits: "Premiere limits found in the audit",
  stageNeeds: "Engine requirements",
  stageNoButtons: "This stage gets its buttons once it works in Premiere.",

  settingsEngine: "Engine",
  address: "Address",
  forgetPairing: "Forget pairing",
  clearCache: "Clear analysis cache",
  showEngineLog: "Show engine log",
  panel: "Panel",
  logLevel: "Log level",
  language: "Language",
  copyDiagnostics: "Copy diagnostics",

  binsCreated: "Created {n} bin(s). Undo with Ctrl+Z.",
  binsExist: "The project bins already exist. Nothing changed.",
  markerAdded: "Marker added at the playhead. Undo with Ctrl+Z.",
  noProjectOpen: "No project is open.",
  failed: "{what} failed: {msg}",
  paired: "Paired with the engine.",
  diagCopied: "Diagnostics copied to the clipboard.",
  diagConsole: "Clipboard unavailable. Diagnostics were written to the UXP console.",
  cacheCleared: "Removed {n} cached result(s).",
  logShown: "Last {n} engine log lines written to the UXP console.",
  noMediaToInspect: "The active sequence has no media files to inspect.",
  motionTitle: "Motion Library",
  motionHelp: "Pick a graphic, write the text, press Insert. It is placed at the playhead on a free track above your cameras; nothing is overwritten.",
  motionLoading: "Loading templates…",
  motionNeedEngine: "The engine must be running to make graphics.",
  motionNeedSequence: "Open a sequence: graphics are made at its size and frame rate.",
  duration_s: "Duration (s)",
  preview: "Preview",
  insertAtPlayhead: "Insert at playhead",
  updateGraphic: "Update text in place",
  cancelEdit: "Cancel edit",
  rendering: "Rendering the graphic…",
  inserted: "Inserted on V{track} at {tc}.",
  updated: "Graphic updated everywhere it is used.",
  placedTitle: "Inserted this session",
  edit: "Edit",
  logo: "Logo / icon",
  chooseLogo: "Choose image…",
  clearLogo: "Use default icon",
  accentColor: "Accent colour",
  logoHint: "PNG with transparency works best. It replaces the round icon in every graphic.",
  defaultIcon: "default icon",
  editableNote: "Text is edited here and re-rendered; the graphic is a video layer in Premiere.",
};

export type Key = keyof typeof en;

const ar: Record<Key, string> = {
  ...phasesAr,
  ...finishAr,
  appName: "مجموعة الملتيميديا والذكاء الاصطناعي",
  appSub: "استوديو البودكاست",
  langButton: "English",
  langButtonTitle: "تحويل الواجهة إلى الإنجليزية",

  navDashboard: "الرئيسية",
  navSettings: "الإعدادات",

  camGuest: "كاميرا الضيف",
  camHost: "كاميرا المذيع",
  camWide: "كاميرا الوايد",
  micGuest: "مايك الضيف",
  micHost: "مايك المذيع",

  premiere: "بريمير",
  version: "النسخة",
  uxp: "UXP",
  system: "النظام",
  apis: "{ok}/{all} واجهة متاحة",
  apiAvailability: "الواجهات البرمجية المتاحة",
  oldPremiere: "يُفضّل بريمير {min} أو أحدث. النسخ الأقدم ناقصها مزايا تحتاجها بعض المراحل.",
  hostUnknown: "مش قادر أقرأ بيانات البريمير.",
  yes: "نعم",
  no: "لا",
  missing: "ناقص",

  project: "المشروع",
  file: "الملف",
  sequences: "السيكوانسات",
  noProject: "افتح مشروع في البريمير.",
  noSequence: "مفيش سيكوانس مفتوحة. افتح واحدة في التايم لاين.",
  frame: "المقاس",
  frameRate: "عدد الفريمات",
  duration: "المدة",
  playhead: "مكان المؤشر",
  captions: "الكابشن",
  captionTracks: "{n} تراك",
  clips: "{n} كليب",
  mediaFiles: "ملفات الميديا",
  noFileItems: "(+{n} عنصر من غير ملف)",
  refresh: "تحديث",
  reading: "بيقرا…",
  createBins: "إنشاء فولدرات المشروع",
  addMarker: "ماركر تجريبي",
  addMarkerTitle: "بيحط ماركر عند المؤشر (ينفع تتراجع عنه) للتأكد إن التعديل على التايم لاين شغال",
  connected: "متصل",
  none: "لا يوجد",
  error: "خطأ",

  engine: "المحرك",
  engineBuiltIn: "جوه البلجن نفسه. بيشتغل لوحده وبيقفل مع البريمير.",
  engineStarting: "المحرك بيشتغل…",
  engineRunning: "شغال",
  engineStartingPill: "بيبدأ",
  engineStopped: "واقف",
  engineOffline: "مش متاح.",
  engineExternalHelp: "وضع التطوير: شغّل المحرك بنفسك وبعدين اضغط إعادة المحاولة.",
  restartEngine: "إعادة تشغيل المحرك",
  retry: "إعادة المحاولة",
  pairPrompt: "اكتب كود الربط اللي ظاهر في شباك المحرك.",
  pair: "ربط",
  pairing: "بيربط…",
  machine: "الجهاز",
  gpu: "كارت الشاشة",
  gpuNone: "مش متعرّف (هيشتغل على المعالج)",
  aiPackages: "حزم الذكاء الاصطناعي (مطلوبة في المراحل الجاية)",
  ffprobe: "FFprobe",
  found: "موجود",

  inspectTitle: "فحص الملفات",
  inspectHelp: "بيقرا كل ملف مستخدم في السيكوانس: عدد الفريمات، التايم كود، الصوت، ومشاكل المزامنة المحتملة.",
  inspect: "فحص ملفات السيكوانس",
  cancel: "إلغاء",
  needEngine: "مستني المحرك",
  needSequence: "افتح سيكوانس الأول",
  okCount: "{ok}/{all} سليم",
  check: "انتبه",

  cutTitle: "اختبار محرك التقطيع",
  cutHelp: "حط In و Out على التايم لاين واضغط الزرار. هتتعمل سيكوانس جديدة متشال منها الجزء ده من كل الكاميرات والمايكات مرة واحدة. السيكوانس الأصلية مش هتتلمس.",
  cutRun: "شيل من In لـ Out في سيكوانس جديدة",
  cutNeedInOut: "حط نقطة In ونقطة Out على التايم لاين الأول.",
  cutNeed263: "محتاج بريمير 26.3 أو أحدث.",
  cutStep_read: "بيقرا التايم لاين",
  cutStep_subclips: "بيجهز الأجزاء",
  cutStep_clone: "بينسخ السيكوانس",
  cutStep_place: "بيحط القطعات",
  cutStep_verify: "بيراجع كل قطعة",
  cutStep_done: "خلص",
  cutResultOk: "تم: «{name}». كل الـ {n} جزء اتراجعوا ومظبوطين على الفريم. اتشال {removed}.",
  cutResultBad: "«{name}» اتعملت بس {bad} من {n} جزء مختلفين عن الخطة. أولهم: {first}",
  cutFailed: "اختبار التقطيع فشل: {msg}",

  stageNotBuilt: "المرحلة {n} · لسه متبنتش",
  stageHow: "هتشتغل إزاي",
  stageLimits: "حدود البريمير اللي ظهرت في التقرير",
  stageNeeds: "المطلوب من المحرك",
  stageNoButtons: "المرحلة دي هيبقى ليها زراير أول ما تشتغل فعلاً جوه البريمير.",

  settingsEngine: "المحرك",
  address: "العنوان",
  forgetPairing: "إلغاء الربط",
  clearCache: "مسح نتايج التحليل المحفوظة",
  showEngineLog: "عرض سجل المحرك",
  panel: "البانل",
  logLevel: "مستوى السجل",
  language: "اللغة",
  copyDiagnostics: "نسخ بيانات التشخيص",

  binsCreated: "اتعمل {n} فولدر. تقدر تتراجع بـ Ctrl+Z.",
  binsExist: "فولدرات المشروع موجودة بالفعل. متغيرش حاجة.",
  markerAdded: "اتحط ماركر عند المؤشر. تقدر تتراجع بـ Ctrl+Z.",
  noProjectOpen: "مفيش مشروع مفتوح.",
  failed: "{what} فشل: {msg}",
  paired: "اتربط بالمحرك.",
  diagCopied: "بيانات التشخيص اتنسخت.",
  diagConsole: "النسخ مش متاح. البيانات اتكتبت في الـ console.",
  cacheCleared: "اتمسح {n} نتيجة محفوظة.",
  logShown: "آخر {n} سطر من سجل المحرك اتكتبوا في الـ console.",
  noMediaToInspect: "السيكوانس دي مفيهاش ملفات ميديا.",
  motionTitle: "مكتبة الموشن",
  motionHelp: "اختار الجرافيك، اكتب الكلام، واضغط إدراج. هيتحط عند المؤشر على تراك فاضي فوق الكاميرات، ومش هيمسح أي حاجة.",
  motionLoading: "بيحمّل القوالب…",
  motionNeedEngine: "لازم المحرك يكون شغال علشان يعمل الجرافيك.",
  motionNeedSequence: "افتح سيكوانس: الجرافيك بيتعمل بمقاسها وعدد فريماتها.",
  duration_s: "المدة (ثانية)",
  preview: "معاينة",
  insertAtPlayhead: "إدراج عند المؤشر",
  updateGraphic: "تحديث النص مكانه",
  cancelEdit: "إلغاء التعديل",
  rendering: "بيعمل الجرافيك…",
  inserted: "اتحط على V{track} عند {tc}.",
  updated: "الجرافيك اتحدّث في كل مكان مستخدم فيه.",
  placedTitle: "اللي اتحط في الجلسة دي",
  edit: "تعديل",
  logo: "اللوجو / الأيقونة",
  chooseLogo: "اختار صورة…",
  clearLogo: "الأيقونة الافتراضية",
  accentColor: "اللون الأساسي",
  logoHint: "الأفضل PNG شفاف. هيحل مكان الأيقونة المدورة في كل الجرافيكس.",
  defaultIcon: "الأيقونة الافتراضية",
  editableNote: "النص بيتعدّل من هنا ويتعمل تاني؛ الجرافيك في البريمير طبقة فيديو.",
};

const dictionaries: Record<Lang, Record<Key, string>> = { en, ar };
let current: Lang = "en";

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

export function isRtl(): boolean {
  return current === "ar";
}

/**
 * UXP has no CSS `direction`, so a line's base direction defaults to
 * left-to-right and Arabic sentences containing English words (In, Out, fps)
 * come out shuffled. Wrapping Arabic text in RIGHT-TO-LEFT EMBEDDING ... POP
 * fixes the order in any text engine that implements Unicode bidi.
 */
const RLE = "\u202B";
const PDF = "\u202C";
function directed(s: string): string {
  return current === "ar" ? RLE + s + PDF : s;
}

/** Text without bidi control characters (for tests and logs). */
export function plain(s: string): string {
  return s.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
}

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  const s = dictionaries[current][key] ?? en[key];
  return directed(s.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`)));
}

/** Pick the right language from a bilingual value. */
export function pick(value: { en: string; ar: string }): string {
  return directed(value[current]);
}

export function defaultLang(uiLocale: string | undefined): Lang {
  return uiLocale?.toLowerCase().startsWith("ar") ? "ar" : "en";
}

export function __allKeys(): { en: Key[]; ar: Key[] } {
  return { en: Object.keys(en) as Key[], ar: Object.keys(ar) as Key[] };
}
