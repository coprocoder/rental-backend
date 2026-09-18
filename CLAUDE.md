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
service     сценарий целиком  ← ЗДЕСЬ открывается транзакция, ровно один раз
    ↓
domain      правила: цены, наличие, подбор, переходы статусов
    ↓
database     SQL
    ↓
kernel      пул, тенантный контекст, часы, журнал, outbox, ошибки
```

`common/` sits beside them: types and pure functions shared with the frontend, no
dependencies of its own (`shared-is-leaf`).

⚠️ **The transaction belongs to service.** `domain` and `database` receive a ready
`PoolClient` and never open their own. The rule exists because the Nuxt catalog read
through six separate transactions — six independent snapshots, between which the stock
could change.

⚠️ **`Ctx` carries `tenantId`, `actor`, `correlationId` — never a request object.** As soon
as HTTP reaches service, the scenario stops being callable from the worker, a test, or the
counter's future mobile app.

## Modules

Vertical slices in `src/modules/<name>/` with `transport/ service/ domain/ database/` inside
and **one** `<name>.public.ts` facade outside. Nine planned (`docs/архитектура.md`); ported
so far: `catalog`, `pricing`.

⚠️ **Write-ownership, read-freedom.** The textbook rule "each module owns its tables" was
measured against this schema and does not hold: `category` is read by 9 areas,
`inventory_variant` by 8. Forbidding reads turns every price calculation into a chain of
facade calls inside one transaction — a slow way to write a `JOIN`. **Writing** is what is
restricted: two writers means two places where a rule lives, and they diverge. `capacity`
in `pool_day` was written from six places, and they did.

## Adding an endpoint

Six steps, in `docs/api.md`. The short version: valibot schema at the boundary →
route → `Ctx` → service → explicit response shape.

⚠️ **The schema is not optional.** Fastify validates *responses*, never request bodies.
⚠️ **Normalisation lives in the schema**, so a new endpoint cannot forget it: `+7 999…`
and `8999…` unnormalised become two customers, and the booking limit is bypassed by
changing format.
⚠️ **Never return DB rows as they are** — a renamed column then breaks the frontend.

## Migration rules

⚠️ **Every ported endpoint is compared against the baseline byte for byte.** Baselines live
in `test/fixtures/baseline/`, captured from the live Nuxt stand before any change. This is
how the price-rule defect (19.23) was found — a scenario run, not a unit test.

⚠️ They moved here from the frontend on 18 September 2026 (TODO 19.45): only this repo's
checks ever read them, so the repository boundary ran through the middle of the check. A
second, unread copy sat here and had silently diverged on 20 of 38 files.

⚠️ **Seven baselines diverge on their own** — `daysLeft`, `days` in service, the
`lost-demand` window, `utilization`, `nearestBookingAt`, `counter/orders` all depend on
"today", so `make baseline` reports 31/38 a day after capture. Check that a divergence is
**only** in time-dependent fields before dismissing it; re-capturing is not a fix (TODO
19.46).

⚠️ **Do not rewrite the domain or the tests.** 10 200 lines of domain and 322 tests move as
they are; that is the main saving of the whole plan. Work that touches them needs a separate
justification.

⚠️ **Both implementations stay alive until the end.** Switching is one env var on the
frontend (`NUXT_PUBLIC_API_BASE`), and so is rolling back.

## Commands

`make help` lists everything.

| Команда | Что |
|---|---|
| `make check` | то, что гоняет CI: типы, тесты, границы слоёв |
| `make baseline` | сверка ответов с эталоном (нужен поднятый сервис) |
| `make scenarios` | сценарии мутаций: переход состояния (нужен поднятый сервис) |
| `make dev` | сервис с перезапуском по изменению |

Requires Postgres from `../rental/docker-compose.yml` (port 55432).

⚠️ **The schema and migrations live HERE** — `src/db/schema.ts` and `drizzle/` (generated
+ `drizzle/manual/` for what Drizzle cannot express: `EXCLUDE`, RLS, roles). The line
claiming they "still live in the Nuxt repo" was true only during the split.

⚠️ `drizzle-kit generate` was broken from the split until 18 September 2026: the config
pointed at `./server/db/schema.ts` (a Nuxt directory that does not exist here). Nothing
caught it because `npm run db:migrate` reads the already-written `.sql` files — only the
generator was dead, and every migration since was written by hand. See
`drizzle.config.ts`.

⚠️ **`make check` не проверяет переезд.** Тесты доказывают, что код делает задуманное;
`make baseline` — что он делает **то же, что делал раньше**. Для переезда важнее второе,
и запускать его надо после каждого переехавшего эндпоинта.

## Tooling

| Что | Где | Зачем |
|---|---|---|
| `/endpoint <путь>` | `.claude/commands/` | перевезти эндпоинт: эталон → слои → сверка |
| `baseline` | `.claude/skills/baseline/` | сверка с эталоном, код возврата годен для CI |
| `verify` | `.claude/skills/verify/` | порядок проверок и почему именно такой |
| serena | `.mcp.json` | навигация по символам; стартует уже с проектом |
| память проекта | `.serena/memories/` | слои, БД и тесты, навигация, **грабли** |

⚠️ **`.serena/memories/agent/pitfalls.md` читать до первой правки.** Там то, что уже
сработало: `pkill -f` убивает сессию агента, `SELECT DISTINCT` без `ORDER BY` ломает
сверку, контрольный тест может ничего не проверять.

⚠️ **`disableArtifact: true` в `.claude/settings.json`** — механика правила 0, а не
предпочтение. Текстовый запрет уже один раз не сработал.

## Documentation

- **`docs/`** — how this service works. Start with `docs/архитектура.md`: layers, module
  boundaries, request path and tenant isolation, with Mermaid diagrams. Then the guides
  moved out of Docusaurus: `железные-правила`, `бд-и-инварианты`, `алгоритмы`, `api`,
  `адаптеры`. `docs/СОСТОЯНИЕ.md` says what is ported and what is not.
- ⚠️ **`plans/` is gone** (17 September 2026): the module, layer and migration plans are
  done; the growth and load calculations moved to `docs/данные-и-рост.md` and
  `docs/нагрузка-и-реплики.md`; the defects found live in TODO.
- `src/*/CLAUDE.md` — устройство каждого каталога, загружаются сами.
- `../rental/server/CLAUDE.md` — how the backend works *today*, inside Nuxt.
- `../rental-docs/` — **product only**: the spec and the guides for shop owners and staff.
  Product reasoning belongs there, technical detail here, next to the code it describes.

⚠️ **`../rental-docs/docs/05-работы/TODO.md` is the only source of truth about what is
done.** Never add a second progress summary: one already existed, drifted thirty items from
reality, and was believed because it looked authoritative.
