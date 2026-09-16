/**
 * Демо-данные по мотивам реального проката.
 *
 * Идемпотентно: гоняется сколько угодно раз без дублей — через
 * ON CONFLICT DO NOTHING по естественным ключам, а не «удалить всё
 * и залить»: удаление ломает наработанное локально.
 *
 * ⚠️ Не в docker-entrypoint-initdb.d: те скрипты Postgres выполняет
 * только при создании пустого тома, и после первого `up` молча не
 * работают — классический источник «почему у меня нет данных».
 *
 * Прайс взят с реального проката: он покрывает будни/выходные,
 * порог «3+ дня», вечернюю скидку и услуги без интервала аренды.
 *
 * Запуск: npm run db:seed
 */
import { Pool } from 'pg'
import { hashPassword } from '../server/domain/core/auth'
import { offerDraft, privacyDraft, rulesDraft } from '../server/domain/admin/texts.templates'
import { hashText } from '~/common/utils/hash-text'

const TENANT_SLUG = 'demo'
const TENANT_NAME = 'Демо-прокат'

/** Категории с разными наборами параметров тела: форма собирается из них. */
const CATEGORIES = [
  {
    code: 'snowboard',
    name: { ru: 'Сноуборд', en: 'Snowboard' },
    bodyParams: ['height', 'weight'],
    tracking: 'count',
    // Сезон месяцами, включительно: зима 11→4 переходит через Новый год.
    // Это «сезонность данными»: сапборды ниже — строка, а не релиз.
    season: [11, 4],
    variants: [
      { code: 'sb-147', name: { ru: '147 см' }, bucket: { lengthMin: 145, lengthMax: 149 }, qty: 3 },
      { code: 'sb-152', name: { ru: '152 см' }, bucket: { lengthMin: 150, lengthMax: 154 }, qty: 5 },
      { code: 'sb-157', name: { ru: '157 см' }, bucket: { lengthMin: 155, lengthMax: 159 }, qty: 6 },
      { code: 'sb-162', name: { ru: '162 см' }, bucket: { lengthMin: 160, lengthMax: 164 }, qty: 4 },
    ],
  },
  {
    code: 'boots',
    name: { ru: 'Ботинки', en: 'Boots' },
    bodyParams: ['shoeSizeEu'],
    tracking: 'count',
    season: [11, 4],
    // ⚠️ Ботинки после катания мокрые изнутри: выдать их следующему
    // сразу нельзя физически. 90 минут — время сушки, и оно должно
    // быть в расчёте наличия, а не в голове у сотрудника.
    bufferMinutes: 90,
    variants: [
      // ⚠️ В названии только европейский размер: mondo (длина стопы в см)
      // остаётся в bucket, где по нему идёт подбор, но клиенту у стойки
      // «38 (mondo 24.5)» ничего не говорит — он знает свой 38-й.
      { code: 'bt-38', name: { ru: '38' }, bucket: { eu: 38, mondo: '24.5' }, qty: 2 },
      { code: 'bt-40', name: { ru: '40' }, bucket: { eu: 40, mondo: '25.5' }, qty: 4 },
      { code: 'bt-42', name: { ru: '42' }, bucket: { eu: 42, mondo: '27.0' }, qty: 5 },
      { code: 'bt-44', name: { ru: '44' }, bucket: { eu: 44, mondo: '28.5' }, qty: 3 },
      { code: 'bt-46', name: { ru: '46' }, bucket: { eu: 46, mondo: '29.5' }, qty: 2 },
    ],
  },
  {
    code: 'helmet',
    name: { ru: 'Шлем', en: 'Helmet' },
    // ⚠️ Обхват головы не выводится из роста (R²≈0.09–0.20).
    // Поле необязательное: без него бронируется пул без размера.
    bodyParams: ['headCircumference'],
    tracking: 'count',
    season: [11, 4],
    // Подкладку шлема протирают между клиентами — быстрее ботинок,
    // но не мгновенно.
    bufferMinutes: 30,
    variants: [
      { code: 'hl-s', name: { ru: 'S (51–55)' }, bucket: { min: 51, max: 55 }, qty: 4 },
      { code: 'hl-m', name: { ru: 'M (55–59)' }, bucket: { min: 55, max: 59 }, qty: 7 },
      { code: 'hl-l', name: { ru: 'L (59–62)' }, bucket: { min: 59, max: 62 }, qty: 4 },
    ],
  },
  {
    code: 'gloves',
    name: { ru: 'Перчатки', en: 'Gloves' },
    bodyParams: [],
    tracking: 'count',
    // Перчатки нужны и зимой, и на воде: круглый год.
    season: null,
    variants: [
      { code: 'gl-m', name: { ru: 'M' }, bucket: { size: 'M' }, qty: 8 },
      { code: 'gl-l', name: { ru: 'L' }, bucket: { size: 'L' }, qty: 6 },
    ],
  },
  {
    // Летняя категория с первого дня: сезонность проверяется сразу,
    // и видно, что «добавить сапборды» — это данные, а не релиз.
    code: 'sup',
    name: { ru: 'Сапборд', en: 'SUP board' },
    bodyParams: ['weight'],
    tracking: 'count',
    season: [5, 9],
    variants: [
      { code: 'sup-10', name: { ru: '10\'6" до 90 кг' }, bucket: { maxWeight: 90 }, qty: 3 },
      { code: 'sup-11', name: { ru: '11\'6" до 120 кг' }, bucket: { maxWeight: 120 }, qty: 2 },
    ],
  },
]

