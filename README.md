# إنجاز

تطبيق عربي لمتابعة مهام الفريق: المدير يضيف المهام والحسابات، وكل مستخدم يعلّم على المهمة لما يخلّصها، فيتسجل اسمه وتاريخ ووقت الإنجاز تلقائياً من السيرفر، وتظهر التغييرات فوراً على كل الأجهزة.

- **نسخة ويب:** تُنشر تلقائياً على GitHub Pages.
- **نسخة أندرويد (APK):** تُبنى تلقائياً مع كل تعديل، وتلاقيها في صفحة **Releases** باسم `injaz.apk`.

## التشغيل لأول مرة

1. في Supabase: افتح **SQL Editor** والصق محتوى `supabase/setup.sql` ودوس **Run**.
2. ادخل بـ `admin` / `admin`، وهيطلب منك تغيير كلمة المرور فوراً.
3. من تبويب **المستخدمون** اعمل حساب لكل شخص، وابعتله الدعوة.

## الصلاحيات

| | المدير | المستخدم |
|---|---|---|
| يشوف المهام | كلها | المهام العامة والمسندة له |
| يضيف / يعدّل / يحذف مهام | ✓ | |
| يعلّم مهمة كمنجزة | ✓ | ✓ (المسموح له بيها) |
| يعيد فتح مهمة | ✓ | اللي أنجزها هو بس |
| يدير الحسابات | ✓ | |
| السجل | كامل | سجله هو بس |

كل الصلاحيات دي متطبّقة في قاعدة البيانات نفسها (Row Level Security + دوال على السيرفر)، مش في الواجهة بس. اسم المستخدم ووقت الإنجاز بيتسجلوا من السيرفر، فمحدش يقدر يعلّم مهمة باسم حد تاني.

## هيكل المشروع

```
app/                 التطبيق (HTML/CSS/JS بدون أدوات بناء)
  js/config.js       رابط Supabase والمفتاح العام
  js/api.js          كل الاتصال بـ Supabase
  js/ui.js           عناصر الواجهة: النوافذ، الرسائل، الحقول، التنسيق
  js/app.js          الشاشات والمنطق
  css/app.css        نظام التصميم (فاتح وداكن)
supabase/setup.sql   الجداول والصلاحيات والدوال
android-res/         أيقونات أندرويد
.github/workflows/   نشر الويب + بناء الـ APK
```

## Build instructions (English)

The web app is plain static files in `app/`; no build step. Serve it with any static server (`npm run serve`).

Android APK (needs Node 22, JDK 21, Android SDK):

```bash
npm install
npx cap add android
cp -r android-res/. android/app/src/main/res/
npx cap sync android
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

GitHub Actions does exactly this on every push to `main` and publishes the APK under the `apk-latest` release. The APK is debug-signed, which installs fine by side-loading; a Play Store release needs your own signing key.

Database tests: `test/mock_supabase.sql` + `test/flows.sql` run the setup against a local Postgres that mimics Supabase and exercise every permission rule.
