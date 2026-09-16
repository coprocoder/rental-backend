# CLAUDE.md — rental-backend

The extracted backend of `../rental/`: a standalone Node service (Fastify + Postgres).
**Migration in progress** — the Nuxt app still serves production; this service is being
built endpoint by endpoint against a captured baseline.

Instructions in English because this file loads on every call; **plans, comments, docs and
TODO stay Russian**.

## ⚠️ Rule 0 — privacy

**Personal side project on a corporate Team account. Never publish, never send anything
outside.**

- **never call the Artifact tool** here — not publish, not update, not read;
- **never push** to corporate hosting (company GitHub / GitVerse);
- do not mention this project in work contexts.

⚠️ **Subagents do NOT inherit this.** Put the artifact ban in every subagent prompt as
explicit text. It has already failed once.

## Layers

Dependencies point down only, enforced by `npm run arch` — nine rules, and they are the
reason the structure survives contact with deadlines.

```
transport   HTTP: маршрут, разбор запроса, код ответа, заголовки
    ↓
usecase     сценарий целиком  ← ЗДЕСЬ открывается транзакция, ровно один раз
    ↓
domain      правила: цены, наличие, подбор, переходы статусов
    ↓
gateway     SQL
    ↓
kernel      пул, тенантный контекст, часы, журнал, outbox, ошибки
```

`shared/` sits beside them: types and pure functions shared with the frontend, no
dependencies of its own (`shared-is-leaf`).

⚠️ **The transaction belongs to usecase.** `domain` and `gateway` receive a ready
`PoolClient` and never open their own. The rule exists because the Nuxt catalog read
through six separate transactions — six independent snapshots, between which the stock
could change.

⚠️ **`Ctx` carries `tenantId`, `actor`, `correlationId` — never a request object.** As soon
as HTTP reaches usecase, the scenario stops being callable from the worker, a test, or the
counter's future mobile app.

## Modules

Vertical slices in `src/modules/<name>/` with `transport/ usecase/ domain/ gateway/` inside
and **one** `<name>.public.ts` facade outside. Nine planned (`plans/01-МОДУЛИ.md`); ported
so far: `catalog`, `pricing`.

⚠️ **Write-ownership, read-freedom.** The textbook rule "each module owns its tables" was
measured against this schema and does not hold: `category` is read by 9 areas,
`inventory_variant` by 8. Forbidding reads turns every price calculation into a chain of
facade calls inside one transaction — a slow way to write a `JOIN`. **Writing** is what is
restricted: two writers means two places where a rule lives, and they diverge. `capacity`
in `pool_day` was written from six places, and they did.

## Adding an endpoint

Six steps, in `plans/03-API.md`. The short version: valibot schema at the boundary →
route → `Ctx` → usecase → explicit response shape.

⚠️ **The schema is not optional.** Fastify validates *responses*, never request bodies.
⚠️ **Normalisation lives in the schema**, so a new endpoint cannot forget it: `+7 999…`
and `8999…` unnormalised become two customers, and the booking limit is bypassed by
changing format.
⚠️ **Never return DB rows as they are** — a renamed column then breaks the frontend.

## Migration rules

⚠️ **Every ported endpoint is compared against the baseline byte for byte.** Baselines live
in `../rental/baseline/`, captured from the live Nuxt stand before any change. This is how
the price-rule defect (19.23) was found — a scenario run, not a unit test.

⚠️ **Do not rewrite the domain or the tests.** 10 200 lines of domain and 322 tests move as
they are; that is the main saving of the whole plan. Work that touches them needs a separate
justification.

⚠️ **Both implementations stay alive until the end.** Switching is one env var on the
frontend (`NUXT_PUBLIC_API_BASE`), and so is rolling back.

## Commands

`make help` lists everything. `make check` is what CI runs: typecheck, test, arch.

Requires Postgres from `../rental/docker-compose.yml` (port 55432) — the schema and
migrations still live in the Nuxt repo and are **not** duplicated here.

## Documentation

- `plans/` — design decisions with measured numbers, in reading order (`README.md`);
- `docs/СОСТОЯНИЕ.md` — what is ported and what is not;
- `../rental/server/CLAUDE.md` — how the backend works *today*, inside Nuxt;
- `../rental-docs/` — the product spec. Product reasoning belongs there, not here.

⚠️ **`../rental-docs/docs/05-работы/TODO.md` is the only source of truth about what is
done.** Never add a second progress summary: one already existed, drifted thirty items from
reality, and was believed because it looked authoritative.
