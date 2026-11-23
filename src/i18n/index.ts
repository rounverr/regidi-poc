import { en, type MessageKey } from "./locales/en";
export type Locale = "en" | "es" | "pt" | "de" | "fr" | "it" | "ja" | "hi" | "ar";
export type Messages = Record<MessageKey, string>;
export const localeOptions: ReadonlyArray<{ code: Locale; name: string; tag: string; short: string }> = [
  { code: "en", name: "English (US)", tag: "en-US", short: "EN" },
  { code: "es", name: "Español (LatAm)", tag: "es-419", short: "ES" },
  { code: "pt", name: "Português", tag: "pt-BR", short: "PT" },
  { code: "de", name: "Deutsch", tag: "de-DE", short: "DE" },
  { code: "fr", name: "Français", tag: "fr-FR", short: "FR" },
  { code: "it", name: "Italiano", tag: "it-IT", short: "IT" },
  { code: "ja", name: "日本語", tag: "ja-JP", short: "JA" },
  { code: "hi", name: "हिन्दी", tag: "hi-IN", short: "HI" },
  { code: "ar", name: "العربية", tag: "ar", short: "AR" },
];
const imports: Record<Exclude<Locale, "en">, () => Promise<{ default: Messages }>> = {
  es: () => import("./locales/es"), pt: () => import("./locales/pt"),
  de: () => import("./locales/de"), fr: () => import("./locales/fr"),
  it: () => import("./locales/it"), ja: () => import("./locales/ja"),
  hi: () => import("./locales/hi"), ar: () => import("./locales/ar"),
};
const CACHE_KEY = "regidi-lab-locale";
export const defaultLanguage = { locale: "en" as Locale, messages: en as Readonly<Messages> };
type Language = typeof defaultLanguage;
// Astro page scripts and React islands can load separate copies of this module.
type LocalizedDocument = Document & { regidiLanguage?: Language };

export function getLanguage(): Language {
  return typeof document === "undefined"
    ? defaultLanguage
    : (document as LocalizedDocument).regidiLanguage ?? defaultLanguage;
}

export function subscribeLanguage(listener: () => void): () => void {
  document.addEventListener("regidi:languagechange", listener);
  return () => document.removeEventListener("regidi:languagechange", listener);
}

export class LocalizedError extends Error {
  constructor(readonly messageKey: MessageKey, readonly code?: string) {
    super(translate(messageKey));
  }
}
let requestID = 0;

function supported(value: string): Locale | null {
  const code = value.toLowerCase().split("-")[0] as Locale;
  return localeOptions.some(item => item.code === code) ? code : null;
}
export function localeTag(value = getLanguage().locale): string {
  return localeOptions.find(item => item.code === value)?.tag ?? "en-US";
}
export function translate(
  key: MessageKey,
  variables: Record<string, string | number> = {},
  language = getLanguage(),
): string {
  const value = language.messages[key] ?? en[key];
  return value.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (whole, name: string) =>
    Object.hasOwn(variables, name) ? String(variables[name]) : whole);
}
export function translateDocument(): void {
  if (typeof document === "undefined") return;
  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n as MessageKey | undefined;
    if (key) element.textContent = translate(key);
  }
  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n-aria]")) {
    const key = element.dataset.i18nAria as MessageKey | undefined;
    if (key) element.setAttribute("aria-label", translate(key));
  }
  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n-content]")) {
    const key = element.dataset.i18nContent as MessageKey | undefined;
    if (key) element.setAttribute("content", translate(key));
  }
  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n-label]")) {
    const key = element.dataset.i18nLabel as MessageKey | undefined;
    if (key) element.dataset.label = translate(key);
  }
  for (const amount of document.querySelectorAll<HTMLElement>("[data-i18n-usd]")) {
    amount.textContent = new Intl.NumberFormat(localeTag(), {
      style: "currency", currency: "USD", currencyDisplay: "code", maximumFractionDigits: 0,
    }).format(Number(amount.dataset.i18nUsd));
  }
}
export async function setLocale(next: Locale, persist = true): Promise<void> {
  const seq = ++requestID;
  const nextMessages = next === "en" ? en : (await imports[next]()).default;
  if (seq !== requestID) return;
  if (typeof document !== "undefined") {
    (document as LocalizedDocument).regidiLanguage = { locale: next, messages: nextMessages };
    document.documentElement.lang = localeTag(next);
    document.documentElement.dir = next === "ar" ? "rtl" : "ltr";
    translateDocument();
    document.dispatchEvent(new CustomEvent("regidi:languagechange", { detail: { locale: next } }));
  }
  if (persist && typeof window !== "undefined") {
    try { window.localStorage.setItem(CACHE_KEY, next); } catch { /* Storage may be unavailable. */ }
  }
}
export function detectLocale(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const saved = window.localStorage.getItem(CACHE_KEY);
    if (saved) {
      const configured = supported(saved);
      if (configured) return configured;
    }
  } catch { /* Private browsing may disable storage. */ }
  for (const hint of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const supportedLocale = supported(hint);
    if (supportedLocale) return supportedLocale;
  }
  return "en";
}
