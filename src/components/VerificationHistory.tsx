import { ArrowRight, History } from "lucide-react";
import type { Decision, Operation, Service } from "../shared/protocol";
import { useLanguage } from "../i18n/react";
import { formatTime } from "./DecisionPanel";
import { Pill } from "./LabControls";
import { historyLimit } from "./useLab";

export function VerificationHistory({ history, setDecision }: {
  history: Decision[];
  setDecision: (decision: Decision) => void;
}) {
  const { t, tag } = useLanguage();
  const serviceLabel = (value: Service) => t(`service.${value}`);
  const operationLabel = (value: Operation) => t(`operation.${value}`);
  return (
    <section className="history-panel" aria-labelledby="history-title">
      <header className="decision-header">
        <div className="panel-icon"><History size={17} aria-hidden="true" /></div>
        <div><h2 id="history-title">{t("lab.history.title")}</h2><p>{t("lab.history.sub", { count: historyLimit })}</p></div>
      </header>
      {history.length === 0 ? <p className="history-empty">{t("lab.history.empty")}</p> :
        <ul className="history-list">
          {history.map((entry) => <li key={entry.id}>
            <div><time className="mono" dateTime={new Date(entry.decidedAt * 1000).toISOString()}>{formatTime(entry.decidedAt, tag)}</time><span className="history-agent mono">{t("lab.step1.agentID")}: {entry.agentId}</span></div>
            <div><strong>{serviceLabel(entry.request.service)} · {operationLabel(entry.request.operation)}</strong><span>{t(`reason.${entry.code}`)}</span></div>
            <div className="history-outcome"><Pill tone={entry.allowed ? "pass" : "deny"}>{entry.allowed ? t("lab.step3.allowed") : t("lab.step3.denied")}</Pill>
              <a href="#verification" className="text-link" onClick={() => setDecision(entry)} aria-label={t("lab.history.inspectAria", { time: formatTime(entry.decidedAt, tag) })}>{t("lab.history.inspect")} <ArrowRight size={13} aria-hidden="true" /></a>
            </div>
          </li>)}
        </ul>}
    </section>
  );
}
