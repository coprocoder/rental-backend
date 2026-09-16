-- 0002_invariants.sql — ограничения, которые ORM не выражает.
--
-- Железное правило №2: инварианты живут в БД, а не в коде. Проверка в
-- прикладном коде гонку не закрывает — между SELECT «свободно» и INSERT
-- проходит время, и в это окно влезает второй клиент. Ограничение в движке
-- забыть нельзя, а проверку в коде — можно, в одном запросе из двадцати.
-- См. docs/10-бэкенд/11-модель-данных.md, docs/30-эксплуатация/33-качество.md.
--
-- ⚠️ Идемпотентность: ALTER TABLE ... ADD CONSTRAINT не поддерживает
-- IF NOT EXISTS, поэтому каждое ограничение навешивается через DO-блок с
-- проверкой pg_constraint, либо через DROP CONSTRAINT IF EXISTS перед ADD.
-- Второй вариант предпочтителен там, где определение может меняться:
-- иначе отредактированное ограничение молча не применится.
--
-- ⚠️ Имена ограничений — часть контракта: на них смотрит тест на дрейф схемы
-- (test/invariants.test.ts) и обработчик ошибок, который превращает 23P01
-- в код ITEM_JUST_TAKEN (docs/10-бэкенд/20-api.md). Переименование ограничения
-- = изменение публичного поведения API.

-- ============================================================================
-- 1. Одну вещь не сдать двоим — EXCLUDE USING GIST на order_line
-- ============================================================================
--
-- Декларативный запрет двойной брони вместо проверки в коде.
--
-- ⚠️ Работает только при tracking ≠ count. При tracking = count (режим по
-- умолчанию!) item_id всегда NULL, и основным механизмом становится
-- CHECK на pool_day ниже. Здесь это выражено частичным условием
-- item_id IS NOT NULL: строки пула ограничение просто не рассматривает.
--
-- Тонкости, которые экономят отладку (11-модель-данных, «Конкретные конструкции»):
--   * period — tstzrange, ПОЛУОТКРЫТЫЙ [начало, конец). Возврат в 15:00 и
--     выдача в 15:00 НЕ конфликтуют. Нужен буфер на подготовку — расширять
--     сам диапазон (end + buffer при записи), а не менять оператор пересечения.
--     См. docs/10-бэкенд/18-время-и-расписание.md, «Буфер между арендами».
--   * частичный WHERE обязателен: отменённые и вернувшиеся строки не должны
--     блокировать перевыдачу. Иначе после отмены вещь остаётся «занятой»
--     навсегда — а отмена заранее по замыслу ничем не грозит (12-наличие).
--   * нарушение даёт SQLSTATE 23P01 — ловим именно его и отдаём
--     ITEM_JUST_TAKEN с альтернативами, а не 500.
--   * это БЫСТРЕЕ SERIALIZABLE: SSI берёт predicate lock на весь
--     отфильтрованный набор и отваливает транзакции с 40001 даже когда
--     интервалы реально не пересекаются. GIST блокирует только настоящие
--     пересечения → нет ретрай-штормов на ложных конфликтах.
--
-- tenant_id в ключе ограничения намеренно НЕТ: item_id уникален глобально,
-- и лишний столбец только раздул бы индекс. Изоляцию тенантов делает RLS.
DO $$
BEGIN
  IF to_regclass('public.order_line') IS NULL THEN
    RAISE EXCEPTION 'нет таблицы order_line — сначала миграции Drizzle (npm run db:generate)';
  END IF;

  ALTER TABLE order_line DROP CONSTRAINT IF EXISTS order_line_no_double_booking;

  ALTER TABLE order_line
    ADD CONSTRAINT order_line_no_double_booking
    EXCLUDE USING GIST (
      item_id WITH =,
      period  WITH &&
    )
    WHERE (
      status IN ('reserved', 'picked_up')
      AND item_id IS NOT NULL
    );
END
$$;

COMMENT ON CONSTRAINT order_line_no_double_booking ON order_line IS
  'Двойная бронь экземпляра невозможна. Только tracking ≠ count (item_id IS NOT NULL). '
  'Отменённые и возвращённые строки исключены — иначе не перевыдать. '
  'Нарушение → SQLSTATE 23P01 → код ITEM_JUST_TAKEN.';

-- Экземпляр заполняется только при пер-экземплярном учёте.
-- Без этого можно получить строку с item_id при tracking = count — и тогда
-- один и тот же физический экземпляр окажется учтён двумя механизмами.
-- Полную проверку «item_id соответствует category.tracking» здесь сделать
-- нельзя (CHECK не умеет подзапросы), она живёт в триггере/домене;
-- здесь — только то, что выражается локально.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'order_line' AND column_name = 'kind'
  ) THEN
    ALTER TABLE order_line DROP CONSTRAINT IF EXISTS order_line_item_only_for_rental;
    -- Услуга (заточка) и залог интервал не занимают и экземпляр не держат.
    ALTER TABLE order_line
      ADD CONSTRAINT order_line_item_only_for_rental
      CHECK (kind = 'rental' OR item_id IS NULL);
  END IF;
