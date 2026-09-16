# server/integrations — other people's APIs

Everything that leaves our process for a third party. Two modules today: `notify.ts`
(Telegram, MAX, email) and `notify.i18n.ts` (the message texts).

⚠️ **`server/domain` must not import this directory** — enforced by `dependency-cruiser`.
Business rules that know a specific provider spread that provider through the codebase,
and there will be several acquirers and fiscalization providers. The domain writes an
`outbox` row; this layer decides how it travels.

## The delivery chain

```
domain writes outbox row  →  worker picks it up  →  notify.ts sends
                                                    telegram → max → email
```

`pickChannel(recipient)` chooses: a messenger if the customer linked one, email otherwise.
On failure it **falls back to email** rather than dropping the message — a booking
confirmation that silently never arrived is worse than one in the wrong channel.

⚠️ **Nothing here is called from a request handler.** External effects go through the
`outbox` table (see `domain/core/outbox.ts`): a failing gateway would otherwise fail the
booking, and sending before COMMIT mails people about orders that do not exist.

⚠️ **At-least-once delivery.** The worker retries with backoff, so a handler may run twice
on the same row. Every handler must be idempotent — the same message can be sent twice and
must not, for instance, charge twice.

## Texts are data, not string literals

`notify.i18n.ts` holds message texts **with a version and a language**. Two reasons, and
the second is legal: a tenant may need to prove what exactly the customer was told, and a
text inlined in code cannot be dated. Changing wording means a new version, not an edit.

## When a new provider arrives

**An adapter is mandatory at every external boundary: their DTO → our domain.** Not a
convenience — the point is that swapping an acquirer must not ripple through the domain.

⚠️ Today `paymentProvider` and `fiscalProvider` in `runtimeConfig` are `'stub'`, and
`smsProvider` is `'none'`: **no acquiring, fiscalization or SMS adapter exists yet**
(TODO 17.1–17.3, 17.24.1). The admin screen reads those values only to show whether
something is configured. Do not read the presence of the config keys as the presence of an
integration.

When writing the first one:

- map their payload into our types **here**, at the edge; the domain sees only our shapes;
- webhooks must be **idempotent and signature-checked** — a retried callback must not
  create a second payment;
- money stays `numeric`/string end to end. Their JSON number is a float, and a float is
  how cents disappear.
