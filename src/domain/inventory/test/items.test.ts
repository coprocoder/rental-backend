/**
 * Единицы инвентаря: номера, заведение, архив, перевод категории.
 *
 * ⚠️ Главное, что здесь закрепляется, — НОМЕРА НЕ ПЕРЕИСПОЛЬЗУЮТСЯ.
 * Наклейка существует физически в одном экземпляре, и если после
 * списания её номер достанется другой вещи, на складе окажутся две
 * разные вещи с одинаковой меткой, а история первой прилипнет ко второй.
 */
import { describe, expect, it } from 'vitest'
import {
  archiveItem,
  codePrefix,
  createItems,
  findByCode,
  listItems,
  nextCodes,
  setCategoryTracking,
  archiveItems,
  blackoutItems,
  clearItemBlackout,
} from '~/domain/inventory/items'
import { adjustQuantity } from '~/domain/admin/admin'
import { checkAvailability } from '~/domain/availability/availability'
import { inRollback } from '../../../db/test/setup'

const TZ = 'Asia/Krasnoyarsk'

async function fixture(c: import('pg').PoolClient, tracking = 'count') {
  const { rows: [t] } = await c.query(
    `INSERT INTO tenant (slug, name) VALUES ('t-' || gen_random_uuid(), 'Тест') RETURNING id`,
  )
  const { rows: [b] } = await c.query(
    `INSERT INTO branch (tenant_id, name) VALUES ($1, 'Филиал') RETURNING id`, [t.id],
  )
  const { rows: [cat] } = await c.query(
    `INSERT INTO category (tenant_id, code, name, tracking)
     VALUES ($1, 'board', '{"ru":"Сноуборд"}', $2::tracking_mode) RETURNING id`,
    [t.id, tracking],
  )
  const { rows: [v] } = await c.query(
    `INSERT INTO inventory_variant (tenant_id, branch_id, category_id, code, name)
     VALUES ($1, $2, $3, 'sb-157', '{"ru":"157 см"}') RETURNING id`,
    [t.id, b.id, cat.id],
  )
  const { rows: [s] } = await c.query(
    `INSERT INTO staff (tenant_id, email, name, role)
     VALUES ($1, 'o-' || gen_random_uuid() || '@t.local', 'Владелец', 'owner') RETURNING id`,
    [t.id],
  )
  return { tenantId: t.id, branchId: b.id, categoryId: cat.id, variantId: v.id, staffId: s.id }
}

describe('префикс кода', () => {
  it('две латинские буквы в верхнем регистре', () => {
    expect(codePrefix('board')).toBe('BO')
    expect(codePrefix('ski')).toBe('SK')
  })

  /**
   * ⚠️ Номер диктуют по телефону и вводят руками: кириллица в метке
   * заставила бы сотрудника искать раскладку на чужом устройстве.
   */
  it('кириллица и цифры отбрасываются, пустое становится IT', () => {
    expect(codePrefix('сноуборд')).toBe('IT')
    expect(codePrefix('42')).toBe('IT')
    expect(codePrefix('s1k2i3')).toBe('SK')
  })
})

