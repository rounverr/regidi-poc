import type { IssuerConfig } from "../domain/issuer.ts";
import type { LabStore } from "../persistence/store.ts";

export interface Challenge {
  verify(token: string): Promise<void>;
  issue?(): string;
}

export interface LabRuntime {
  issuer: IssuerConfig;
  store: LabStore;
  challenge: Challenge;
  consumeRateLimit(key: string, weight: number): Promise<boolean>;
  clientAddress?: string | undefined;
  publicOrigin?: string;
}
