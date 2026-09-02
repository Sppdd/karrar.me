import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Money } from '@vidgen/shared';
import {
  type ChargeCreated,
  type ChargeRequest,
  type ChargeState,
  PaymentConfigError,
  type PaymentCapabilities,
  type PaymentProvider,
  type WebhookEvent,
  WebhookVerificationError,
} from './types.ts';

/**
 * Wayl (wayl.io) - Iraqi payment aggregator and merchant of record.
 *
 * Fronts the local wallets (ZainCash, FIB, Qi Card, FastPay) through its
 * "channels" concept, so one integration replaces three separate merchant
 * onboardings, each with its own CBI-regulated KYC.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WIRE FORMAT IS UNVERIFIED.
 *
 * wayl.io, api.thewayl.com and the official reference are all unreachable from
 * the environment this was written in, so the contract below is assembled from
 * search results and a third-party PHP client - not read from the docs. The
 * mapping is isolated in #toCreateBody / #parseEvent / #mapStatus so correcting
 * it is a small, contained edit.
 *
 * Confirm against api.thewayl.com/reference and a sandbox key before go-live.
 * Specifically confirm:
 *   1. whether `total` is whole IQD or minor units  <- see the note on amount()
 *   2. the exact webhook JSON field names and status vocabulary
 *   3. the event-identity field used for dedupe
 *   4. whether the signature covers the raw body alone or a timestamp prefix
 * ─────────────────────────────────────────────────────────────────────────────
 */
const BASE = 'https://api.thewayl.com';

export interface WaylOptions {
  readonly apiKey?: string;
  readonly webhookSecret?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export class WaylProvider implements PaymentProvider {
  readonly id = 'wayl';
  readonly #apiKey: string | undefined;
  readonly #webhookSecret: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(opts: WaylOptions = {}) {
    this.#apiKey = opts.apiKey ?? process.env.WAYL_API_KEY;
    this.#webhookSecret = opts.webhookSecret ?? process.env.WAYL_WEBHOOK_SECRET;
    this.#baseUrl = opts.baseUrl ?? BASE;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  capabilities(): PaymentCapabilities {
    return {
      wallets: true,
      cards: true,
      // Wayl has a Visa partnership; confirm the acquiring scope during onboarding.
      internationalCards: true,
      refunds: true,
      // Hosted checkout is redirect-based and one-shot. Wayl exposes subscription
      // READ endpoints but no create in the clients seen, so recurring is a later
      // investigation, not a launch assumption.
      recurring: false,
      currencies: ['IQD'],
    };
  }

  async createCharge(req: ChargeRequest): Promise<ChargeCreated> {
    const res = await this.#request<WaylLink>('POST', '/links', this.#toCreateBody(req));
    const url = res.data?.url ?? res.url;
    const ref = res.data?.paymentCode ?? res.paymentCode ?? res.data?.id ?? res.id;
    if (!url || !ref) {
      throw new Error(`wayl: create returned no checkout url or reference: ${JSON.stringify(res)}`);
    }
    return {
      redirectUrl: url,
      gatewayRef: ref,
      status: mapStatus(res.data?.status ?? res.status),
    };
  }

