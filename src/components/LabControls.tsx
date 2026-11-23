import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useLanguage } from "../i18n/react";

export function Card({ step, icon, title, description, status, children }: {
  step: number; icon: ReactNode; title: string; description: string; status: ReactNode; children: ReactNode;
}) {
  const { t } = useLanguage();
  return (
    <section className="lab-card" aria-labelledby={`step-${step}`}>
      <header className="step-heading">
        <span className="step-icon" aria-hidden="true">{icon}</span>
        <div><span className="step-index mono">{t("lab.step", { step })}</span><h2 id={`step-${step}`}>{title}</h2></div>
        <div className="step-status">{status}</div>
      </header>
      <p className="step-description">{description}</p>
      {children}
    </section>
  );
}

export function Pill({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <span className={`pill ${tone}`}><span className="pill-dot" aria-hidden="true"></span>{children}</span>;
}

type LabOption = { value: string; label: string };
export function LabSelect({ value, onValueChange, options, disabled, label }: {
  value: string | number; onValueChange: (value: string) => void;
  options: LabOption[]; disabled: boolean; label: string;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const chosen = options.findIndex(option => option.value === String(value));

  useEffect(() => {
    if (disabled && menu.current) menu.current.open = false;
  }, [disabled]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  const choose = (option: LabOption) => {
    onValueChange(option.value);
    if (menu.current) menu.current.open = false;
    menu.current?.querySelector<HTMLElement>("summary")?.focus();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (disabled) return;
    if (event.key === "Escape" && menu.current?.open) {
      event.preventDefault();
      menu.current.open = false;
      menu.current.querySelector<HTMLElement>("summary")?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (menu.current) menu.current.open = true;
      const current = buttons.current.findIndex(button => button === document.activeElement);
      const index = current < 0 ? chosen : current;
      const next = (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      buttons.current[next]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (menu.current) menu.current.open = true;
      buttons.current[event.key === "Home" ? 0 : options.length - 1]?.focus();
    }
  };
  return (
    <details className="field-select field-dropdown" ref={menu} onKeyDown={handleKeyDown}
      onToggle={() => { if (menu.current?.open && disabled) menu.current.open = false; }}>
      <summary aria-label={label} aria-disabled={disabled} tabIndex={disabled ? -1 : 0}
        onClick={event => { if (disabled) event.preventDefault(); }}>
        <span>{options[chosen]?.label ?? options[0]?.label ?? ""}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <ul className="field-dropdown-options" aria-label={label}>
        {options.map((option, index) => (
          <li key={option.value}>
            <button type="button" ref={element => { buttons.current[index] = element; }}
              aria-current={option.value === String(value) ? "true" : undefined}
              onClick={() => choose(option)}>
              {option.label}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
