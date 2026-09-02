import type { Money } from '@vidgen/shared';

/**
 * The payment gateway interface. See docs/07-payments.md.
 *
 * Mirrors VideoProvider in @vidgen/providers, for the same reason and one more:
 * no single Iraqi wallet has enough market share to be the only checkout, so an
 * adapter layer is forced rather than merely prudent. Wayl fronts the local
 * wallets today; adding FIB direct later must be a new adapter, not a refactor.
 */

export interface PaymentCapabilities {
  readonly wallets: boolean;
  readonly cards: boolean;
  /** Cards issued outside Iraq - the international on-ramp. */
  readonly internationalCards: boolean;
  readonly refunds: boolean;
  /** Card-on-file recurring. False across Iraqi wallets, which is why billing
   *  is prepaid credit top-ups rather than subscriptions. */
  readonly recurring: boolean;
  readonly currencies: readonly string[];
}

export interface ChargeRequest {
  /** Our payments.reference_id. Sent as the gateway's idempotency handle. */
  readonly referenceId: string;
  readonly amount: Money;
  readonly description?: string;
  readonly webhookUrl: string;
  readonly redirectUrl: string;
}

export interface ChargeCreated {
  readonly redirectUrl: string;
  readonly gatewayRef: string;
  readonly status: ChargeState;
}

export type ChargeState = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';

export interface WebhookEvent {
  /** Gateway's own event identity, for at-least-once dedupe. */
  readonly eventId: string;
  readonly referenceId: string;
  readonly status: ChargeState;
  readonly gatewayRef?: string;
  readonly amountMinor?: bigint;
  readonly currency?: string;
}

export interface PaymentProvider {
  readonly id: string;
  capabilities(): PaymentCapabilities;
  createCharge(req: ChargeRequest): Promise<ChargeCreated>;
  /** Verifies the signature over the RAW body and parses. Throws on mismatch. */
  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>): WebhookEvent;
  /** Authoritative pull. The reconciliation and missed-webhook path. */
  getStatus(referenceId: string): Promise<ChargeState>;
  refund(referenceId: string, amount: Money, reason: string): Promise<void>;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

export class PaymentConfigError extends Error {
  constructor(providerId: string, message: string) {
    super(`[${providerId}] ${message}`);
    this.name = 'PaymentConfigError';
  }
}
