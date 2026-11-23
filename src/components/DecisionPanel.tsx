import { ArrowDown, CircleCheck, CircleMinus, CircleX, Terminal } from "lucide-react";
import { CHECKS, type Check, type Decision } from "../shared/protocol";
import { useLanguage } from "../i18n/react";
import type { MessageKey } from "../i18n/locales/en";

export function formatTime(timestamp: number, tag: string): string {
  return new Intl.DateTimeFormat(tag, { dateStyle: "short", timeStyle: "medium" }).format(timestamp * 1000);
}

export function formatMoney(cents: number, currency: string, tag: string): string {
  return new Intl.NumberFormat(tag, {
    style: "currency", currency, currencyDisplay: "code", minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function DecisionPanel({ decision, verifying }: { decision: Decision | null; verifying: boolean }) {
  const { t, tag } = useLanguage();
  const passed = decision ? CHECKS.filter(check => decision.checks[check] === "passed").length : 0;
  return (
    <aside className="decision-panel" id="verification" tabIndex={-1} aria-labelledby="verification-title">
      <div className="decision-header">
        <div className="panel-icon"><Terminal size={17} aria-hidden="true" /></div>
        <div><h2 id="verification-title">{t("decision.heading")}</h2><p>{t("decision.subtitle")}</p></div>
      </div>
      <div className="decision-content" aria-busy={verifying}>
        <div aria-live="polite" aria-atomic="true">
          {verifying ? <div className="decision-placeholder"><span className="spinner" /> {t("decision.verifying")}</div>
            : decision ? (
              <div className={`decision-result ${decision.allowed ? "is-pass" : "is-denied"}`}>
                {decision.allowed ? <CircleCheck size={21} aria-hidden="true" /> : <CircleX size={21} aria-hidden="true" />}
                <div><strong>{decision.allowed ? t("decision.allowed") : t("decision.denied")}</strong><p>{t(`reason.${decision.code}`)}</p></div>
              </div>
            ) : (
              <div className="decision-placeholder empty">
                <span className="empty-icon"><ArrowDown size={20} aria-hidden="true" /></span>
                <strong>{t("decision.emptyTitle")}</strong>
                <p>{t("decision.emptyText")}</p>
              </div>
            )}
        </div>
        {decision && !verifying && <>
          <dl className="decision-summary">
            <div><dt>{t("decision.service")}</dt><dd>{t(`service.${decision.request.service}` as MessageKey)}</dd></div>
            <div><dt>{t("decision.operation")}</dt><dd>{t(`operation.${decision.request.operation}` as MessageKey)}</dd></div>
            <div><dt>{t("decision.amount")}</dt><dd className="mono">{formatMoney(decision.request.amountCents, decision.request.currency, tag)}</dd></div>
          </dl>
          <details className="check-details" open>
            <summary><span>{t("decision.checks")}</span><span className="mono muted">{passed}/{CHECKS.length}</span></summary>
            <ul className="check-list">
              {CHECKS.map((check: Check) => {
                const state = decision.checks[check];
                const Icon = state === "passed" ? CircleCheck : state === "failed" ? CircleX : CircleMinus;
                const label = state === "passed" ? t("decision.passed") : state === "failed" ? t("decision.failed") : t("decision.skipped");
                return <li key={check} className={state}><span><Icon size={14} aria-hidden="true" /> {t(`check.${check}` as MessageKey)}</span><span>{label}</span></li>;
              })}
            </ul>
          </details>
          <details className="check-details raw-details">
            <summary>{t("decision.json")}</summary>
            <pre dir="ltr" className="mono" tabIndex={0} aria-label={t("decision.json")}>{JSON.stringify(decision, null, 2)}</pre>
          </details>
        </>}
      </div>
      <div className="decision-footer"><span className="small-dot"></span> {t("decision.server")}</div>
    </aside>
  );
}
