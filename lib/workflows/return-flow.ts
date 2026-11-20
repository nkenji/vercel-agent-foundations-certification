/**
 * Durable return workflow.
 *
 * Started from the `returnOrder` tool with `start()`, so the chat does not wait
 * for it. Each side effect is its own `"use step"`, so a retried run only
 * re-runs steps that have not completed. A completed notification or refund
 * pre-authorisation is never sent or created again.
 *
 * Steps that call the store API throw `FatalError` on a 4xx response (for
 * example, an order that cannot be returned), which stops the run without
 * retrying. Transient failures (5xx, network) are retried by the runtime.
 */
import { FatalError } from "workflow";
import {
  createReturn,
  notifyReturnInProcess,
  preauthorizeRefund,
  ApiRequestError,
} from "@/lib/api";

export interface ReturnFlowInput {
  orderId: string;
  reason: string;
  items: { productId: string; quantity: number }[];
}

export interface ReturnFlowResult {
  orderId: string;
  notified: true;
  refundPreauthorizationId: string;
  returnId: string;
  returnStatus: string;
}

/** Converts store 4xx responses into FatalError so the step is not retried. */
function fatalOn4xx(err: unknown): never {
  if (err instanceof ApiRequestError && err.status >= 400 && err.status < 500) {
    throw new FatalError(`Store rejected the request (HTTP ${err.status}).`);
  }
  throw err;
}

async function notifyCustomerStep(orderId: string) {
  "use step";
  try {
    await notifyReturnInProcess(orderId);
  } catch (err) {
    fatalOn4xx(err);
  }
  return { notified: true as const };
}

async function preauthorizeRefundStep(orderId: string) {
  "use step";
  try {
    const auth = await preauthorizeRefund(orderId);
    return {
      id: auth.id,
      amount: auth.amount,
      currency: auth.currency,
      status: auth.status,
    };
  } catch (err) {
    fatalOn4xx(err);
  }
}

async function fileReturnStep(input: ReturnFlowInput) {
  "use step";
  try {
    const ret = await createReturn({
      orderId: input.orderId,
      items: input.items,
      reason: input.reason,
    });
    return { id: ret.id, status: ret.status };
  } catch (err) {
    fatalOn4xx(err);
  }
}

export async function returnFlow(input: ReturnFlowInput): Promise<ReturnFlowResult> {
  "use workflow";

  await notifyCustomerStep(input.orderId);
  const auth = await preauthorizeRefundStep(input.orderId);
  const ret = await fileReturnStep(input);

  return {
    orderId: input.orderId,
    notified: true,
    refundPreauthorizationId: auth.id,
    returnId: ret.id,
    returnStatus: ret.status,
  };
}