  /**
   * Verifies `x-wayl-signature-256` (HMAC-SHA256) over the RAW body.
   *
   * The body must arrive as the exact bytes received. Parsing JSON and
   * re-serializing before verifying changes key order and whitespace, breaks the
   * HMAC, and is a well-worn way to end up either rejecting valid webhooks or -
   * if someone then "fixes" it by skipping verification - accepting forged ones.
   */
  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>): WebhookEvent {
    if (!this.#webhookSecret) {
      throw new PaymentConfigError(this.id, 'missing WAYL_WEBHOOK_SECRET; cannot verify webhooks');
    }

    const provided = header(headers, 'x-wayl-signature-256');
    if (!provided) throw new WebhookVerificationError('missing x-wayl-signature-256 header');

    const expected = createHmac('sha256', this.#webhookSecret).update(raw).digest('hex');
    // Strip an optional "sha256=" prefix; some gateways send it, some do not.
    const got = provided.startsWith('sha256=') ? provided.slice(7) : provided;

    const a = Buffer.from(got, 'hex');
    const b = Buffer.from(expected, 'hex');
    // Length check first: timingSafeEqual throws on a length mismatch rather
    // than returning false.
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new WebhookVerificationError('signature mismatch');
    }

    return this.#parseEvent(raw);
  }

  async getStatus(referenceId: string): Promise<ChargeState> {
    const res = await this.#request<WaylLink>(
      'GET',
      `/links/${encodeURIComponent(referenceId)}`,
    );
    return mapStatus(res.data?.status ?? res.status);
  }

  async refund(referenceId: string, amount: Money, reason: string): Promise<void> {
    await this.#request('POST', '/refunds', {
      referenceId,
      amount: amountToGatewayUnits(amount),
      reason,
    });
  }

  // --- provider-specific mapping; verify against live docs -------------------

  #toCreateBody(req: ChargeRequest): Record<string, unknown> {
    return {
      referenceId: req.referenceId,
      total: amountToGatewayUnits(req.amount),
      currency: req.amount.currency,
      webhookUrl: req.webhookUrl,
      redirectionUrl: req.redirectUrl,
      ...(this.#webhookSecret ? { webhookSecret: this.#webhookSecret } : {}),
      ...(req.description ? { lineItem: [{ name: req.description, quantity: 1 }] } : {}),
    };
  }

  #parseEvent(raw: Buffer): WebhookEvent {
    const body = JSON.parse(raw.toString('utf8')) as WaylWebhookBody;
    const referenceId = body.referenceId ?? body.data?.referenceId;
    if (!referenceId) throw new WebhookVerificationError('webhook has no referenceId');

    // Fall back to the reference plus status when no event id is supplied, so
    // dedupe still has a key. Confirm the real field and drop this.
    const status = body.status ?? body.data?.status;
    const eventId = body.eventId ?? body.id ?? `${referenceId}:${status ?? 'unknown'}`;

    const amount = body.total ?? body.data?.total;
    return {
      eventId,
      referenceId,
      status: mapStatus(status),
      ...(body.paymentCode ? { gatewayRef: body.paymentCode } : {}),
      ...(amount !== undefined ? { amountMinor: BigInt(amount) } : {}),
      ...(body.currency ? { currency: body.currency } : {}),
    };
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.#apiKey) {
      throw new PaymentConfigError(
        this.id,
        'missing WAYL_API_KEY. Set it in .env, or inject a fetchImpl in tests.',
      );
    }
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'X-WAYL-AUTHENTICATION': this.#apiKey,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`wayl ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }
}

/**
 * Amount in the units the gateway expects.
 *
 * ⚠ ISO 4217 assigns IQD three decimal places (fils), but Iraqi gateways
 * transact in whole dinars, and Wayl's documented example (`total: 10000` with
 * `currency: 'IQD'`) is consistent with whole dinars. Getting this backwards is
 * a 1000x error in the direction of giving money away, so it is asserted here
 * rather than assumed anywhere else, and MUST be confirmed in sandbox.
 */
export function amountToGatewayUnits(amount: Money): number {
  if (amount.currency !== 'IQD') {
    throw new RangeError(`wayl settles in IQD, got ${amount.currency}`);
  }
  // Money carries micro-units; IQD amounts are whole dinars, so a fractional
  // dinar is a bug upstream rather than something to silently round away.
  if (amount.micros % 1_000_000n !== 0n) {
    throw new RangeError(`IQD amount must be whole dinars, got ${amount.micros} micros`);
  }
  return Number(amount.micros / 1_000_000n);
}

function mapStatus(raw: string | undefined): ChargeState {
  switch (raw?.toLowerCase()) {
    case 'paid':
    case 'completed':
    case 'success':
    case 'successful':
      return 'paid';
    case 'failed':
    case 'declined':
      return 'failed';
    case 'expired':
    case 'invalidated':
    case 'cancelled':
      return 'expired';
    case 'refunded':
      return 'refunded';
    case 'created':
    case 'pending':
    default:
      // Unknown states stay pending rather than being guessed into a terminal
      // one: the reconciliation sweep will resolve them via getStatus, whereas
      // a wrong "paid" hands out credits for nothing.
      return 'pending';
  }
}

const header = (h: Record<string, string | undefined>, name: string): string | undefined =>
  h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()];

interface WaylLink {
  readonly id?: string;
  readonly url?: string;
  readonly paymentCode?: string;
  readonly status?: string;
  readonly data?: {
    readonly id?: string;
    readonly url?: string;
    readonly paymentCode?: string;
    readonly status?: string;
  };
}

interface WaylWebhookBody {
  readonly eventId?: string;
  readonly id?: string;
  readonly referenceId?: string;
  readonly status?: string;
  readonly paymentCode?: string;
  readonly total?: number | string;
  readonly currency?: string;
  readonly data?: {
    readonly referenceId?: string;
    readonly status?: string;
    readonly total?: number | string;
  };
}
