// Project settings. The publishable key is meant to live in the app:
// what each signed-in person can do is enforced by the database itself.
export const SUPABASE_URL = 'https://dvfyggsqrnfedizoroln.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_UvZymLdYo4fBXXstSDrY-A_yWoQMrx6';

// Usernames are turned into internal sign-in addresses on this domain.
// Must match the domain used in supabase/setup.sql.
export const USER_EMAIL_DOMAIN = 'users.tasks.local';

// Public address of the web app, used in account invitations.
// Filled in once the app is published on GitHub Pages.
export const APP_URL = 'https://ibrahimsalah55155-web.github.io/task-app/';

// Direct download of the latest Android build (GitHub release).
export const APK_URL = 'https://github.com/ibrahimsalah55155-web/task-app/releases/download/apk-latest/injaz.apk';

export const APP_NAME = 'إنجاز';
export const APP_VERSION = '1.1.0';
