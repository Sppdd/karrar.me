# Payments

**Constraint first: [Stripe does not operate in Iraq](https://stripe.com/global),
and by the Trade Bank of Iraq's own account it is years away.** Every default
SaaS billing assumption has to be rebuilt.

Decisions taken: an **Iraqi legal entity** integrating **local gateways
directly**, for **Iraq-first customers**, on **prepaid credit top-ups**.

Integration is **server-to-server REST**, not hosted checkout widgets or CMS
plugins. Each gateway publishes a REST API — FIB and ZainCash both authenticate
with OAuth2 client credentials, and FIB maintains official Node and Python SDKs.
Those are the integration surface; the WordPress and Woo plugins in the
ecosystem are irrelevant here.

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

### Launch set

| Gateway | Why | When |
| :-- | :-- | :-- |
| **FIB** | Best developer surface: REST, OAuth2 client credentials, sandbox, maintained Node/Python/PHP SDKs, create/status/refund/cancel plus callbacks | Phase 1 |
| **ZainCash** | Largest wallet reach. v2 API: OAuth2, redirect flow, webhooks, refunds | Phase 2 |
| **Qi Card** | REST + webhooks + 3DS, and accepts cards issued **inside and outside** Iraq — this is the international on-ramp | Phase 3 |

Orchestrators (Rasedi, VeePay) front all the local wallets behind a single API.
The honest tradeoff: one integration instead of three, at the cost of an added
fee layer and a hard dependency on a young intermediary. Integrate two gateways
directly; revisit an orchestrator only if adapter maintenance becomes the actual
bottleneck rather than a hypothetical one.

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
published.** Get them in writing per gateway during onboarding; do not plan
margins against a number from a blog post.

Cash on delivery dominates Iraqi e-commerce generally but is **not applicable
here** — the product is delivered by API the moment credits are spent. Worth
stating so nobody builds for it.

Sanctions screening becomes relevant only on international expansion, which is
the Qi Card phase.
