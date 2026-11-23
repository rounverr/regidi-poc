import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { closeSession, createAgent, createDelegation, revokeDelegation, sendOperation } from "../api/client";
import { LocalizedError } from "../i18n/index";
import type { MessageKey } from "../i18n/locales/en";
import { MAX_AMOUNT_CENTS, type Decision, type Delegation, type Operation, type OperationRequest, type Scope, type Service, type Session } from "../shared/protocol";
import { prepareAgentChallenge } from "../api/browser-challenge";

type Task = "agent" | "grant" | "revoke" | "verify" | "reset";
const defaultOperation: Record<Service, Operation> = { aero: "prepare_booking", bank: "prepare_transfer" };
export const historyLimit = 30;

function parseCents(value: string): number | null {
  const normalized = value.trim()
    .replace(/[٠-٩۰-۹०-९]/g, digit => {
      const zero = digit >= "०" ? "०" : digit >= "۰" ? "۰" : "٠";
      return String(digit.charCodeAt(0) - zero.charCodeAt(0));
    })
    .replace("٫", ".");
  const match = /^(\d{1,5})(?:[.,](\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return cents > 0 && cents <= MAX_AMOUNT_CENTS ? cents : null;
}

export function useLab() {
  const [session, setSession] = useState<Session | null>(null);
  const key = useRef<CryptoKey | null>(null);
  const [grant, setGrant] = useState<Delegation | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState<Task | null>(null);
  const pending = useRef(false);
  const [error, setError] = useState<{ task: Task; messageKey: MessageKey; code?: string } | null>(null);
  const [grantService, setGrantService] = useState<Service>("aero");
  const [grantOperation, setGrantOperation] = useState<Operation>("prepare_booking");
  const [maxAmount, setMaxAmount] = useState("800");
  const [duration, setDuration] = useState<Scope["durationSeconds"]>(300);
  const [service, setService] = useState<Service>("aero");
  const [operation, setOperation] = useState<Operation>("prepare_booking");
  const [amount, setAmount] = useState("650");
  const [currency, setCurrency] = useState<OperationRequest["currency"]>("USD");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [history, setHistory] = useState<Decision[]>([]);
  const challengeContainer = useRef<HTMLDivElement>(null);
  const sessionExpired = session !== null && now >= session.expiresAt;
  const grantExpired = grant !== null && now >= grant.expiresAt;

  useEffect(() => {
    if (!session && busy !== "reset" && challengeContainer.current) {
      // Prepare the invisible challenge before the visitor clicks "Create agent".
      prepareAgentChallenge(challengeContainer.current);
    }
  }, [session, busy]);

  useEffect(() => {
    const nextExpiry = [session?.expiresAt, grant?.expiresAt]
      .filter((timestamp): timestamp is number => timestamp !== undefined && timestamp > now)
      .sort((a, b) => a - b)[0];
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(() => setNow(Math.floor(Date.now() / 1000)),
      Math.max(0, nextExpiry * 1000 - Date.now()) + 25);
    return () => window.clearTimeout(timer);
  }, [session?.expiresAt, grant?.expiresAt, now]);

  async function run(task: Task, action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(task);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof LocalizedError
        ? { task, messageKey: cause.messageKey, code: cause.code }
        : { task, messageKey: "lab.error.action" });
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  async function startAgent(container: HTMLDivElement) {
    const created = await createAgent(container);
    key.current = created.privateKey;
    setNow(Math.floor(Date.now() / 1000));
    setSession(created.session);
  }

  function begin() {
    void run("agent", async () => {
      if (!challengeContainer.current) return;
      await startAgent(challengeContainer.current);
    });
  }

  function selectGrantService(value: Service) {
    setGrantService(value);
    setGrantOperation(defaultOperation[value]);
  }

  function selectService(value: Service) {
    setService(value);
    setOperation(defaultOperation[value]);
  }

  function issue(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    void run("grant", async () => {
      const maxAmountCents = parseCents(maxAmount);
      if (maxAmountCents === null) throw new LocalizedError("lab.error.max");
      const issued = await createDelegation(session, { service: grantService, operation: grantOperation, maxAmountCents, durationSeconds: duration });
      setGrant(issued);
      setSession({ ...session, expiresAt: issued.expiresAt });
      setRevoked(false);
      setNow(Math.floor(Date.now() / 1000));
      setService(grantService);
      setOperation(grantOperation);
      setCurrency("USD");
    });
  }

  function revoke() {
    if (!session || !grant) return;
    void run("revoke", async () => {
      await revokeDelegation(session, grant.id);
      setRevoked(true);
    });
  }

  function send(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !grant || !key.current) return;
    const signingKey = key.current;
    void run("verify", async () => {
      const amountCents = parseCents(amount);
      if (amountCents === null) throw new LocalizedError("lab.error.amount");
      const result = await sendOperation(session, signingKey, grant.credential, { service, operation, amountCents, currency });
      setDecision(result);
      setHistory((entries) => [result, ...entries].slice(0, historyLimit));
    });
  }

  function reset() {
    if (!session) return;
    void run("reset", async () => {
      await closeSession(session);
      key.current = null;
      setSession(null);
      setGrant(null);
      setRevoked(false);
      setDecision(null);
      setHistory([]);
      setNow(0);
      setGrantService("aero");
      setGrantOperation("prepare_booking");
      setMaxAmount("800");
      setDuration(300);
      setService("aero");
      setOperation("prepare_booking");
      setAmount("650");
      setCurrency("USD");
      if (!challengeContainer.current) throw new LocalizedError("lab.error.restart");
      await startAgent(challengeContainer.current);
    });
  }

  function setExample(example: "within" | "over" | "other") {
    if (!grant) return;
    const receivingService = example === "other" ? (grant.service === "aero" ? "bank" : "aero") : grant.service;
    setService(receivingService);
    setOperation(example === "other" ? defaultOperation[receivingService] : grant.operation);
    setAmount(example === "over" ? "1200" : "650");
    setCurrency("USD");
  }


  return {
    session, busy, sessionExpired, challengeContainer, error, begin, reset,
    decision, history, setDecision,
    delegation: {
      session, sessionExpired, grant, revoked, grantExpired, busy, error,
      grantService, grantOperation, maxAmount, duration,
      selectGrantService, setGrantOperation, setMaxAmount, setDuration, issue, revoke,
    },
    verification: {
      sessionExpired, grant, busy, error, decision,
      service, operation, amount, currency,
      selectService, setOperation, setAmount, setCurrency, send, setExample,
    },
  };
}
