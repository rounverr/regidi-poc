import { ArrowRight, CircleHelp, Fingerprint, RotateCcw } from "lucide-react";
import { DEMO_PERSON } from "../shared/protocol";
import { useLanguage } from "../i18n/react";
import { DecisionPanel, formatTime } from "./DecisionPanel";
import { DelegationStep } from "./DelegationStep";
import { Card, Pill } from "./LabControls";
import { VerificationHistory } from "./VerificationHistory";
import { VerificationStep } from "./VerificationStep";
import { useLab } from "./useLab";

export default function Lab() {
  const { t, tag } = useLanguage();
  const {
    session, busy, sessionExpired, challengeContainer, error, begin, reset,
    decision, history, setDecision, delegation, verification,
  } = useLab();

  return (
    <>
      <header className="lab-page-heading">
        <div>
          <p className="eyebrow"><span className="small-dot"></span> {t("lab.eyebrow")}</p>
          <h1>{t("lab.title1")} <em>{t("lab.title2")}</em></h1>
          <p>{t("lab.lead")}</p>
        </div>
        <button className="button secondary reset-button" type="button" onClick={reset} disabled={!session || busy !== null}>
          <RotateCcw size={15} aria-hidden="true" /> {busy === "reset" ? t("lab.restarting") : t("lab.restart")}
        </button>
      </header>
      {error?.task === "reset" && <p className="form-error" role="alert">{t(error.messageKey)}{error.code && <> (<bdi>Cloudflare {error.code}</bdi>)</>}</p>}
      <div className="lab-disclosure"><CircleHelp size={16} aria-hidden="true" /><p>{t("lab.disclaimer")}</p></div>

      <div className="lab-grid">
        <div className="lab-steps">
          <Card step={1} icon={<Fingerprint size={20} />} title={t("lab.step1.title")}
            description={t("lab.step1.desc")}
            status={<Pill tone={sessionExpired ? "warn" : session ? "pass" : ""}>{sessionExpired ? t("lab.step1.expired") : session ? t("lab.step1.registered") : t("lab.step1.notStarted")}</Pill>}>
            {session ? (
              <>
                <dl className="metadata" aria-live="polite">
                  <div><dt>{t("lab.step1.agentID")}</dt><dd className="mono">{session.agentId}</dd></div>
                  <div><dt>{t("lab.step1.owner")}</dt><dd>{DEMO_PERSON}</dd></div>
                  <div><dt>{t("lab.step1.thumbprint")}</dt><dd className="mono">{session.thumbprint}</dd></div>
                  <div><dt>{t("lab.step1.expires")}</dt><dd>{formatTime(session.expiresAt, tag)}</dd></div>
                </dl>
                <p className="identity-note">{t("lab.step1.note")}</p>
              </>
            ) : (
              <button className="button primary" type="button" onClick={begin} disabled={busy !== null}>
                {busy === "agent" ? <><span className="spinner" /> {t("lab.step1.creating")}</> : <>{t("lab.step1.create")} <ArrowRight size={15} aria-hidden="true" /></>}
              </button>
            )}
            <div ref={challengeContainer} />
            {error?.task === "agent" && <p className="form-error" role="alert">{t(error.messageKey)}{error.code && <> (<bdi>Cloudflare {error.code}</bdi>)</>}</p>}
            {sessionExpired && <p className="form-note" role="status">{t("lab.step1.expiredNote")}</p>}
          </Card>

          <DelegationStep {...delegation} />

          <VerificationStep {...verification} />
        </div>

        <DecisionPanel decision={decision} verifying={busy === "verify"} />
      </div>

      <VerificationHistory history={history} setDecision={setDecision} />
    </>
  );
}