describe('заведение единиц', () => {
  it('коды нумеруются подряд и уникальны', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const { created } = await createItems(c, { ...f, count: 3 })

      expect(created.map((i) => i.labelCode)).toEqual(['BO-0001', 'BO-0002', 'BO-0003'])
      expect(created.every((i) => i.labelKind === 'qr')).toBe(true)
      expect(created.every((i) => i.state === 'free')).toBe(true)
    })
  })

  it('второй вызов продолжает нумерацию, а не начинает заново', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await createItems(c, { ...f, count: 2 })
      const { created } = await createItems(c, { ...f, count: 2 })

      expect(created.map((i) => i.labelCode)).toEqual(['BO-0003', 'BO-0004'])
    })
  })

  /**
   * ⚠️ Тот самый инвариант. Считать от количества ЖИВЫХ единиц —
   * типичная реализация, и она выдаёт уже напечатанный номер.
   */
  it('номер списанной единицы не достаётся новой', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const { created } = await createItems(c, { ...f, count: 2 })
      await archiveItem(c, { tenantId: f.tenantId, itemId: created[1]!.id, staffId: f.staffId })

      const next = await createItems(c, { ...f, count: 1 })
      expect(next.created[0]!.labelCode).toBe('BO-0003')

      const free = await listItems(c, { tenantId: f.tenantId })
      expect(free.map((i) => i.labelCode)).toEqual(['BO-0001', 'BO-0003'])
    })
  })

  it('нумерация продолжается даже когда живых единиц не осталось', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const { created } = await createItems(c, { ...f, count: 2 })
      for (const i of created) {
        await archiveItem(c, { tenantId: f.tenantId, itemId: i.id, staffId: f.staffId })
      }

      const next = await nextCodes(c, { tenantId: f.tenantId, prefix: 'BO', count: 1 })
      expect(next).toEqual(['BO-0003'])
    })
  })

  /**
   * ⚠️ Дополнение нулями до четырёх знаков — не косметика: без него
   * BO-10 встаёт между BO-1 и BO-2 при строковом сравнении, и список
   * из сорока вещей выглядит перемешанным.
   */
  it('номера дополнены нулями, поэтому идут по порядку', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await createItems(c, { ...f, count: 12 })

      const codes = (await listItems(c, { tenantId: f.tenantId })).map((i) => i.labelCode)
      expect(codes).toEqual([
        'BO-0001', 'BO-0002', 'BO-0003', 'BO-0004', 'BO-0005', 'BO-0006',
        'BO-0007', 'BO-0008', 'BO-0009', 'BO-0010', 'BO-0011', 'BO-0012',
      ])
    })
  })

  it('больше 500 за раз не заводится', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await expect(createItems(c, { ...f, count: 501 })).rejects.toMatchObject({
        statusCode: 422,
      })
    })
  })
})

describe('поиск по номеру — то, что делает скан', () => {
  it('находит без учёта регистра', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await createItems(c, { ...f, count: 1 })

      const found = await findByCode(c, { tenantId: f.tenantId, code: 'bo-0001' })
      expect(found?.labelCode).toBe('BO-0001')
      expect(found?.variantName).toBe('157 см')
    })
  })

  /**
   * ⚠️ Для сотрудника архивная единица удалена. «Нашлась, но списана»
   * означало бы выдачу вещи, которой на складе нет.
   */
  it('не находит архивную', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      const { created } = await createItems(c, { ...f, count: 1 })
      await archiveItem(c, { tenantId: f.tenantId, itemId: created[0]!.id, staffId: f.staffId })

      expect(await findByCode(c, { tenantId: f.tenantId, code: 'BO-0001' })).toBeNull()
    })
  })

  it('чужой тенант не находит', async () => {
    await inRollback(async (c) => {
      const a = await fixture(c)
      const b = await fixture(c)
      await createItems(c, { ...a, count: 1 })

      expect(await findByCode(c, { tenantId: b.tenantId, code: 'BO-0001' })).toBeNull()
    })
  })
})

describe('перевод категории на поимённый учёт', () => {
  /**
   * ⚠️ Без заведения единиц из остатка включение уровня обнулило бы
   * склад: наличие при labeled считается по единицам, а их ещё нет.
   */
  it('единицы заводятся из остатка по журналу', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await c.query(
        `INSERT INTO movement (tenant_id, branch_id, variant_id, kind, qty)
         VALUES ($1, $2, $3, 'receipt', 6)`,
        [f.tenantId, f.branchId, f.variantId],
      )

      const r = await setCategoryTracking(c, {
        tenantId: f.tenantId, categoryId: f.categoryId,
        tracking: 'labeled', staffId: f.staffId,
      })

      expect(r.itemsCreated).toBe(6)
      const items = await listItems(c, { tenantId: f.tenantId })
      expect(items).toHaveLength(6)
      expect(items[5]!.labelCode).toBe('BO-0006')
    })
  })

  it('повторный перевод не задваивает единицы', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await c.query(
        `INSERT INTO movement (tenant_id, branch_id, variant_id, kind, qty)
         VALUES ($1, $2, $3, 'receipt', 4)`,
        [f.tenantId, f.branchId, f.variantId],
      )
      await setCategoryTracking(c, {
        tenantId: f.tenantId, categoryId: f.categoryId,
        tracking: 'labeled', staffId: f.staffId,
      })
      const again = await setCategoryTracking(c, {
        tenantId: f.tenantId, categoryId: f.categoryId,
        tracking: 'labeled', staffId: f.staffId,
      })

      expect(again.itemsCreated).toBe(0)
      expect(await listItems(c, { tenantId: f.tenantId })).toHaveLength(4)
    })
  })

  /**
   * ⚠️ Вернуть категорию на счётчик можно, а выбросить историю вещей
   * нельзя: движения по единицам остаются, и повторное включение
   * не заведёт их заново.
   */
  it('обратный перевод на счётчик единицы не удаляет', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await c.query(
        `INSERT INTO movement (tenant_id, branch_id, variant_id, kind, qty)
         VALUES ($1, $2, $3, 'receipt', 2)`,
        [f.tenantId, f.branchId, f.variantId],
      )
      await setCategoryTracking(c, {
        tenantId: f.tenantId, categoryId: f.categoryId,
        tracking: 'labeled', staffId: f.staffId,
      })

      const back = await setCategoryTracking(c, {
        tenantId: f.tenantId, categoryId: f.categoryId,
        tracking: 'count', staffId: f.staffId,
      })

      expect(back.itemsCreated).toBe(0)
      expect(await listItems(c, { tenantId: f.tenantId })).toHaveLength(2)
    })
  })
})