END
$$;

-- Интервал брони обязателен для аренды и отсутствует у услуг.
-- ⚠️ Услуги — отдельный вид строки, без брони интервала и без проверки
-- наличия (docs/10-бэкенд/14-цены.md, п. 3). Если бы период был NOT NULL,
-- заточку пришлось бы укладывать в интервал — сломалось бы и то и другое.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'order_line' AND column_name = 'kind'
  ) THEN
    ALTER TABLE order_line DROP CONSTRAINT IF EXISTS order_line_period_for_rental;
    ALTER TABLE order_line
      ADD CONSTRAINT order_line_period_for_rental
      CHECK (
        (kind = 'rental' AND period IS NOT NULL)
        OR (kind <> 'rental')
      );
  END IF;
END
$$;

-- Полуоткрытость интервала — не соглашение в коде, а ограничение в БД.
-- ⚠️ Если хоть одна строка запишется как '[)'::inclusive или '(]',
-- «возврат 15:00 = выдача 15:00 не конфликтуют» перестанет быть правдой,
-- и баг будет плавающим: конфликт возникнет только на встречных границах.
-- Железное правило №4. Пустой диапазон тоже запрещаем: он не пересекается
-- ни с чем, то есть бронь на «ноль времени» обходила бы exclusion.
DO $$
BEGIN
  ALTER TABLE order_line DROP CONSTRAINT IF EXISTS order_line_period_half_open;
  ALTER TABLE order_line
    ADD CONSTRAINT order_line_period_half_open
    CHECK (
      period IS NULL
      OR (
        lower_inc(period) IS TRUE
        AND upper_inc(period) IS FALSE
        AND NOT isempty(period)
        AND lower(period) IS NOT NULL
        AND upper(period) IS NOT NULL
      )
    );
END
$$;

-- ============================================================================
-- 2. Пул не переполнить — CHECK на счётчике по дням
-- ============================================================================
--
-- Для пула (шлемы, очки, перчатки, одежда) exclusion не годится:
-- ограничения исключения попарные, а нужна СУММА пересекающихся количеств.
--
-- ⚠️ И нельзя считать наличие как SUM(qty) WHERE period && requested —
-- это сильно ЗАВЫШАЕТ занятость. Брони на 3 и на 10 февраля обе пересекают
-- запрос «1–15 февраля», но никогда не существуют одновременно.
-- Железное правило №5. Отсюда счётчик по дням: одна строка на вариант в день.
--
-- UPDATE pool_day SET qty_booked = qty_booked + N — блокировка строки
-- сериализует всё бесплатно, инвариант живёт в БД, а не в запросе, который
-- легко написать неправильно.
--
-- ⚠️ Многодневная бронь трогает N строк → брать их в ОТСОРТИРОВАННОМ порядке
-- (variant_id, day), иначе дедлоки. Железное правило №14: порядок блокировок
-- один на весь код (pool_day → branch_capacity_day → exclusion на order_line).
--
-- qty_booked >= 0 не менее важен, чем верхняя граница: без него откат
-- брони мог бы уехать в минус (двойное освобождение одной строки),
-- и пул «раздулся» бы сверх реального capacity.
DO $$
BEGIN
  IF to_regclass('public.pool_day') IS NULL THEN
    RAISE EXCEPTION 'нет таблицы pool_day — сначала миграции Drizzle';
  END IF;

  ALTER TABLE pool_day DROP CONSTRAINT IF EXISTS pool_day_qty_within_capacity;
  ALTER TABLE pool_day
    ADD CONSTRAINT pool_day_qty_within_capacity
    CHECK (qty_booked >= 0 AND qty_booked <= capacity);

  ALTER TABLE pool_day DROP CONSTRAINT IF EXISTS pool_day_capacity_non_negative;
  ALTER TABLE pool_day
    ADD CONSTRAINT pool_day_capacity_non_negative
    CHECK (capacity >= 0);
END
$$;

COMMENT ON CONSTRAINT pool_day_qty_within_capacity ON pool_day IS
  'Основной механизм при tracking = count: переполнение пула невозможно. '
  'Нарушение → SQLSTATE 23514 → код POOL_EXHAUSTED. '
  'Нижняя граница защищает от отрицательного счётчика при двойном освобождении.';

