import { ArrowDown, Landmark, Plane, Send } from "lucide-react";
import { OPERATIONS, SERVICES, type Operation, type OperationRequest, type Service } from "../shared/protocol";
import { useLanguage } from "../i18n/react";
import { formatMoney } from "./DecisionPanel";
import { Card, LabSelect, Pill } from "./LabControls";
import type { useLab } from "./useLab";

export function VerificationStep({
  sessionExpired, grant, busy, error, decision,
  service, operation, amount, currency,
  selectService, setOperation, setAmount, setCurrency, send, setExample,
}: ReturnType<typeof useLab>["verification"]) {
  const { t, tag } = useLanguage();
  const serviceLabel = (value: Service) => t(`service.${value}`);
  const operationLabel = (value: Operation) => t(`operation.${value}`);
  const disabled = !grant || sessionExpired || busy !== null;
  return (
    <Card step={3} icon={service === "aero" ? <Plane size={20} /> : <Landmark size={20} />} title={t("lab.step3.title")}
      description={t("lab.step3.desc")}
      status={<Pill tone={decision ? decision.allowed ? "pass" : "deny" : ""}>{decision ? decision.allowed ? t("lab.step3.allowed") : t("lab.step3.denied") : t("lab.step3.none")}</Pill>}>
      <form noValidate onSubmit={send}>
        <fieldset className="fieldset" disabled={disabled}>
          <legend className="sr-only">{t("lab.step3.data")}</legend>
          <div className="fields">
            <label>{t("lab.step3.service")}
              <LabSelect value={service} label={t("lab.step3.service")}
                disabled={disabled}
                onValueChange={value => selectService(value as Service)}
                options={SERVICES.map(item => ({ value: item, label: serviceLabel(item) }))} />
            </label>
            <label>{t("lab.step3.operation")}
              <LabSelect value={operation} label={t("lab.step3.operation")}
                disabled={disabled}
                onValueChange={value => setOperation(value as Operation)}
                options={OPERATIONS.map(item => ({ value: item, label: operationLabel(item) }))} />
            </label>
            <label>{t("lab.step3.amount")}<input type="text" inputMode="decimal" required maxLength={8} placeholder={new Intl.NumberFormat(tag).format(650)} value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
            <label>{t("lab.step3.currency")}
              <LabSelect value={currency} label={t("lab.step3.currency")}
                disabled={disabled}
                onValueChange={value => setCurrency(value as OperationRequest["currency"])}
                options={[{ value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }]} />
            </label>
          </div>
          <div className="examples" aria-label={t("lab.step3.examples")}>
            <span>{t("lab.step3.examples")}</span>
            <button type="button" onClick={() => setExample("within")}>{formatMoney(65_000, "USD", tag)}</button>
            <button type="button" onClick={() => setExample("over")}>{formatMoney(120_000, "USD", tag)}</button>
            <button type="button" onClick={() => setExample("other")}>{t("lab.step3.other")}</button>
          </div>
          <div className="step-actions">
            <button className="button primary" type="submit">{busy === "verify" ? <><span className="spinner" /> {t("lab.step3.verifying")}</> : <><Send size={15} aria-hidden="true" /> {t("lab.step3.send")}</>}</button>
            {decision && <a className="button secondary jump-result" href="#verification">{t("lab.step3.result")} <ArrowDown size={14} aria-hidden="true" /></a>}
          </div>
        </fieldset>
      </form>
      {error?.task === "verify" && <p className="form-error" role="alert">{t(error.messageKey)}{error.code && <> (<bdi>Cloudflare {error.code}</bdi>)</>}</p>}
    </Card>
  );
}