describe('поступление при поимённом учёте', () => {
  /**
   * ⚠️ Жалоба с экрана: «нажал плюс, всплыло „Поступление записано“,
   * а номер не выдался». Остаток становился 7 при шести номерах —
   * седьмую вещь нечем пометить и невозможно выдать по скану.
   */
  it('плюс к количеству заводит единицу с номером', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await c.query(
        `INSERT INTO movement (tenant_id, branch_id, variant_id, kind, qty)
         VALUES ($1, $2, $3, 'receipt', 6)`,
        [f.tenantId, f.branchId, f.variantId],
      )
      await setCategoryTracking(c, {
        tenantId: f.tenantId, categoryId: f.categoryId,
        tracking: 'labeled', staffId: f.staffId,
      })

      const r = await adjustQuantity(c, {
        tenantId: f.tenantId, branchId: f.branchId, variantId: f.variantId,
        delta: 1, staffId: f.staffId,
      })

      expect(r.newTotal).toBe(7)
      const codes = (await listItems(c, { tenantId: f.tenantId })).map((i) => i.labelCode)
      // ⚠️ Остаток и число единиц — одна величина, посчитанная двумя
      // способами: разойтись они не должны.
      expect(codes).toHaveLength(7)
      expect(codes.at(-1)).toBe('BO-0007')
    })
  })

  it('списание единицы не трогает: какую убрать — решает человек', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await c.query(
        `INSERT INTO movement (tenant_id, branch_id, variant_id, kind, qty)
         VALUES ($1, $2, $3, 'receipt', 3)`,
        [f.tenantId, f.branchId, f.variantId],
      )
      await setCategoryTracking(c, {
        tenantId: f.tenantId, categoryId: f.categoryId,
        tracking: 'labeled', staffId: f.staffId,
      })

      await adjustQuantity(c, {
        tenantId: f.tenantId, branchId: f.branchId, variantId: f.variantId,
        delta: -1, staffId: f.staffId, reason: 'поломка',
      })

      expect(await listItems(c, { tenantId: f.tenantId })).toHaveLength(3)
    })
  })

  it('при учёте по количеству единицы не заводятся', async () => {
    await inRollback(async (c) => {
      const f = await fixture(c)
      await adjustQuantity(c, {
        tenantId: f.tenantId, branchId: f.branchId, variantId: f.variantId,
        delta: 5, staffId: f.staffId,
      })

      expect(await listItems(c, { tenantId: f.tenantId })).toHaveLength(0)
    })
  })
})

