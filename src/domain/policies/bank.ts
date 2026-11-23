import type { OperationRequest } from "../../shared/protocol.ts";

export function allowBank(request: OperationRequest): boolean {
  // Only a transfer draft is allowed, even if the credential grants confirmation.
  return request.operation === "prepare_transfer" && request.amountCents <= 50_000;
}
