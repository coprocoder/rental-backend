/**
 * Сценарии настроек проката: тема, сотрудники, филиалы, тариф, сводка дня.
 */
import type { Deps } from '~/kernel/deps'
import type { Session } from '~/kernel/session'
import { pickTheme } from '~/common/utils/theme'
import { todayScreen } from '~/domain/admin/admin'
import {
  allPlans, branchRows, planUsage, scheduleRows, staffRows, tenantTheme,
} from '../database/tenant.repository'

export async function getTheme(session: Session, deps: Deps) {
  return deps.db.tx(session.tenantId, async (c) => {
    const row = await tenantTheme(c, session.tenantId)
    return { theme: pickTheme(row?.theme), tenantName: row?.name ?? '' }
  })
}

export async function getStaff(session: Session, deps: Deps) {
  return deps.db.tx(session.tenantId, async (c) => ({
    staff: await staffRows(c, session.tenantId),
  }))
}

export async function getBranches(session: Session, deps: Deps) {
  return deps.db.tx(session.tenantId, async (c) => ({
    branches: await branchRows(c, session.tenantId),
    schedule: await scheduleRows(c, session.tenantId),
  }))
}

/**
 * Экран «Сегодня» — главный экран админки.
 *
 * ⚠️ Не дашборд с графиками, а список того, что требует ДЕЙСТВИЯ
 * сегодня: графики можно посмотреть когда угодно, а просроченный
 * возврат и упавшая отправка требуют вмешательства сейчас.
 */
export async function getToday(session: Session, deps: Deps) {
  return deps.db.tx(session.tenantId, (c) => todayScreen(c, {
    tenantId: session.tenantId,
    branchIds: session.activeRole === 'owner' || session.activeRole === 'admin'
      ? []
      : session.branchIds,
  }))
}

/**
 * Тариф и лимиты (14.4, 14.5).
 *
 * ⚠️ Отдаёт и СОСТОЯНИЕ подписки, и то, что произойдёт при неоплате:
 * градация должна быть известна заранее.
 */
export async function getPlan(session: Session, deps: Deps) {
  return deps.db.tx(session.tenantId, async (c) => {
    const r = await planUsage(c, session.tenantId)
    const all = await allPlans(c)

    const paidUntil = r?.paid_until ?? null
    // ⚠️ Часы из deps, а не new Date(): половина логики зависит от
    // «сейчас», и без подменяемых часов такие сценарии тестируются
    // только ожиданием.
    const now = deps.clock()
    const daysLeft = paidUntil
      ? Math.ceil((paidUntil.getTime() - now.getTime()) / 86_400_000)
      : null

    return {
      plans: all.map((p) => ({
        code: p.code,
        name: p.name,
        limits: p.limits ?? {},
        pricePerMonth: p.price,
      })),
      planCode: r?.plan_code ?? null,
      planName: r?.plan_name ?? null,
      limits: r?.limits ?? null,
      paidUntil,
      daysLeft,
      // ⚠️ Льготный период 7 дней: за него прокат успевает заметить
      // и оплатить, а мы не теряем клиента из-за забытого платежа
      // в разгар сезона.
      inGrace: daysLeft !== null && daysLeft <= 0 && daysLeft > -7,
      restricted: daysLeft !== null && daysLeft <= -7,
      usage: {
        branches: r?.branches ?? 0,
        variants: r?.variants ?? 0,
        ordersThisMonth: r?.orders_this_month ?? 0,
      },
    }
  })
}
