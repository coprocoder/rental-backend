/**
 * Прогресс настройки для мастера (14.3).
 *
 * ⚠️ Прогресс считается ПО ФАКТИЧЕСКИМ ДАННЫМ, а не по галочкам
 * «шаг пройден». Галочка врёт: сотрудник прошёл шаг «заведите прайс»,
 * нажал «дальше» и ничего не создал — система считает прокат
 * настроенным, а первый же заказ падает без цены. Проверка данными
 * не расходится с реальностью по построению.
 *
 * ⚠️ Каждый шаг МОЖНО ПРОПУСТИТЬ, и мастер это не блокирует: прокат
 * настраивается урывками между клиентами, и требование «сначала
 * заполните всё» означает, что не заполнят ничего. Обязателен
 * фактически один шаг — филиал, без него не к чему привязать инвентарь.
 *
 * ⚠️ Тексты шагов живут ЗДЕСЬ, а не в gateway: это то, что прокат
 * читает на экране, а не то, что лежит в базе. Считает данные
 * `setup.gateway.ts`, смысл им придаёт этот файл.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { setupCounts } from '~/modules/tenant/database/setup.repository'

export interface SetupStep {
  key: string
  title: string
  hint: string
  done: boolean
  count: number
  to: string
  /** Без него система не работает; остальное можно отложить. */
  required: boolean
}

export async function getSetup(session: Session, deps: Deps) {

  return deps.db.tx(session.tenantId, async (c) => {
    const n = await setupCounts(c, session.tenantId)

    const steps: SetupStep[] = [
      {
        key: 'branch',
        title: 'Филиал',
        hint: 'Адрес, часовой пояс. Без филиала инвентарь не к чему привязать.',
        done: n.branches > 0,
        count: n.branches,
        to: '/admin/branches',
        required: true,
      },
      {
        key: 'inventory',
        title: 'Что сдаёте',
        hint: 'Категории и размеры. Можно начать с демо-данных и переделать под себя.',
        done: n.variants > 0,
        count: n.variants,
        to: '/admin/inventory',
        required: false,
      },
      {
        key: 'stock',
        title: 'Сколько есть',
        hint: 'Остатки по позициям. Пока их нет, система считает, что сдавать нечего.',
        done: n.stocked > 0,
        count: n.stocked,
        to: '/admin/inventory',
        required: false,
      },
      {
        key: 'price',
        title: 'Цены',
        hint: 'Правила с периодами: будни, выходные, от трёх дней. Без них заказ не посчитается.',
        done: n.priceRules > 0,
        count: n.priceRules,
        to: '/admin/pricing',
        required: false,
      },
      {
        key: 'schedule',
        title: 'Часы работы',
        hint: 'Без расписания система считает, что вы открыты круглосуточно.',
        done: n.scheduleRows > 0,
        count: n.scheduleRows,
        to: '/admin/schedule',
        required: false,
      },
      {
        key: 'staff',
        title: 'Сотрудники',
        hint: 'Стойка, техник. Работать можно и одному — тогда шаг лишний.',
        done: n.staff > 1,
        count: n.staff,
        to: '/admin/staff',
        required: false,
      },
    ]

    return {
      steps,
      done: steps.filter((s) => s.done).length,
      total: steps.length,
      /** Настроено ли достаточно, чтобы принять первый заказ. */
      canAcceptOrders: steps[0]!.done && n.variants > 0 && n.priceRules > 0,
      hasOrders: n.orders > 0,
    }
  })
}
