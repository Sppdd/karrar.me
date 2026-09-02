# Authentication

Google OAuth 2.0, with the API as the token issuer.

## Why the API owns sessions

This system is a Next.js client, a NestJS API, and a fleet of Temporal workers —
not a Next.js monolith. Auth.js/NextAuth is built for the monolith case; adopting
it here would put session truth in the web app and leave the API verifying a
token it did not issue and cannot revoke.

Instead the API runs the whole flow:

```
client  → GET /auth/google
              API builds the Google authorization URL (PKCE + state + nonce)
        → Google consent screen
        → GET /auth/google/callback
              API exchanges the code, verifies the ID token against Google's JWKS,
              upserts user + identity, issues its own session,
              sets an httpOnly cookie, redirects into the app
```

The client never handles a Google token. It holds a session cookie the API
issued and can revoke.

## Build it, don't buy it

Google-only OAuth against a Postgres you already run is roughly 200 lines using
[`openid-client`](https://github.com/panva/node-openid-client), which is a
certified OIDC implementation and handles PKCE, JWKS rotation, and ID-token
validation correctly — the three things hand-rolled OAuth gets wrong.

Clerk and WorkOS are good products, and the argument against them is specific
rather than ideological: a per-MAU fee lands directly on margins already
compressed by per-second generation costs, and they add a data-residency
question for an Iraq-first user base. You also need the `users` row in your own
Postgres regardless, because the credit ledger has a foreign key to it.

Revisit if enterprise SSO/SAML demand appears. That is genuinely worth buying.

## Tables

Adds to the data model in [04-cost-and-data.md](04-cost-and-data.md#data-model):

| Table | Notes |
| :-- | :-- |
| `identities` | `(provider, provider_user_id)` unique → `user_id`. One row per linked login method |
| `sessions` | Hashed refresh token, device metadata, revocation timestamp |

**Keep `identities` separate from `users` from day one.** It costs nothing now
and it is what makes the phone-auth addition below an insert rather than a
migration. Never key a user on Google's `sub` in the `users` table directly.

## Phone auth is the more native Iraqi pattern

Google OAuth is a defensible primary for an Iraq-first product — Android
dominance means Google account penetration is high.

But Iraqi digital identity is overwhelmingly **phone-number based**. Every wallet
in [07-payments.md](07-payments.md) is keyed on a phone number, and a user who
tops up with ZainCash or FastPay has already proven control of one.

Ship Google in Phase 1. Plan phone/OTP for Phase 3 as a second row in
`identities` — and note the real payoff: matching a wallet's phone number to an
account removes friction at top-up time, which is the moment you least want it.

## Security requirements

Not optional, and each one prevents a specific attack:

- **PKCE** on every flow — authorization code interception.
- **`state` parameter** — CSRF on the callback.
- **`nonce`** — ID token replay.
- **Verify the ID token against Google's JWKS.** Decoding it and trusting the
  claims is the single most common OAuth implementation bug.
- **Trust `email_verified`, not `email`.** An unverified Google email is not
  proof of address ownership.
- **Cookies**: httpOnly, Secure, SameSite=Lax.
- **Refresh token rotation with reuse detection.** A replayed refresh token means
  the token was stolen; revoke the whole session family.
- Short-lived access tokens, long-lived rotating refresh tokens.

Temporal workers never carry a user session. They authenticate service-to-service
and receive `org_id` as workflow input — a workflow must never be able to widen
its own tenancy scope.

## Org bootstrapping

First login creates a personal `org` plus an owner membership. Tenancy already
exists in the data model; this is just the write path for it.

Invitations, team seats, and Google Workspace domain capture (the `hd` claim)
are Phase 4.
