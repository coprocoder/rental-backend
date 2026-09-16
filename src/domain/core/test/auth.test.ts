/**
 * Тесты аутентификации и полномочий.
 *
 * Таблица полномочий из ТЗ (../rental-docs/docs/04-тз/10-бэкенд/17-доступ-и-роли.md).
 * Логика разделения: стойка решает вопросы очереди, деньги и инвентарь —
 * уровнем выше. Тесты закрепляют именно эту границу, потому что её
 * легко случайно размыть, добавляя удобства для стойки.
 */
import { describe, expect, it } from 'vitest'
import {
  can,
  canAccessBranch,
  hashPassword,
  verifyPassword,
  type Session,
} from '~/domain/core/auth'

describe('пароли', () => {
  it('верный пароль проходит, неверный — нет', async () => {
    const hash = await hashPassword('правильный-пароль-123')

    expect(await verifyPassword('правильный-пароль-123', hash)).toBe(true)
    expect(await verifyPassword('другой-пароль', hash)).toBe(false)
  })

  it('одинаковые пароли дают разные хеши', async () => {
    // Соль на каждый пароль своя: иначе видно, у кого пароли совпадают.
    const a = await hashPassword('одинаковый')
    const b = await hashPassword('одинаковый')

    expect(a).not.toBe(b)
    expect(await verifyPassword('одинаковый', a)).toBe(true)
    expect(await verifyPassword('одинаковый', b)).toBe(true)
  })

  it('мусор вместо хеша не проходит и не бросает', async () => {
    expect(await verifyPassword('пароль', 'мусор')).toBe(false)
    expect(await verifyPassword('пароль', '')).toBe(false)
    expect(await verifyPassword('пароль', 'md5$aa$bb')).toBe(false)
  })
})

describe('полномочия по ролям', () => {
  it('стойка решает вопросы очереди', () => {
    // Клиент стоит у прилавка — эти действия нужны немедленно.
    expect(can('counter', 'order.issue_on_mismatch')).toBe(true)
    expect(can('counter', 'order.cancel')).toBe(true)
    expect(can('counter', 'noshow.clear')).toBe(true)
  })

  it('⚠️ стойка НЕ трогает деньги и инвентарь', () => {
    expect(can('counter', 'price.override')).toBe(false)
    expect(can('counter', 'deposit.charge')).toBe(false)
    expect(can('counter', 'inventory.write_off')).toBe(false)
    expect(can('counter', 'prepay.waive')).toBe(false)
  })

  it('техник — только обслуживание и DIN', () => {
    expect(can('technician', 'service.record')).toBe(true)
    expect(can('technician', 'din.record')).toBe(true)
    // Заказы и деньги — нет.
    expect(can('technician', 'order.cancel')).toBe(false)
    expect(can('technician', 'reports.revenue')).toBe(false)
  })

  it('администратор не управляет сотрудниками, ключами и тарифом', () => {
    expect(can('admin', 'inventory.manage')).toBe(true)
    expect(can('admin', 'price.manage')).toBe(true)
    // А это — только владелец.
    expect(can('admin', 'staff.manage')).toBe(false)
    expect(can('admin', 'integrations.manage')).toBe(false)
    expect(can('admin', 'plan.manage')).toBe(false)
  })

  it('владелец может всё', () => {
    const all = [
      'order.cancel', 'price.override', 'deposit.charge', 'inventory.write_off',
      'staff.manage', 'integrations.manage', 'plan.manage', 'din.record',
    ] as const

    for (const p of all) expect(can('owner', p)).toBe(true)
  })
})

describe('доступ к филиалам', () => {
  const session = (role: Session['activeRole'], branchIds: string[]): Session => ({
    sessionId: 's', tenantId: 't', staffId: 'a', activeStaffId: 'a',
    activeRole: role, activeName: 'Тест', branchIds,
  })

  it('⚠️ стойка видит только свои филиалы', () => {
    // RLS изолирует тенантов, но внутри тенанта нужна вторая граница:
    // иначе сотрудник одной точки видит ПД клиентов всей сети.
    const s = session('counter', ['branch-1'])

    expect(canAccessBranch(s, 'branch-1')).toBe(true)
    expect(canAccessBranch(s, 'branch-2')).toBe(false)
  })

  it('техник тоже ограничен филиалами', () => {
    const s = session('technician', ['branch-1'])

    expect(canAccessBranch(s, 'branch-2')).toBe(false)
  })

  it('владелец и админ — все филиалы тенанта', () => {
    // У них branch_ids пуст, и это не значит «ни одного».
    expect(canAccessBranch(session('owner', []), 'любой')).toBe(true)
    expect(canAccessBranch(session('admin', []), 'любой')).toBe(true)
  })
})
