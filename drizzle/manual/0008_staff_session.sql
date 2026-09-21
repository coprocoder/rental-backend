-- Сессии сотрудников и защита от подбора пароля.
--
-- ⚠️ Почему сессии в БД, а не только подписанные cookie: на стойке
-- устройство ОБЩЕЕ и смена длинная. Нужно уметь отозвать сессию
-- (уволился, потерял планшет) и видеть, кто работает — с подписанным
-- токеном без состояния ни то, ни другое невозможно.
--
-- ⚠️ Хранится хеш токена, а не токен: дамп базы не должен давать
-- вход в чужой аккаунт.
--
-- Идемпотентно.

CREATE TABLE IF NOT EXISTS staff_session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  staff_id     uuid NOT NULL REFERENCES staff (id),
  token_hash   text NOT NULL,
  -- ⚠️ Сессия стойки живёт до конца дня, но ДЕЙСТВИЯ пишутся под
  -- конкретным сотрудником: PIN-переключение меняет active_staff_id,
  -- не создавая новую сессию. Иначе все работают под одним аккаунтом
  -- и лог становится бесполезным.
  active_staff_id uuid REFERENCES staff (id),
  ip           text,
  user_agent   text,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_session_hash_uk') THEN
    ALTER TABLE staff_session ADD CONSTRAINT staff_session_hash_uk UNIQUE (token_hash);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS staff_session_staff_idx ON staff_session (staff_id);

-- Счётчик неудачных попыток входа.
--
-- ⚠️ Блокировка нужна, но разблокировка — ВЛАДЕЛЬЦЕМ, а не по таймеру
-- в пять минут: иначе сотрудник в субботний пик окажется заперт, и
-- прокат встанет. Поэтому это отдельная таблица с флагом, а не
-- автоматическое окно.
CREATE TABLE IF NOT EXISTS staff_login_attempt (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenant (id),
  email       text NOT NULL,
  ip          text,
  succeeded   boolean NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_login_attempt_email_idx
  ON staff_login_attempt (email, occurred_at DESC);

-- Флаг блокировки на сотруднике.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS locked_at timestamptz;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS locked_reason text;

-- RLS: сессии и попытки входа тоже тенантные.
ALTER TABLE staff_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_session FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_login_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_login_attempt FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'staff_session' AND policyname = 'staff_session_tenant_isolation'
  ) THEN
    CREATE POLICY staff_session_tenant_isolation ON staff_session
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;

  -- ⚠️ Вход происходит ДО того, как тенант известен: сотрудник вводит
  -- только email и пароль. Поэтому поиск сессии и учётной записи идёт
  -- под ролью воркера (BYPASSRLS), как и поиск заказа по токену.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'staff_login_attempt'
      AND policyname = 'staff_login_attempt_tenant_isolation'
  ) THEN
    CREATE POLICY staff_login_attempt_tenant_isolation ON staff_login_attempt
      USING (tenant_id IS NULL
             OR tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id IS NULL
                  OR tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END $$;