-- ⚠️ Порядок блокировок задан индексом первичного ключа (variant_id, day).
-- Индекс на (day) отдельно нужен фоновой чистке прошедших дней:
-- без него она сканирует всю таблицу.
CREATE INDEX IF NOT EXISTS pool_day_day_idx ON pool_day (day);

-- ============================================================================
-- 3. Нет двух активных цен на одну дату — EXCLUDE на price_rule
-- ============================================================================
--
-- Неоднозначной цены не бывает: если на 5 января подходят две активные
-- базовые ставки, движок цен вернёт «какую-то», и прокат будет ловить
-- «а почему у клиента вышло 380 рублей» (docs/10-бэкенд/14-цены.md).
--
-- Ключ ограничения — (tenant_id, variant_id, rule_kind, valid):
--   * tenant_id — обязателен: у разных тенантов свои прайсы на общих справочниках,
--     и без него правило одного тенанта запрещало бы правило другого. RLS
--     ограничения НЕ фильтрует — уникальность и exclusion проверяются по всей
--     таблице, включая невидимые строки. Это же делает нарушение поперёк
--     тенантов утечкой факта существования чужой строки.
--   * rule_kind — пересечение запрещено только внутри ОДНОГО типа правил:
--     «будни 800» и «студент −250» действуют одновременно по замыслу,
--     конфликтуют только две базовые ставки.
--
-- ⚠️ Частичное условие учитывает архив. Решение схемного уровня: сущности,
-- на которые есть ссылки, физически не удаляются — вместо удаления archived_at
-- (11-модель-данных, «Архивирование вместо удаления»). Значит «нет двух
-- активных правил на пересекающиеся даты» — это
-- WHERE (is_active AND archived_at IS NULL): архивное правило не должно
-- мешать создать новое на те же даты, иначе архив превращается в блокировку.
DO $$
BEGIN
  IF to_regclass('public.price_rule') IS NULL THEN
    RAISE EXCEPTION 'нет таблицы price_rule — сначала миграции Drizzle';
  END IF;

  ALTER TABLE price_rule DROP CONSTRAINT IF EXISTS price_rule_no_overlap;

  ALTER TABLE price_rule
    ADD CONSTRAINT price_rule_no_overlap
    EXCLUDE USING GIST (
      tenant_id  WITH =,
      variant_id WITH =,
      rule_kind  WITH =,
      valid      WITH &&
    )
    WHERE (is_active AND archived_at IS NULL);
END
$$;

COMMENT ON CONSTRAINT price_rule_no_overlap ON price_rule IS
  'Двух активных правил одного типа на пересекающиеся даты не бывает. '
  'Частичное условие учитывает архив: archived_at IS NULL — иначе архивное '
  'правило блокировало бы создание нового на те же даты.';

-- ⚠️ Прайс без даты окончания («будни 800, бессрочно») — это valid с
-- бесконечной верхней границей, а не NULL: NULL в диапазоне даёт NULL при &&,
-- и exclusion такую строку не увидит. Правило с NULL-периодом обошло бы
-- запрет пересечений молча.
DO $$
BEGIN
  ALTER TABLE price_rule DROP CONSTRAINT IF EXISTS price_rule_valid_not_null;
  ALTER TABLE price_rule
    ADD CONSTRAINT price_rule_valid_not_null
    CHECK (valid IS NOT NULL AND NOT isempty(valid));
END
$$;

-- ============================================================================
-- 4. Ёмкость склада филиала — третье применение того же приёма
-- ============================================================================
--
-- ⏸ Поле в v1, проверка в v2 вместе с межфилиальными возвратами
-- (docs/TODO.md, п. 2.11 и 2.19). Написано сейчас, потому что механизм тот же
-- и потому что задним числом придётся перепроверять каждый CHECK.
-- Это ограничение можно снять или отложить без ущерба остальному:
--
--   ALTER TABLE branch_capacity_day DROP CONSTRAINT branch_capacity_day_within_max;
--
-- Смысл: помимо самого инвентаря ограничено МЕСТО на складе филиала.
-- Из наличия инвентаря это не выводится: филиал может иметь 500 бордов и
-- место только для 520 — принять 300 чужих он не сможет
-- (11-модель-данных, «Ёмкость склада — второй ограниченный ресурс»).
--
-- Ёмкость по КАТЕГОРИИ, а не общая: сноуборды и перчатки занимают
-- несоизмеримое место, общее число единиц ничего не скажет.
--
-- ⚠️ Неоднозначность имён: ТЗ называет справочник ёмкости
-- branch_capacity (branch_id, category_id, max_units), но инвариант описан
-- как «счётчик по дням + CHECK» — то есть нужна вторая таблица, дневной
-- счётчик. Здесь: branch_capacity — справочник (max_units),
-- branch_capacity_day — счётчик (qty_expected, max_units денормализован
-- в строку дня, иначе CHECK потребовал бы подзапроса, а он в CHECK запрещён).
-- Если схема назовёт таблицы иначе — правится здесь, тест на дрейф покажет.
DO $$
BEGIN
  IF to_regclass('public.branch_capacity_day') IS NULL THEN
    RAISE NOTICE 'branch_capacity_day ещё нет — проверка ёмкости склада отложена (v2, TODO 2.19)';
    RETURN;
  END IF;

  ALTER TABLE branch_capacity_day DROP CONSTRAINT IF EXISTS branch_capacity_day_within_max;
  ALTER TABLE branch_capacity_day
    ADD CONSTRAINT branch_capacity_day_within_max
    CHECK (qty_expected >= 0 AND qty_expected <= max_units);
