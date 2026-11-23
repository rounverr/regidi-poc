import { ArrowRight, KeyRound, ShieldOff } from "lucide-react";
import { DEMO_PERSON, SERVICES, type Operation, type Scope, type Service } from "../shared/protocol";
import { useLanguage } from "../i18n/react";
import type { MessageKey } from "../i18n/locales/en";
import { formatMoney, formatTime } from "./DecisionPanel";
import { Card, LabSelect, Pill } from "./LabControls";
import type { useLab } from "./useLab";

const labDurations = [180, 300, 900] as const satisfies readonly Scope["durationSeconds"][];
const durations: Record<(typeof labDurations)[number], MessageKey> = { 180: "lab.step2.3", 300: "lab.step2.5", 900: "lab.step2.15" };
const grantOperations: Record<Service, Operation[]> = { aero: ["prepare_booking"], bank: ["prepare_transfer", "confirm_transfer"] };

export function DelegationStep({
  session, sessionExpired, grant, revoked, grantExpired, busy, error,
  grantService, grantOperation, maxAmount, duration,
  selectGrantService, setGrantOperation, setMaxAmount, setDuration, issue, revoke,
}: ReturnType<typeof useLab>["delegation"]) {
  const { t, tag } = useLanguage();
  const serviceLabel = (value: Service) => t(`service.${value}`);
  const operationLabel = (value: Operation) => t(`operation.${value}`);
  const disabled = !session || sessionExpired || busy !== null;
  return (
    <Card step={2} icon={<KeyRound size={19} />} title={t("lab.step2.title")}
      description={t("lab.step2.desc", { person: DEMO_PERSON })}
      status={<Pill tone={revoked ? "deny" : grantExpired ? "warn" : grant ? "pass" : ""}>{revoked ? t("lab.step2.revoked") : grantExpired ? t("lab.step2.expired") : grant ? t("lab.step2.active") : t("lab.step2.noGrant")}</Pill>}>
      <form noValidate onSubmit={issue}>
        <fieldset className="fieldset" disabled={disabled}>
          <legend className="sr-only">{t("lab.step2.scope")}</legend>
          <div className="fields">
            <label>{t("lab.step2.service")}
              <LabSelect value={grantService} label={t("lab.step2.service")}
                disabled={disabled}
                onValueChange={value => selectGrantService(value as Service)}
                options={SERVICES.map(item => ({ value: item, label: serviceLabel(item) }))} />
            </label>
            <label>{t("lab.step2.operation")}
              <LabSelect value={grantOperation} label={t("lab.step2.operation")}
                disabled={disabled}
                onValueChange={value => setGrantOperation(value as Operation)}
                options={grantOperations[grantService].map(item => ({ value: item, label: operationLabel(item) }))} />
            </label>
            <label>{t("lab.step2.max")}<input type="text" inputMode="decimal" required maxLength={8} placeholder={new Intl.NumberFormat(tag).format(800)} value={maxAmount} onChange={(event) => setMaxAmount(event.target.value)} /></label>
            <label>{t("lab.step2.duration")}
              <LabSelect value={duration} label={t("lab.step2.duration")}
                disabled={disabled}
                onValueChange={value => setDuration(Number(value) as Scope["durationSeconds"])}
                options={labDurations.map(item => ({ value: String(item), label: t(durations[item]) }))} />
            </label>
          </div>
          <div className="step-actions">
            <button className={`button ${session && !grant ? "primary" : "secondary"}`} type="submit">
              {busy === "grant" ? <><span className="spinner" /> {t("lab.step2.signing")}</> : grant ? t("lab.step2.newGrant") : t("lab.step2.grant")}
            </button>
            {grant && !revoked && !grantExpired && <button className="button revoke-button" type="button" onClick={revoke}><ShieldOff size={15} aria-hidden="true" /> {busy === "revoke" ? t("lab.step2.revoking") : t("lab.step2.revoke")}</button>}
          </div>
        </fieldset>
      </form>
      {(error?.task === "grant" || error?.task === "revoke") && <p className="form-error" role="alert">{t(error.messageKey)}{error.code && <> (<bdi>Cloudflare {error.code}</bdi>)</>}</p>}
      {grant && (
        <div className="grant-summary">
          <p aria-live="polite">
            {revoked ? t("lab.step2.revokedNote") :
              grantExpired ? t("lab.step2.expiredNote") :
              <><strong>{serviceLabel(grant.service)} · {formatMoney(grant.maxAmountCents, "USD", tag)}</strong> · {t("lab.step2.expires", { time: formatTime(grant.expiresAt, tag) })}</>}
          </p>
          <details className="grant-details">
            <summary>{t("lab.step2.inspect")}</summary>
            <dl className="metadata">
              <div><dt>{t("lab.step2.issuer")}</dt><dd className="mono">{grant.issuer}</dd></div>
              <div><dt>{t("lab.step2.audience")}</dt><dd className="mono">{grant.audience}</dd></div>
              <div><dt>{t("lab.step2.operationLabel")}</dt><dd>{operationLabel(grant.operation)}</dd></div>
              <div><dt>{t("lab.step2.keyID")}</dt><dd className="mono">{grant.keyId}</dd></div>
            </dl>
            <pre dir="ltr" className="mono" tabIndex={0} aria-label={t("lab.step2.credential")}>{grant.credential}</pre>
            <a className="text-link" href="/api/issuer/jwks" target="_blank" rel="noopener noreferrer">{t("lab.step2.publicKey")} <ArrowRight size={13} aria-hidden="true" /></a>
          </details>
        </div>
      )}
    </Card>
  );
}
