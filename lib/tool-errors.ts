/**
 * Shared error mapping for agent tools.
 *
 * Converts an upstream store API error into a structured result the model can
 * explain. 404 becomes `not_found`; other 4xx become `rejected`. Anything else
 * (5xx, network) is rethrown so the surrounding step retries it.
 */
import { ApiRequestError } from "@/lib/api";

export type ClientFailure =
  | { status: "not_found"; message: string }
  | { status: "rejected"; message: string };

export function clientFailure(err: unknown): ClientFailure {
  if (err instanceof ApiRequestError) {
    if (err.status === 404) {
      return { status: "not_found", message: "No matching record was found." };
    }
    if (err.status >= 400 && err.status < 500) {
      return {
        status: "rejected",
        message: "The store rejected this request. Check the input and try again.",
      };
    }
  }
  throw err;
}
