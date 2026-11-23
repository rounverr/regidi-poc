import { useSyncExternalStore } from "react";
import { defaultLanguage, getLanguage, localeTag, subscribeLanguage, translate } from "./index";
import type { MessageKey } from "./locales/en";

const getServerLanguage = () => defaultLanguage;

export function useLanguage() {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage, getServerLanguage);
  const t = (key: MessageKey, variables?: Record<string, string | number>) =>
    translate(key, variables, language);
  return { tag: localeTag(language.locale), t };
}