/** Цены по реальному прайсу. */
const PRICES: Record<string, number> = {
  snowboard: 900,
  boots: 500,
  helmet: 300,
  gloves: 200,
  sup: 1200,
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL не задан — скопируй .env.example в .env')

  const pool = new Pool({ connectionString: url })
  const c = await pool.connect()

  try {
    const ready = await c.query(`SELECT to_regclass('public.tenant') IS NOT NULL AS ok`)
    if (!ready.rows[0]?.ok) {
      console.log('Схемы нет — сначала npm run db:migrate.')
      return
    }

    await c.query('BEGIN')

    // --- тарифы и тенант ---
    // ⚠️ Все три тарифа заводятся всегда: демо должно показывать
    // ОТЛИЧИЯ, а сравнить не с чем, если в базе один тариф. Состав
    // лимитов — зеркало shared/plans.ts, там же описания.
    await c.query(
      `INSERT INTO plan (code, name, price_per_month, limits)
       VALUES ('start', 'Старт', 1500, $1::jsonb)
       ON CONFLICT (code) DO UPDATE SET name = excluded.name, limits = excluded.limits`,
      ['{"maxBranches": 1, "maxVariants": 200}'],
    )
    await c.query(
      `INSERT INTO plan (code, name, price_per_month, limits)
       VALUES ('pro', 'Расширенный', 3500, $1::jsonb)
       ON CONFLICT (code) DO UPDATE SET name = excluded.name, limits = excluded.limits`,
      ['{"maxBranches": null, "maxVariants": null, "multiBranch": true, "advancedInventory": true, "analytics": true, "branding": true, "delegatedRoles": true}'],
    )
    await c.query(
      `INSERT INTO plan (code, name, price_per_month, limits)
       VALUES ('max', 'Про', 6000, $1::jsonb)
       ON CONFLICT (code) DO UPDATE SET name = excluded.name, limits = excluded.limits`,
      ['{"maxBranches": null, "maxVariants": null, "multiBranch": true, "advancedInventory": true, "analytics": true, "branding": true, "delegatedRoles": true, "labeledInventory": true, "apiAccess": true}'],
    )
    // ⚠️ Демо стартует на БАЗОВОМ тарифе: так видно, что добавляют
    // старшие, а переключением показывается разница.
    const { rows: [tenant] } = await c.query<{ id: string }>(
      `INSERT INTO tenant (slug, name, day_mode, plan_id, paid_until)
       VALUES ($1, $2, 'calendar',
               (SELECT id FROM plan WHERE code = 'start'),
               now() + interval '6 months')
       ON CONFLICT (slug) DO UPDATE SET
         name = excluded.name,
         plan_id = COALESCE(tenant.plan_id, excluded.plan_id),
         paid_until = COALESCE(tenant.paid_until, excluded.paid_until)
       RETURNING id`,
      [TENANT_SLUG, TENANT_NAME],
    )
    const tenantId = tenant!.id

    await c.query(
      `INSERT INTO booking_limit (tenant_id) VALUES ($1)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    )

    // --- филиал ---
    const { rows: [branchRow] } = await c.query<{ id: string }>(
      `WITH existing AS (
         SELECT id FROM branch WHERE tenant_id = $1 AND name = 'Свердловская 17а'
       ), inserted AS (
         INSERT INTO branch (tenant_id, name, address, timezone)
         SELECT $1, 'Свердловская 17а', 'ул. Свердловская, 17а/3', 'Asia/Krasnoyarsk'
         WHERE NOT EXISTS (SELECT 1 FROM existing)
         RETURNING id
       )
       SELECT id FROM inserted UNION ALL SELECT id FROM existing LIMIT 1`,
      [tenantId],
    )
    const branchId = branchRow!.id

    // Часы работы: будни 10–22, выходные 9–22 (как у реального проката).
    for (let wd = 0; wd <= 6; wd++) {
      const isWeekend = wd === 0 || wd === 6
      await c.query(
        `INSERT INTO schedule (tenant_id, branch_id, weekday, opens_at, closes_at)
         SELECT $1, $2, $3, $4, $5
         WHERE NOT EXISTS (
           SELECT 1 FROM schedule
           WHERE branch_id = $2 AND weekday = $3 AND exception_date IS NULL
         )`,
        [tenantId, branchId, wd, isWeekend ? '09:00' : '10:00', '22:00'],
      )
    }

    // --- категории, варианты, количества ---
    let variantCount = 0
    for (const [i, cat] of CATEGORIES.entries()) {
      const { rows: [catRow] } = await c.query<{ id: string }>(
        `INSERT INTO category
           (tenant_id, code, name, body_params, tracking, sort_order,
            season_from_month, season_to_month, buffer_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (tenant_id, code) DO UPDATE
           SET name = excluded.name,
               season_from_month = excluded.season_from_month,
               season_to_month = excluded.season_to_month,
               buffer_minutes = excluded.buffer_minutes
         RETURNING id`,
        [tenantId, cat.code, JSON.stringify(cat.name), JSON.stringify(cat.bodyParams), cat.tracking, i,
         cat.season?.[0] ?? null, cat.season?.[1] ?? null, cat.bufferMinutes ?? 0],
      )
      const categoryId = catRow!.id

      // ⚠️ Порядок в сетке — позиция в массиве, а не сортировка по коду:
      // для шлемов hl-l/hl-m/hl-s алфавит даёт L, M, S вместо S, M, L.
      for (const [vi, v] of cat.variants.entries()) {
        const { rows: [varRow] } = await c.query<{ id: string }>(
          `INSERT INTO inventory_variant
             (tenant_id, branch_id, category_id, code, name, size_bucket, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, code) DO UPDATE
             SET name = excluded.name, sort_order = excluded.sort_order
           RETURNING id`,
          [tenantId, branchId, categoryId, v.code, JSON.stringify(v.name), JSON.stringify(v.bucket), vi],
        )
        const variantId = varRow!.id
        variantCount++

        // Количество заводится ДВИЖЕНИЕМ, а не полем: physical это
        // сумма журнала, и поступление должно быть видно в истории.
        await c.query(
          `INSERT INTO movement (tenant_id, branch_id, variant_id, kind, qty, reason)
           SELECT $1, $2, $3, 'receipt', $4, 'Стартовое наполнение'
           WHERE NOT EXISTS (
             SELECT 1 FROM movement
             WHERE variant_id = $3 AND kind = 'receipt' AND reason = 'Стартовое наполнение'
           )`,
          [tenantId, branchId, variantId, v.qty],
        )

        // Счётчик пула на 120 дней вперёд: бронирование смотрит сюда.
        await c.query(
          `INSERT INTO pool_day (tenant_id, variant_id, day, qty_booked, capacity)
           SELECT $1, $2, d::date, 0, $3
           FROM generate_series(current_date, current_date + 120, '1 day') AS d
           ON CONFLICT (variant_id, day) DO UPDATE SET capacity = excluded.capacity`,
          [tenantId, variantId, v.qty],
        )

        // Базовая цена варианта.
        await c.query(
          `INSERT INTO price_rule
             (tenant_id, variant_id, rule_kind, valid, amount, priority, stackable)
           SELECT $1, $2, 'base',
                  tstzrange(current_date - 30, current_date + 365), $3, 100, false
           WHERE NOT EXISTS (
             SELECT 1 FROM price_rule
             WHERE variant_id = $2 AND rule_kind = 'base' AND is_active
           )`,
          [tenantId, variantId, PRICES[cat.code] ?? 500],
        )
      }
    }

    // --- сотрудники ---
    // ⚠️ Пароли демо-данных заведомо слабые и одинаковые: это локальная
    // разработка. Для реального тенанта пароль задаётся при онбординге.
    const staffMembers = [
      { email: 'owner@demo.local', name: 'Иван Владельцев', role: 'owner', pin: '1111' },
      { email: 'admin@demo.local', name: 'Анна Админова', role: 'admin', pin: '2222' },
      { email: 'counter@demo.local', name: 'Пётр Стойкин', role: 'counter', pin: '3333' },
      { email: 'tech@demo.local', name: 'Сергей Техников', role: 'technician', pin: '4444' },
    ] as const

    for (const m of staffMembers) {
      const passwordHash = await hashPassword('demo1234')
      const pinHash = await hashPassword(m.pin)
      await c.query(
        `INSERT INTO staff
           (tenant_id, email, name, role, password_hash, pin_hash, branch_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, email) DO UPDATE
           SET name = excluded.name,
               role = excluded.role,
               password_hash = excluded.password_hash,
               pin_hash = excluded.pin_hash,
               branch_ids = excluded.branch_ids`,
        [tenantId, m.email, m.name, m.role, passwordHash, pinHash,
         // Владелец и админ видят все филиалы, поэтому список пуст.
         m.role === 'owner' || m.role === 'admin' ? null : [branchId]],
      )
    }

    // --- услуги без интервала аренды ---
    for (const s of [
      { code: 'srv-sharpen', name: { ru: 'Заточка' }, price: 700 },
      { code: 'srv-wax', name: { ru: 'Парафин' }, price: 700 },
    ]) {
      const { rows: [svcCat] } = await c.query<{ id: string }>(
        `INSERT INTO category (tenant_id, code, name, body_params, tracking, sort_order)
         VALUES ($1, 'service', '{"ru":"Услуги"}', '[]', 'count', 90)
         ON CONFLICT (tenant_id, code) DO UPDATE SET name = excluded.name
         RETURNING id`,
        [tenantId],
      )
      const { rows: [svcVar] } = await c.query<{ id: string }>(
        `INSERT INTO inventory_variant
           (tenant_id, branch_id, category_id, code, name, size_bucket)
         VALUES ($1, $2, $3, $4, $5, '{}')
         ON CONFLICT (tenant_id, code) DO UPDATE SET name = excluded.name
         RETURNING id`,
        [tenantId, branchId, svcCat!.id, s.code, JSON.stringify(s.name)],
      )
      // Услуга без цены не продаётся, как и аренда: заточка 700, парафин 700.
      await c.query(
        `INSERT INTO price_rule (tenant_id, variant_id, rule_kind, valid, amount, priority, stackable)
         SELECT $1, $2, 'base', tstzrange(current_date - 30, current_date + 365), $3, 100, false
         WHERE NOT EXISTS (SELECT 1 FROM price_rule WHERE variant_id = $2 AND rule_kind = 'base' AND is_active)`,
        [tenantId, svcVar!.id, s.price],
      )
    }

    // --- ёмкость склада по категориям (0.8) ---
    //
    // ⚠️ Значения ПРАВДОПОДОБНЫЕ, а не измеренные: реальную ёмкость
    // прокат назовёт сам. Нужны они потому, что при нулевой ёмкости
    // проверка переполнения склада не срабатывает никогда и остаётся
    // непроверенной — а это инвариант, который должен ловить ошибку,
    // а не молчать.
    //
    // Порядок цифр взят от обратного: сколько единиц физически влезает
    // в подсобку небольшого проката у склона. Доски и ботинки занимают
    // стеллаж, шлемы и перчатки — полку.
    const CAPACITY: Record<string, number> = {
      snowboard: 40,
      boots: 60,
      helmet: 50,
      gloves: 80,
      sup: 15,
    }

    for (const [code, maxUnits] of Object.entries(CAPACITY)) {
      await c.query(
        `INSERT INTO branch_capacity (tenant_id, branch_id, category_id, max_units)
         SELECT $1, $2, cat.id, $4
         FROM category cat
         WHERE cat.tenant_id = $1 AND cat.code = $3
         ON CONFLICT (branch_id, category_id)
         DO UPDATE SET max_units = excluded.max_units`,
        [tenantId, branchId, code, maxUnits],
      )
    }

    // --- правовые тексты (0.6, 0.7) ---
    //
    // ⚠️⚠️ ЗАГОТОВКИ, НЕ ПРОВЕРЕННЫЕ ЮРИСТОМ. Заводятся, чтобы прототип
    // работал на данных, похожих на реальные: без оферты нет подписания,
    // без политики нет согласия, и половина сквозного пути не
    // проверяется. Каждый текст начинается с явной пометки — если он
    // попадёт к живому клиенту, это будет видно сразу.
    for (const t of [
      { kind: 'offer', body: offerDraft(TENANT_NAME) },
      { kind: 'privacy', body: privacyDraft(TENANT_NAME) },
      { kind: 'rules', body: rulesDraft(TENANT_NAME) },
    ]) {
      await c.query(
        `INSERT INTO tenant_text (tenant_id, kind, version, body, hash, is_active)
         SELECT $1, $2, 1, $3, $4, true
         WHERE NOT EXISTS (
           SELECT 1 FROM tenant_text WHERE tenant_id = $1 AND kind = $2
         )`,
        [tenantId, t.kind, t.body, hashText(t.body)],
      )
    }

    // --- постоянные клиенты с историей ---
    //
    // ⚠️ Нужны для ДЕМОНСТРАЦИИ: экран «Клиенты» объясняет, что человек
    // запоминается и его история видна на стойке, — а показать это
    // без прошлых заказов нечем. Пустая история читается как «функция
    // не работает».
    //
    // ⚠️ Заказы ЗАВЕРШЁННЫЕ и в прошлом: они не занимают инвентарь
    // и не мешают демонстрации бронирования.
    const REGULARS = [
      { name: 'Сергей Волков', phone: '+79130000101', visits: 4, noshow: 0 },
      { name: 'Марина Летова', phone: '+79130000102', visits: 3, noshow: 1 },
      { name: 'Пётр Гущин', phone: '+79130000103', visits: 2, noshow: 0 },
    ]
    for (const r of REGULARS) {
      const { rows: [cust] } = await c.query<{ id: string }>(
        `INSERT INTO customer (tenant_id, name, phone)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, phone) DO UPDATE SET name = excluded.name
         RETURNING id`,
        [tenantId, r.name, r.phone],
      )
      for (let i = 0; i < r.visits; i++) {
        // Визиты раскиданы по прошлым неделям: история должна
        // выглядеть историей, а не пачкой одинаковых дат.
        const weeksAgo = (i + 1) * 3
        const noShow = i < r.noshow
        await c.query(
          `INSERT INTO rental_order
             (tenant_id, branch_pickup_id, customer_id, public_code, status,
              period, total_amount, created_at)
           SELECT $1, $2, $3,
                  'H' || upper(substr(md5(random()::text), 1, 5)),
                  $4::order_status,
                  tstzrange(now() - ($5 || ' weeks')::interval,
                            now() - ($5 || ' weeks')::interval + interval '2 days'),
                  $6::numeric,
                  now() - ($5 || ' weeks')::interval
           WHERE NOT EXISTS (
             SELECT 1 FROM rental_order o
              WHERE o.customer_id = $3
                AND o.created_at < now() - ($5 || ' weeks')::interval + interval '1 day'
                AND o.created_at > now() - ($5 || ' weeks')::interval - interval '1 day'
           )`,
          [tenantId, branchId, cust!.id,
           noShow ? 'no_show' : 'returned', String(weeksAgo),
           noShow ? '0.00' : String(1800 + i * 300)],
        )
      }
    }

    await c.query('COMMIT')

    console.log(`Демо-данные готовы: тенант «${TENANT_SLUG}», 1 филиал, ${variantCount} вариантов.`)
    console.log('Постоянные клиенты с историей: Сергей Волков (4 визита), Марина Летова (3, одна неявка), Пётр Гущин (2).')
    console.log('⚠️ Оферта, политика ПД и правила — ТИПОВЫЕ ЗАГОТОВКИ, не проверенные юристом.')
    console.log('Сотрудники: owner@demo.local / admin@ / counter@ / tech@ — пароль demo1234')
    console.log('PIN для переключения на стойке: 1111 / 2222 / 3333 / 4444')
    console.log(`Открой http://localhost:3100/r/${TENANT_SLUG}`)
  } catch (err) {
    await c.query('ROLLBACK')
    throw err
  } finally {
    c.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
