# CLAUDE.md — rental-backend

Repository of **plans** for the extracted backend of `../rental/`. No code yet.

Instructions in English because this file loads on every call; **plan documents, comments
and TODO stay Russian**.

## ⚠️ Rule 0 — privacy

**Personal side project on a corporate Team account. Never publish, never send anything
outside.**

- **never call the Artifact tool** here — not publish, not update, not read;
- **never push** to corporate hosting (company GitHub / GitVerse);
- do not mention this project in work contexts.

⚠️ **Subagents do NOT inherit this.** Put the artifact ban in every subagent prompt as
explicit text. It has already failed once.

## What this repository is

Design work for moving the backend out of the Nuxt app into a standalone Node service.
Plans live in `plans/`, numbered in reading order — see `README.md`.

When the work starts, this becomes the service's repository and `plans/` moves to `docs/`.

## Rules for the plans

⚠️ **Every number is measured, not estimated.** Each figure came from a script over the
code or a query against the database. Where a number is a forecast, it says so. The code
changes — re-check before acting on a plan.

⚠️ **A plan that cannot be verified is not a plan.** Every stage has a completion signal
somebody can demand: a green check, a matching API response, a passing test.

⚠️ **Do not duplicate what `../rental/` already documents.** The code repo owns how the
system works today (`server/CLAUDE.md`, `docs/ARCHITECTURE.md`); this repo owns where it is
going. A copy of either becomes a lie within a month.

⚠️ **Product reasoning belongs in `../rental-docs/`**, not here. If a plan needs a product
decision, link to the spec rather than restating it.

## Source of truth about the current code

`../rental/` — read it rather than trusting a plan's description of it:

- `server/CLAUDE.md` — the backend as it is now, six layers;
- `docs/ARCHITECTURE.md` — why the parts fit as they do;
- `docs/BACKEND-EXTRACTION.md` — the migration steps;
- `docs/BACKEND-DESIGN.md` — the first architecture sketch these plans grew from;
- `../rental-docs/docs/05-работы/TODO.md` — **the only source of truth about what is done.**

⚠️ Never add a second progress summary anywhere. One already existed, drifted thirty items
from reality, and was believed because it looked authoritative.
