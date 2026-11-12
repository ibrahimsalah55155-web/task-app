/**
 * The workflow stages, in Arabic and English. Stages that are not built yet
 * say so plainly and carry no action buttons: nothing pretends to work.
 */

type Text = { en: string; ar: string };

export interface StageDef {
  id: string;
  step: number;
  title: Text;
  short: Text;
  phase: number;
  goal: Text;
  approach: Text[];
  limits: Text[];
  engineNeeds: string[];
}

export const STAGES: StageDef[] = [
  {
    id: "sync",
    step: 1,
    title: { en: "Sync & Build", ar: "المزامنة وبناء التايم لاين" },
    short: { en: "Sync", ar: "المزامنة" },
    phase: 2,
    goal: {
      en: "Inspect every file from the Guest Camera, Host Camera, Wide Camera and the external mics, sync them on one timebase and build an editable sequence: V1 Wide Camera, V2 Host Camera, V3 Guest Camera; A1 Guest Mic, A2 Host Mic.",
      ar: "فحص كل ملفات كاميرا الضيف وكاميرا المذيع وكاميرا الوايد والمايكات الخارجية، ومزامنتهم على توقيت واحد، وبناء سيكوانس جاهزة للمونتاج: V1 كاميرا الوايد، V2 كاميرا المذيع، V3 كاميرا الضيف؛ A1 مايك الضيف، A2 مايك المذيع.",
    },
    approach: [
      { en: "The engine reads timecode, frame rate and audio of every file (working now: Dashboard › Inspect sequence media).",
        ar: "المحرك بيقرا التايم كود وعدد الفريمات والصوت لكل ملف (شغال دلوقتي: الرئيسية › فحص ملفات السيكوانس)." },
      { en: "Sync by timecode when it agrees with the audio; otherwise by matching the sound waves, with drift detection and a confidence score.",
        ar: "المزامنة بالتايم كود لو متطابق مع الصوت، وإلا بمطابقة موجات الصوت، مع اكتشاف الانحراف ونسبة ثقة." },
      { en: "The sequence is built with undoable Premiere actions and the tracks are named after each camera.",
        ar: "السيكوانس بتتبني بأوامر بريمير ينفع تتراجع عنها، والتراكات بتتسمى باسم كل كاميرا." },
    ],
    limits: [
      { en: "Premiere has no API for a multicam source sequence, so cameras are stacked on tracks (which Auto Director needs anyway).",
        ar: "مفيش API لسيكوانس الـ Multicam الرسمية، فالكاميرات بتتحط فوق بعض على تراكات (وده المطلوب للمخرج الآلي أصلاً)." },
    ],
    engineNeeds: ["ffprobe", "ffmpeg", "numpy"],
  },
  {
    id: "silence",
    step: 2,
    title: { en: "Smart Silence Cut", ar: "حذف السكوت الذكي" },
    short: { en: "Silence", ar: "السكوت" },
    phase: 3,
    goal: {
      en: "Find real pauses on all mics, let you review them, then remove the same interval from every camera and mic in a new PODCAST_01_SILENCE_CUT sequence.",
      ar: "اكتشاف السكوت الحقيقي على كل المايكات، تراجعه بنفسك، وبعدين يتشال نفس الجزء من كل الكاميرات والمايكات في سيكوانس جديدة PODCAST_01_SILENCE_CUT.",
    },
    approach: [
      { en: "Voice detection + per-mic loudness + word timing, with protected margins so words are never clipped.",
        ar: "اكتشاف الكلام + مستوى صوت كل مايك + توقيت الكلمات، مع هوامش محمية علشان الكلام ميتقصش." },
      { en: "Cutting uses the cut engine (test it now on the Dashboard): one plan, applied to every track, frame-exact, then verified.",
        ar: "التقطيع بيستخدم محرك التقطيع (تقدر تختبره دلوقتي من الرئيسية): خطة واحدة على كل التراكات، مظبوطة على الفريم، وبعدين بتتراجع." },
    ],
    limits: [
      { en: "Premiere has no razor API. The cut engine rebuilds the timeline from exact segments instead, and checks the result.",
        ar: "مفيش أمر قص (razor) في البريمير. محرك التقطيع بيعيد بناء التايم لاين من أجزاء مظبوطة بدلاً منه، وبيراجع النتيجة." },
    ],
    engineNeeds: ["ffmpeg", "numpy", "silero_vad"],
  },
  {
    id: "director",
    step: 3,
    title: { en: "AI Auto Director", ar: "المخرج الآلي" },
    short: { en: "Director", ar: "المخرج" },
    phase: 4,
    goal: {
      en: "Show the camera of whoever is talking: Guest Camera when the guest speaks, Host Camera for the host, Wide Camera when both talk. Every camera stays on the timeline; only the off-air pieces are disabled.",
      ar: "عرض كاميرا اللي بيتكلم: كاميرا الضيف لما الضيف يتكلم، كاميرا المذيع للمذيع، وكاميرا الوايد لما الاتنين يتكلموا. كل الكاميرات فاضلة على التايم لاين، بس الأجزاء اللي مش معروضة بتتقفل.",
    },
    approach: [
      { en: "Speaker activity from each mic, with minimum shot length and no cut in the middle of a word.",
        ar: "مين بيتكلم من كل مايك، مع أقل مدة للقطة ومن غير قطع في نص الكلمة." },
      { en: "The cut engine splits all cameras at the same frames; Premiere's enable/disable clip action picks the visible one.",
        ar: "محرك التقطيع بيقسم كل الكاميرات على نفس الفريمات، وأمر تفعيل/تعطيل الكليب في البريمير بيختار الظاهرة." },
    ],
    limits: [],
    engineNeeds: ["ffmpeg", "numpy", "silero_vad"],
  },
  {
    id: "reels",
    step: 4,
    title: { en: "AI Viral Clip Finder", ar: "مستخرج الريلز" },
    short: { en: "Reels", ar: "الريلز" },
    phase: 5,
    goal: {
      en: "Read the approved cut, suggest reels with real hooks (only words that were actually said), and build REEL_xx_EDIT sequences in 9:16, 1:1, 4:5 or 16:9.",
      ar: "قراءة النسخة المعتمدة، واقتراح ريلز ببدايات قوية (من كلام اتقال فعلاً بس)، وبناء سيكوانسات REEL_xx_EDIT بمقاس 9:16 أو 1:1 أو 4:5 أو 16:9.",
    },
    approach: [
      { en: "Local speech-to-text and ranking on your machine; no cloud key.", ar: "تحويل الكلام لنص وترتيب المقاطع على جهازك، من غير أي مفتاح سحابي." },
      { en: "Face-aware reframing with Motion keyframes you can still edit.", ar: "إعادة تأطير حسب مكان الوش بكيفريمات Motion تقدر تعدلها." },
    ],
    limits: [{ en: "Scores are editorial estimates, not a promise of views.", ar: "التقييمات تقدير تحريري، مش ضمان مشاهدات." }],
    engineNeeds: ["ffmpeg", "faster_whisper", "cv2"],
  },
  {
    id: "captions",
    step: 5,
    title: { en: "Smart Captions", ar: "الكابشن الذكي" },
    short: { en: "Captions", ar: "الكابشن" },
    phase: 6,
    goal: {
      en: "Arabic-first captions (Egyptian and other dialects) with word timing, editable in the panel, as SRT and styled animated captions.",
      ar: "كابشن عربي أولاً (مصري ولهجات تانية) بتوقيت الكلمات، تعدله من البانل، كملف SRT وكابشن متحركة بستايل.",
    },
    approach: [
      { en: "Whisper running locally; uncertain words are highlighted for review.", ar: "Whisper شغال على جهازك، والكلمات اللي مش متأكد منها بتتعلّم علشان تراجعها." },
    ],
    limits: [
      { en: "Premiere has no API that creates captions from text; the SRT import path will be tested, and animated styles are rendered as graphics.",
        ar: "مفيش API بيعمل كابشن من نص؛ هنجرب استيراد SRT، والستايلات المتحركة بتترندر كجرافيك." },
    ],
    engineNeeds: ["ffmpeg", "faster_whisper"],
  },
  {
    id: "motion",
    step: 6,
    title: { en: "Motion Library", ar: "مكتبة الموشن" },
    short: { en: "Motion", ar: "الموشن" },
    phase: 7,
    goal: {
      en: "One click puts a lower third, photo card, split screen or title at the playhead, on a free track, without overwriting anything.",
      ar: "ضغطة واحدة تحط اسم الضيف أو صورة أو سبليت سكرين أو عنوان عند المؤشر، على تراك فاضي، من غير ما يمسح حاجة.",
    },
    approach: [
      { en: "Animation details come from the reference videos you send.", ar: "تفاصيل الحركة هتتاخد من فيديوهات الريفرانس اللي هتبعتها." },
    ],
    limits: [
      { en: "Editing template text from code needs Premiere 27 (you have the latest, so this is available).",
        ar: "تعديل نص القوالب من الكود محتاج بريمير 27 (عندك آخر نسخة، فده متاح)." },
    ],
    engineNeeds: ["ffmpeg"],
  },
  {
    id: "export",
    step: 7,
    title: { en: "Review & Export", ar: "المراجعة والتصدير" },
    short: { en: "Export", ar: "التصدير" },
    phase: 8,
    goal: {
      en: "Review approved outputs and queue them to Media Encoder. Nothing is exported without your approval.",
      ar: "مراجعة النسخ المعتمدة وإرسالها لـ Media Encoder. مفيش حاجة بتتصدّر من غير موافقتك.",
    },
    approach: [],
    limits: [],
    engineNeeds: [],
  },
];
