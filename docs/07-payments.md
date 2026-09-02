# Payments

**Constraint first: [Stripe does not operate in Iraq](https://stripe.com/global),
and by the Trade Bank of Iraq's own account it is years away.** Every default
SaaS billing assumption has to be rebuilt.

Decisions taken: an **Iraqi legal entity**, **Iraq-first customers**, **prepaid
credit top-ups**, and **Wayl** (`wayl.io`) as the launch rail.

Wayl is an Iraqi payment aggregator and merchant of record — "Stripe for Iraq" —
with a Visa partnership and a Feb 2026 MoneyHash partnership. It fronts the
local wallets through its **channels** concept, so one integration replaces
three, with one reconciliation surface and one merchant onboarding instead of
three separate CBI-regulated KYC processes.

Integration is **server-to-server REST**, not CMS plugins. The WordPress and Woo
plugins in this ecosystem are irrelevant here.

## Why prepaid credits are correct, not a compromise

Iraqi wallets are **one-shot redirect flows**. Card-on-file recurring mandates
are not reliably available, so a monthly subscription auto-charge is not a thing
you can build on this rail.

That sounds like a limitation until you notice
[04-cost-and-data.md](04-cost-and-data.md#cost-engine) already specified an
append-only, double-entry credit ledger for entirely unrelated reasons — you
need reserve/settle/refund semantics because generation costs real money per
call and jobs fail halfway.

The payment constraint and the cost engine want the same object. Build it once.

## The gateway adapter layer

Mirror the `VideoProvider` interface from
[01-architecture.md](01-architecture.md#provider-adapter-layer). Here it is
forced rather than merely wise: **no single Iraqi wallet has enough market share
to be the only checkout**, and real deployments ship two to three.

```ts
interface PaymentProvider {
  readonly id: string;                     // 'fib' | 'zaincash' | 'qicard'

  /** wallet? cards? 3DS? refunds? internationally-issued cards? */
  capabilities(): PaymentCapabilities;

  /** Server-to-server. Returns the URL to send the user to. */
  createCharge(req: ChargeRequest): Promise<{ redirectUrl: string; ref: string }>;

  /** Signature verification over the RAW body. Never parse before verifying. */
  verifyWebhook(raw: Buffer, headers: Headers): WebhookEvent;

  /** Authoritative pull — the reconciliation and missed-webhook path. */
  getStatus(ref: string): Promise<ChargeStatus>;

  refund(ref: string, amount: Money): Promise<RefundResult>;
}
```

### The Wayl contract

| | |
| :-- | :-- |
| Auth | `X-WAYL-AUTHENTICATION` header |
| Create link | `referenceId`, `total`, `currency: 'IQD'`, `lineItem[]`, `webhookUrl`, `webhookSecret`, `redirectionUrl` |
| Response | checkout URL, payment code, status, timestamps |
| Statuses | `Created`, `Pending`, then paid/failed states |
| Webhook | POST JSON, `x-wayl-signature-256` = HMAC-SHA256 over the **raw** body |
| Endpoints | links (create/all/find/invalidate/batch), refunds (create/cancel), subscriptions, products, channels |

Three things make it a clean fit. `referenceId` is a natural **idempotency
key**, so the double-charge protection this doc requires is already in the wire
protocol. HMAC over the raw body is exactly the shape `verifyWebhook(raw,
headers)` was designed for. And it is **IQD-native**.

**⚠ The contract above is assembled from secondary sources**, not read from the
official reference — `wayl.io` and `api.thewayl.com` were unreachable from the
environment this was written in. Confirm against `api.thewayl.com/reference` and
a sandbox key before go-live.

### Fallbacks, if Wayl concentration becomes a problem

Wayl is a **single point of failure for all revenue**, it adds a fee layer, and
it is a young company (pre-seed 2024) sitting in the payment path. That is a
real risk accepted deliberately, in exchange for one integration instead of
three. The mitigation is that the adapter interface stays, so adding a direct
gateway later is a new adapter rather than a refactor:

| Gateway | Why | If needed |
| :-- | :-- | :-- |
| **FIB** | Best direct developer surface: REST, OAuth2 client credentials, sandbox, maintained Node/Python/PHP SDKs | First fallback |
| **ZainCash** | Largest wallet reach. v2 API: OAuth2, redirect flow, webhooks, refunds | Second |
| **Qi Card** | REST + webhooks + 3DS, accepts cards issued **inside and outside** Iraq | International on-ramp |

## Top-up flow

```
user picks a credit pack
  → API creates `payments` row (pending)
  → adapter.createCharge()  → redirectUrl
  → user pays in the wallet app
  → gateway webhook → verifyWebhook() → credit the ledger (settled)
  → client learns the new balance via SSE
```

### The rule that must not be broken

**Never credit the ledger on the browser redirect return.**

That return is a UX hint, not proof of payment. It is trivially forgeable — a
user can simply visit the success URL — and it is the most common way payment
integrations get robbed. Credit only on a signature-verified webhook, or on an
explicit `getStatus()` confirmation pulled from the gateway.

Webhooks are at-least-once and can arrive out of order. Store
`payment_webhook_events` keyed on the gateway's own event ID and make processing
idempotent — the same discipline the generation path already applies with
idempotency keys, for the same reason. A dropped webhook must not strand a
payment: a reconciliation sweep calls `getStatus()` on anything still pending
past a threshold.

## FX is real exposure, and the ledger must model it

Revenue is **IQD**. Provider costs are **USD**. That gap is unhedged currency
risk sitting directly on the margin.

The mitigation is already half-built: **credits are the internal unit**, decoupled
from both currencies. A user buys credits at an IQD rate pinned at purchase time
and spends them at a fixed credit cost per generation. Drift between purchase and
spend is absorbed by the margin buffer rather than repriced at a user mid-project.

Implementation rules:

- Money is `bigint` **minor units** with an explicit currency column. Never a float.
- **Confirm the minor-unit convention per gateway during integration.** ISO 4217
  assigns IQD three decimal places (fils), while gateways in practice transact in
  whole dinars. Assuming the wrong one is a 1000× error in the direction of
  giving money away. Pin this against sandbox behaviour before going live.
- Record the pinned FX rate on the `payments` row, so every credit issued is
  traceable to the rate it was sold at.

## Reconciliation

Nightly, against gateway settlement reports — the same discipline
[04-cost-and-data.md](04-cost-and-data.md#cost-engine) prescribes for provider
invoices. Two sums must agree: credits issued in the ledger, and settlements
received from the gateway.

A gap is either a missed webhook or a bug. Both are urgent, and you will not
notice either without this job.

## Compliance and onboarding

Merchant wallet onboarding is KYC'd under Central Bank of Iraq regulation.
Expect to supply: Chamber of Commerce certificate or certificate of practicing
the profession, commercial lease or title deed, business owner ID, and the
merchant bank account.

**Commercial terms — fees, commission rates, settlement times — are not reliably
published.** Get them in writing from Wayl during onboarding; do not plan
margins against a number from a blog post. As an aggregator, Wayl's take sits on
top of the underlying wallet's, so the effective rate is what matters.

Cash on delivery dominates Iraqi e-commerce generally but is **not applicable
here** — the product is delivered by API the moment credits are spent. Worth
stating so nobody builds for it.

Sanctions screening becomes relevant only on international expansion, which is
the Qi Card phase.
