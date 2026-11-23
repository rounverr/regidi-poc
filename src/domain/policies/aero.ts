import type { OperationRequest } from "../../shared/protocol.ts";

export function allowAero(request: OperationRequest): boolean {
  return request.operation === "prepare_booking" && request.amountCents <= 150_000;
}
