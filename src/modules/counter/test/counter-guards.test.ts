/**
 * Стойка закрыта СЕРВЕРОМ, а не скрытым пунктом меню.
 *
 * ⚠️ Дефект, который этим закрыт. Комментарий в оболочке фронта
 * (`app/layouts/staff.vue`) утверждал, что технику стойка закрыта
 * сервером. В действительности выдача, возврат, смена и выдача без
 * брони стояли на `requireSession`, то есть на «вошёл хоть кем-то»:
 * роль `technician` не видела стойку в меню, но могла выполнить выдачу
 * запросом к API. Скрытый пункт меню — удобство, граница — сервер.
 *
 * ⚠️ Почему тест читает ИСХОДНЫЙ ТЕКСТ, а не вызывает роуты. Охрана
 * живёт в строке регистрации маршрута, и ошибка здесь — это НЕ
 * исключение, а молчаливое ослабление: `requireSession` вместо
 * `requirePermission` работает, отвечает 200 и выглядит правильно.
 * Проверять это ответом API значило бы поднимать сессию каждой из
 * четырёх ролей на каждый из двенадцати роутов; проверка текста ловит
 * ту же ошибку в точке, где её совершают.
 *
 * ⚠️ Список роутов НЕ перечислен руками, а вычитывается из файлов:
 * новый роут стойки без записи в таблице ниже валит тест. Ручной
 * список устарел бы молча — и тест перестал бы что-либо проверять
 * (тот же довод, что в `transport/openapi/test/against-baseline.test.ts`).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ROLE_PERMISSIONS, roleCan, type Permission } from '~/common/contract/permissions'
import type { StaffRole } from '~/common/contract/permissions'

const here = dirname(fileURLToPath(import.meta.url))
const http = join(here, '../http')

const sources = {
  queries: readFileSync(join(http, 'counter.controller.ts'), 'utf8'),
  mutations: readFileSync(join(http, 'mutations.controller.ts'), 'utf8'),
}

/**
 * Какое право закрывает каждый роут стойки.
 *
 * ⚠️ `catalog` — тоже `order.confirm`, хотя его зовут ТРИ экрана вне
 * стойки: массовые операции, импорт инвентаря и смена. Проверено, что
 * это безопасно: их пункты меню стоят на `inventory.manage`, которое
 * есть только у `owner` и `admin`, а у обоих есть и `order.confirm`.
 * Инвентарного права сюда поставить НЕЛЬЗЯ по обратной причине: у роли
 * `counter` его нет вовсе, а каталог ей нужен для выдачи.
 *
 * ⚠️ `din` остаётся на `din.record` — это единственный роут стойки,
 * доступный технику, и ради него ужесточение и затевалось: право
 * записи DIN есть у всех ролей, потому что DIN проверяет тот, кто
 * крепления реально держал в руках.
 */
const REQUIRED: Record<string, Permission> = {
  // Действия с последствиями: выдать, принять, открыть смену.
  issue: 'order.confirm',
  return: 'order.confirm',
  'walk-in': 'order.confirm',
  shift: 'order.confirm',
  incident: 'order.confirm',
  upsell: 'order.confirm',
  // Очередь и данные заказа — то же право, что на сам заказ.
  orders: 'order.confirm',
  history: 'order.confirm',
  'free-items': 'order.confirm',
  'item-lookup': 'order.confirm',
  // Инвентарные роуты.
  catalog: 'order.confirm',
  stocktake: 'inventory.manage',
  // Работы техника.
  din: 'din.record',
}

/** Все роуты стойки с их охраной, вычитанные из регистрации. */
function routesWithGuards(): { name: string, guard: string, permission?: string }[] {
  const found: { name: string, guard: string, permission?: string }[] = []
  for (const text of Object.values(sources)) {
    const re = /app\.(?:get|post)\('\/v1\/counter\/([^']+)',[\s\S]*?await (requireSession|requirePermission|requirePlanFeature)\([^)]*?(?:'([a-z.]+)')?\)/g
    for (const m of text.matchAll(re)) {
      found.push({ name: m[1]!, guard: m[2]!, permission: m[3] })
    }
  }
  return found
}

describe('охрана роутов стойки', () => {
  const routes = routesWithGuards()

  it('находит все роуты стойки в регистрации', () => {
    // Защита от самого теста: сломанное регулярное выражение не должно
    // выглядеть как «нарушений нет».
    expect(routes.length, 'роуты стойки не разобрались — проверь регулярное выражение')
      .toBeGreaterThanOrEqual(13)
  })

  it('у каждого роута объявлено требуемое право', () => {
    const unlisted = routes.filter((r) => !(r.name in REQUIRED)).map((r) => r.name)
    expect(unlisted, 'новый роут стойки без записи в REQUIRED: решение о праве не принято')
      .toEqual([])
  })

  it('ни один роут не стоит на одной сессии', () => {
    const weak = routes.filter((r) => r.guard === 'requireSession').map((r) => r.name)
    expect(weak, 'роут стойки открыт любому вошедшему: граница — сервер, а не меню')
      .toEqual([])
  })

  it('проверяется именно то право, которое объявлено', () => {
    const wrong = routes
      .filter((r) => r.permission !== REQUIRED[r.name])
      .map((r) => `${r.name}: ${r.permission ?? 'нет'} вместо ${REQUIRED[r.name]}`)
    expect(wrong, 'охрана роута расходится с объявленным правом').toEqual([])
  })
})

describe('последствия для ролей', () => {
  /** Роли, у которых роут стойки остаётся доступным. */
  function rolesAllowed(permission: Permission): StaffRole[] {
    return (Object.keys(ROLE_PERMISSIONS) as StaffRole[])
      .filter((role) => roleCan(role, permission))
  }

  it('техник не может выполнить выдачу', () => {
    // ⚠️ Это и есть исходный дефект, выраженный через роль.
    expect(rolesAllowed(REQUIRED.issue!)).not.toContain('technician')
    expect(rolesAllowed(REQUIRED.return!)).not.toContain('technician')
    expect(rolesAllowed(REQUIRED['walk-in']!)).not.toContain('technician')
  })

  it('техник сохраняет свои работы: DIN остаётся доступен', () => {
    // Иначе ужесточение сломало бы ровно ту роль, ради которой затевалось.
    expect(rolesAllowed(REQUIRED.din!)).toContain('technician')
  })

  it('стойка работает в полном объёме', () => {
    for (const name of ['issue', 'return', 'walk-in', 'shift', 'orders', 'catalog'] as const) {
      expect(rolesAllowed(REQUIRED[name]!), `роль counter потеряла ${name}`)
        .toContain('counter')
    }
  })

  it('инвентарные экраны вне стойки не ломаются', () => {
    // ⚠️ /admin/bulk и /admin/inventory/import зовут counter/catalog,
    // а их пункты меню закрыты inventory.manage. Ужесточение каталога
    // до order.confirm безопасно ровно потому, что всякая роль с
    // inventory.manage имеет и order.confirm — иначе экран, видимый в
    // меню, отвечал бы 403.
    const canInventory = (Object.keys(ROLE_PERMISSIONS) as StaffRole[])
      .filter((role) => roleCan(role, 'inventory.manage'))
    for (const role of canInventory) {
      expect(roleCan(role, REQUIRED.catalog!), `роль ${role} видит инвентарь, но потеряет каталог`)
        .toBe(true)
    }
  })
})