END
$$;

DO $$
BEGIN
  IF to_regclass('public.branch_capacity') IS NULL THEN
    RAISE NOTICE 'branch_capacity ещё нет — пропускаю CHECK на max_units';
    RETURN;
  END IF;

  ALTER TABLE branch_capacity DROP CONSTRAINT IF EXISTS branch_capacity_max_units_non_negative;
  ALTER TABLE branch_capacity
    ADD CONSTRAINT branch_capacity_max_units_non_negative
    CHECK (max_units >= 0);
END
$$;

-- ============================================================================
-- 5. Уникальности с учётом архива
-- ============================================================================
--
-- ⚠️ Взаимодействие с архивом касается не только EXCLUDE, но и каждого
-- уникального индекса (11-модель-данных, конец раздела про архив).
-- Обычный UNIQUE на человекочитаемом коде запрещает переиспользовать код
-- архивированной вещи — а метка SB-0147 на списанном борде должна быть
-- доступна снова. Отсюда частичные индексы: уникальность только среди живых.
--
-- Индексы, в отличие от ограничений, поддерживают IF NOT EXISTS.
-- Обёртка в DO — не ради идемпотентности, а потому что часть колонок
-- (payment.idempotency_key) появляется на более поздних этапах TODO:
-- миграция не должна падать из-за ещё не существующей колонки.

-- Человекочитаемый ID экземпляра уникален в пределах тенанта, среди живых.
-- ⚠️ Не глобальный UNIQUE: метка SB-0147 на списанном борде должна стать
-- доступна снова, иначе архив съедает пространство номеров.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'item' AND column_name = 'label_code'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS item_label_code_live_uniq
      ON item (tenant_id, label_code)
      WHERE archived_at IS NULL AND label_code IS NOT NULL;
  ELSE
    RAISE NOTICE 'item.label_code ещё нет — пропускаю item_label_code_live_uniq';
  END IF;
END
$$;

-- Короткий номер заказа — по нему ищут на стойке, он должен быть однозначен.
-- Заказы не архивируются (архивируются справочники), поэтому условие только
-- на NOT NULL: черновик может ещё не иметь публичного кода.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rental_order' AND column_name = 'public_code'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS rental_order_public_code_uniq
      ON rental_order (tenant_id, public_code)
      WHERE public_code IS NOT NULL;
  ELSE
    RAISE NOTICE 'rental_order.public_code ещё нет — пропускаю rental_order_public_code_uniq';
  END IF;
END
$$;

-- ⚠️ Вебхук оплаты не должен обработаться дважды: связь рвётся, провайдер
-- повторяет доставку. Ключ идемпотентности + UNIQUE — единственная защита,
-- которая не зависит от того, дошёл ли ответ (11-модель-данных, таблица
-- инвариантов; docs/10-бэкенд/15-оплата-и-фискализация.md).
-- Платежи не архивируются — индекс без условия на archived_at.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payment' AND column_name = 'idempotency_key'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS payment_idempotency_uniq
      ON payment (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  ELSE
    RAISE NOTICE 'payment.idempotency_key ещё нет — пропускаю payment_idempotency_uniq (TODO 2.10)';
  END IF;
END
$$;

-- ============================================================================
-- 6. Деньги
-- ============================================================================
--
-- Железное правило №3: деньги — numeric(10,2), никогда не float.
-- Тип задаёт Drizzle; здесь — знак. Отрицательная сумма заказа означает,
-- что где-то перерасчёт при досрочном возврате (обязателен по ГК ст. 630)
-- ушёл в минус, и это надо ловить в момент записи, а не в отчёте за месяц.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'order_line' AND column_name = 'amount'
  ) THEN
    ALTER TABLE order_line DROP CONSTRAINT IF EXISTS order_line_amount_non_negative;
    ALTER TABLE order_line
      ADD CONSTRAINT order_line_amount_non_negative
      CHECK (amount >= 0);
  END IF;
END
$$;
