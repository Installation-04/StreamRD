/**
 * Minimal i18n layer. Add a language by creating another dictionary with the
 * same keys and registering it in `dictionaries`.
 */
export type Locale = "en";

const en = {
  "app.name": "StreamRD",
  "nav.home": "Home",
  "nav.search": "Search",
  "nav.account": "Account",
  "nav.admin": "Admin",
  "nav.login": "Sign in",
  "nav.logout": "Sign out",
  "home.empty": "No titles yet. An admin can add some under Admin → Catalog.",
  "search.placeholder": "Search movies and series…",
  "title.play": "Play",
  "title.sources": "sources",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.displayName": "Display name",
  "auth.signup": "Create account",
  "auth.login": "Sign in",
  "account.profile": "Profile",
  "account.settings": "Settings",
  "account.debrid": "Debrid services",
  "debrid.primary": "Primary provider",
  "debrid.test": "Test connection",
  "admin.overview": "Overview",
  "admin.users": "Users",
  "admin.catalog": "Catalog",
  "admin.server": "Server",
  "admin.providers": "Providers",
  "admin.logs": "Logs",
} as const;

export type TranslationKey = keyof typeof en;

const dictionaries: Record<Locale, Record<TranslationKey, string>> = { en };

let currentLocale: Locale = "en";

export const setLocale = (locale: Locale) => {
  currentLocale = locale;
};

export const t = (key: TranslationKey): string =>
  dictionaries[currentLocale][key] ?? key;
