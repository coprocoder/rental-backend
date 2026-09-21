-- Лист ожидания: гонка нескольких, «любая дата в диапазоне» (17.14).
--
-- Развитие механики из docs/10-бэкенд/22-лист-ожидания.md. В v1
-- предложение уходило строго одному — первому в очереди, — и до
-- следующего доходило только через 45 минут молчания. На пиковой
-- субботе это худший из возможных вариантов: позиция простаивает
-- три четверти часа, потому что один человек не посмотрел телефон.
--
-- ⚠️ Очередь остаётся честной. Предложение уходит нескольким СРАЗУ,
-- но сама рассылка идёт строго по created_at, и «вперёд за деньги»
-- по-прежнему невозможно (публичный договор, ГК ст. 626 п. 3).
-- Меняется не критерий, а размер окна: приглашают первых N по очереди,
-- а не первого. Кто откликнулся раньше — тот и забрал; это объективно
-- и одинаково для всех.
--
-- Идемпотентно.

-- ── 1. Гонка: победитель определяется БД, а не кодом ──────────────────
--
-- ⚠️ Железное правило №2: инвариант живёт в БД. Проверка «уже занято?»
-- в прикладном коде гонку не закрывает — два обработчика читают
-- «свободно» одновременно и оба создают заказ. Здесь: у одного
-- освобождения может быть только один победитель, и это уникальный
-- индекс, а не порядок операций в JS.
--
-- Ключ гонки (release_key) описывает конкретное освобождение: вариант
-- и интервал. Все, кому его предложили, получают один и тот же ключ;
-- забрать может один.
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS release_key text;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- Победитель один на освобождение. Частичный индекс: строки без
-- ключа и незабранные предложения друг другу не мешают.
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_one_winner_uk
  ON waitlist (tenant_id, release_key)
  WHERE claimed_at IS NOT NULL;

-- ⚠️ Токен предложения. Ссылка в письме должна доказывать право
-- забрать позицию: без него любой, кто знает id, забирает чужое
-- предложение. Тот же принцип, что у токенов заказа — разные токены
-- на разные действия.
--
-- ⚠️ Хранится ТОЛЬКО sha256: утечка дампа не должна отдавать рабочие
-- ссылки. Как в order_token — второго правила для того же риска
-- заводить незачем.
--
-- ⚠️ Первая редакция этого файла завела колонку `offer_token`; имя было
-- неверным — там лежит хеш, а не токен, и имя, обещающее токен, рано
-- или поздно заставит кого-то его оттуда прочитать. Переименование
-- идемпотентно, чтобы файл оставался применимым и к чистой базе,
-- и к той, где успела примениться первая редакция.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'waitlist' AND column_name = 'offer_token')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'waitlist' AND column_name = 'offer_token_hash')
  THEN
    ALTER TABLE waitlist RENAME COLUMN offer_token TO offer_token_hash;
  END IF;
END $$;

ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS offer_token_hash text;
DROP INDEX IF EXISTS waitlist_offer_token_uk;
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_offer_token_uk
  ON waitlist (offer_token_hash) WHERE offer_token_hash IS NOT NULL;

-- ── 2. «Любая дата в диапазоне» ───────────────────────────────────────
--
-- ⚠️ Зачем отдельное поле, а не расширение period. period — это то,
-- что клиент хочет арендовать (двое суток), search_period — где он
-- согласен их взять (в пределах недели). Расширить period значит
-- сказать «клиент хочет неделю проката», и расчёт длительности,
-- истечения и пересечений поедет.
--
-- NULL — «нужны ровно эти даты», прежнее поведение. Тогда search_period
-- совпадает с period, и вся старая логика продолжает работать.
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS search_period tstzrange;

-- Сколько суток нужно клиенту. Нужно, чтобы подобрать окно внутри
-- диапазона: «двое суток где-нибудь на новогодних».
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS nights integer;

-- ⚠️ Диапазон поиска не может быть уже желаемого интервала: иначе
-- искомое в него не помещается, и запись бессмысленна.
DO $$ BEGIN
  ALTER TABLE waitlist ADD CONSTRAINT waitlist_search_covers_period
    CHECK (search_period IS NULL OR search_period @> period);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Поиск кандидатов идёт по диапазону, а очередь — по времени записи.
CREATE INDEX IF NOT EXISTS waitlist_search_idx
  ON waitlist (variant_id, created_at)
  WHERE status = 'waiting';
