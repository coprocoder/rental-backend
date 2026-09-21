-- Роль для системных процессов: обработчик outbox и планировщик.
--
-- Проблема: воркеры работают ПОПЕРЁК тенантов по определению — очередь
-- одна на всех, автоснятие просроченных броней тоже. А FORCE RLS
-- применяется и к владельцу таблицы, поэтому запрос без app.tenant_id
-- возвращает ноль строк: правильное fail-closed поведение, из-за
-- которого воркер молча ничего не делает.
--
-- Решение: отдельная роль с BYPASSRLS, под которой работают ТОЛЬКО
-- фоновые процессы. Веб-приложение продолжает ходить под rental и
-- остаётся под RLS — то есть ошибка в прикладном коде по-прежнему
-- не может утечь между тенантами.
--
-- ⚠️ Почему не BYPASSRLS для основной роли: тогда RLS перестала бы
-- защищать вообще, и вся конструкция «инварианты в БД, а не в коде»
-- потеряла бы смысл. Разделение роли — цена того, чтобы защита
-- осталась настоящей.
--
-- Пароль задаётся из переменной окружения при развёртывании; здесь
-- значение для локальной разработки, совпадающее с docker-compose.
--
-- Идемпотентно.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rental_worker') THEN
    CREATE ROLE rental_worker LOGIN PASSWORD 'rental_worker' BYPASSRLS;
  ELSE
    -- Роль могла быть создана без BYPASSRLS более старой миграцией.
    ALTER ROLE rental_worker BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO rental_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rental_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rental_worker;

-- Таблицы, созданные будущими миграциями, тоже должны быть доступны.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rental_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO rental_worker;

COMMENT ON ROLE rental_worker IS
  'Фоновые процессы: обработчик outbox, автоснятие броней. BYPASSRLS, '
  'потому что работают поперёк тенантов. Веб-приложение ходит под rental.';
