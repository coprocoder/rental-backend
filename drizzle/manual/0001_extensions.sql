-- 0001_extensions.sql — расширения Postgres, без которых не выразить инварианты.
--
-- Почему ручной SQL, а не Drizzle: расширения, EXCLUDE USING GIST, RLS-политики
-- и CHECK с подзапросами через ORM не выражаются. См. docs/10-бэкенд/11-модель-данных.md,
-- раздел «Ручной SQL обязателен».
--
-- ⚠️ Файл идемпотентен: раннер применяет его по журналу (_manual_migrations),
-- но при отладке файлы перезапускают руками. Любой оператор здесь — IF NOT EXISTS.

-- btree_gist — ОБЯЗАТЕЛЕН.
--
-- Причина ровно одна и она не косметическая: в одном ограничении исключения
-- смешиваются скалярное равенство и пересечение диапазона:
--
--   EXCLUDE USING GIST (item_id WITH =, period WITH &&)
--
-- GIST «из коробки» умеет диапазоны (&&), но не умеет btree-операторы (=) для
-- скаляров вроде uuid/bigint. btree_gist добавляет ровно эти классы операторов.
-- Без расширения CREATE CONSTRAINT падает с
--   «data type uuid has no default operator class for access method gist».
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- pgcrypto — gen_random_uuid() для первичных ключей.
-- В Postgres 13+ gen_random_uuid() есть и в ядре, поэтому расширение
-- нужно скорее для digest()/hmac(): хеш версии оферты в agreement
-- (см. 11-модель-данных, «agreement.offer_version + хеш»).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- pg_trgm — поиск заказа по телефону и имени клиента «как в жизни»: оператор
-- на стойке вводит часть номера. LIKE '%...%' без триграммного индекса
-- деградирует в seq scan на всей таблице заказов тенанта.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