describe('отключение конкретных единиц', () => {
  /** Заводит вариант с ёмкостью пула на ближайшие дни. */
  async function withPool(c: import('pg').PoolClient, qty: number) {
    const f = await fixture(c)
    await c.query(
      `INSERT INTO movement (tenant_id, branch_id, variant_id, kind, qty)
       VALUES ($1, $2, $3, 'receipt', $4)`,
      [f.tenantId, f.branchId, f.variantId, qty],
    )
    await setCategoryTracking(c, {
      tenantId: f.tenantId, categoryId: f.categoryId,
      tracking: 'labeled', staffId: f.staffId,
    })
    await c.query(
      `INSERT INTO pool_day (tenant_id, variant_id, day, qty_booked, capacity)
       SELECT $1, $2, d::date, 0, $3
         FROM generate_series(current_date, current_date + 10, '1 day') AS d`,
      [f.tenantId, f.variantId, qty],
    )
    return f
  }

  const day = (offset: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    return d.toISOString().slice(0, 10)
  }

  /**
   * ⚠️ Главный тест этой пары. Отключение ПОЗИЦИИ обнуляет пул —
   * так и задумано для «сапборды не сдаём в ноябре». Отключение ВЕЩИ
   * обязано уменьшить ёмкость ровно на единицу: один ботинок в ремонте
   * не снимает с продажи остальные восемь пар.
   */
  it('отключённая вещь уменьшает наличие на единицу, а не обнуляет', async () => {
    await inRollback(async (c) => {
      const f = await withPool(c, 5)
      const items = await listItems(c, { tenantId: f.tenantId })

      const before = await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, qty: 1, timezone: TZ,
        from: new Date(`${day(1)}T00:00:00Z`), to: new Date(`${day(3)}T00:00:00Z`),
      })
      expect(before.freeUnits).toBe(5)

      await blackoutItems(c, {
        tenantId: f.tenantId,
        itemIds: [items[0]!.id, items[1]!.id],
        from: day(1), to: day(2),
        reason: 'ремонт крепления', staffId: f.staffId,
      })

      const after = await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, qty: 1, timezone: TZ,
        from: new Date(`${day(1)}T00:00:00Z`), to: new Date(`${day(3)}T00:00:00Z`),
      })
      expect(after.freeUnits).toBe(3)
      expect(after.available).toBe(true)
    })
  })

  it('после окончания отключения наличие возвращается', async () => {
    await inRollback(async (c) => {
      const f = await withPool(c, 4)
      const items = await listItems(c, { tenantId: f.tenantId })

      await blackoutItems(c, {
        tenantId: f.tenantId, itemIds: [items[0]!.id],
        from: day(1), to: day(2), reason: 'сушка', staffId: f.staffId,
      })

      // Дни ПОСЛЕ отключения — парк снова целый.
      const later = await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, qty: 1, timezone: TZ,
        from: new Date(`${day(5)}T00:00:00Z`), to: new Date(`${day(7)}T00:00:00Z`),
      })
      expect(later.freeUnits).toBe(4)
    })
  })

  it('снятие отключения возвращает единицу сразу', async () => {
    await inRollback(async (c) => {
      const f = await withPool(c, 3)
      const items = await listItems(c, { tenantId: f.tenantId })
      await blackoutItems(c, {
        tenantId: f.tenantId, itemIds: [items[0]!.id],
        from: day(1), to: day(2), reason: 'осмотр', staffId: f.staffId,
      })

      const withBlackout = await listItems(c, { tenantId: f.tenantId })
      expect(withBlackout[0]!.blackouts).toHaveLength(1)

      await clearItemBlackout(c, {
        tenantId: f.tenantId, blackoutId: withBlackout[0]!.blackouts[0]!.id,
      })

      const free = await checkAvailability(c, {
        tenantId: f.tenantId, variantId: f.variantId, qty: 1, timezone: TZ,
        from: new Date(`${day(1)}T00:00:00Z`), to: new Date(`${day(2)}T00:00:00Z`),
      })
      expect(free.freeUnits).toBe(3)
    })
  })

  /**
   * ⚠️ Выданная вещь пропускается, а не роняет операцию: сотрудник
   * отметил десять галочек, одна на руках — отменять остальные девять
   * значит заставить его выбирать заново.
   */
  it('массовое скрытие пропускает выданные, остальные убирает', async () => {
    await inRollback(async (c) => {
      const f = await withPool(c, 3)
      const items = await listItems(c, { tenantId: f.tenantId })

      const { rows: [o] } = await c.query<{ id: string }>(
        `INSERT INTO rental_order (tenant_id, branch_pickup_id, public_code, status, period)
         VALUES ($1, $2, 'T-' || substr(gen_random_uuid()::text, 1, 6), 'issued',
                 tstzrange(now(), now() + interval '2 days'))
         RETURNING id`,
        [f.tenantId, f.branchId],
      )
      await c.query(
        `INSERT INTO order_line (tenant_id, order_id, variant_id, item_id, qty, period, status)
         VALUES ($1, $2, $3, $4, 1, tstzrange(now(), now() + interval '2 days'), 'picked_up')`,
        [f.tenantId, o!.id, f.variantId, items[0]!.id],
      )

      const r = await archiveItems(c, {
        tenantId: f.tenantId,
        itemIds: items.map((i) => i.id),
        staffId: f.staffId,
      })

      expect(r.skipped).toEqual([items[0]!.labelCode])
      expect(r.archived).toHaveLength(2)
      expect(await listItems(c, { tenantId: f.tenantId })).toHaveLength(1)
    })
  })
})
