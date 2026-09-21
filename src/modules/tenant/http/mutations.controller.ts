/**
 * Мутации модуля `tenant`.
 *
 * ⚠️ Право и тариф — ДВЕ РАЗНЫЕ проверки, и для мутаций цена ошибки
 * выше, чем для чтения: забытая проверка тарифа раздаёт платную
 * функцию, забытое право — доступ к чужим действиям.
 */
import type { App } from '~/transport/types'
import type { Deps } from '~/kernel/deps'
import * as v from 'valibot'
import { documentRoute } from '~/transport/openapi/registry'
import { SESSION_COOKIE, requirePermission, requirePlanFeature } from '~/kernel/session'
import { postBranches, BranchesBody } from '../service/branches.mutation'
import { postSchedule, ScheduleBody } from '../service/schedule.mutation'
import { postTexts, TextsBody } from '../service/texts.mutation'
import { postTheme, ThemeBody } from '../service/theme.mutation'
import { postIntegrations, IntegrationsBody } from '../service/integrations.mutation'
import { postPlan, PlanBody } from '../service/plan.mutation'
import { postPrivacy, PrivacyBody } from '../service/privacy.mutation'
import { postStaff, StaffBody } from '../service/staff.mutation'

/**
 * ⚠️ Схемы ТЕЛ не переписываются здесь, а импортируются из сервисов —
 * там они уже написаны и ими же валидируется запрос. Копия в
 * контроллере стала бы третьей правдой и разошлась бы на первой правке.
 *
 * ⚠️ Ответы мутаций описываются ОТДЕЛЬНО: у части роутов форма зависит
 * от действия (`branches` отдаёт разное на create/clone/archive), и
 * вывести её из тела нельзя.
 */

/** Подтверждение без данных — самый частый ответ мутации. */
const Ok = v.object({ ok: v.literal(true) })

documentRoute({ method: 'post', path: '/v1/admin/branches', scope: 'staff',
  body: BranchesBody,
  // ⚠️ Форма зависит от действия, поэтому вариант, а не один объект.
  // `clone` отдаёт ЧЕТЫРЕ поля — фронт объявлял руками два
  // (`variants`, `priceRules`) и молча терял `branchId` и `scheduleRows`.
  response: v.union([
    v.object({ id: v.pipe(v.string(), v.uuid()) }),
    v.object({ updated: v.literal(true) }),
    v.object({ archived: v.literal(true) }),
    v.object({
      branchId: v.pipe(v.string(), v.uuid()),
      variants: v.number(),
      priceRules: v.number(),
      scheduleRows: v.number(),
    }),
    /**
     * ⚠️ Стартовый профиль (`action: 'profile'`) — ПЯТАЯ форма, и я её
     * сначала пропустил: в схеме было четыре. Поймал не человек, а
     * вывод типов на фронте — экран присваивал ответ переменной
     * `{ categories, variants, skipped }`, и компилятор показал, что
     * такой формы в схеме нет. Ровно та защита, ради которой
     * описывались мутации.
     */
    v.object({
      categories: v.number(),
      variants: v.number(),
      /** Что пропущено: позиции, уже заведённые в филиале. */
      skipped: v.array(v.string()),
    }),
  ]),
  summary: 'Филиалы: создание, правка, архив, клонирование, стартовый профиль' })

documentRoute({ method: 'post', path: '/v1/admin/schedule', scope: 'staff',
  body: ScheduleBody, response: Ok,
  summary: 'Расписание филиала: часы работы и исключения по датам' })

documentRoute({ method: 'post', path: '/v1/admin/texts', scope: 'staff',
  body: TextsBody,
  // ⚠️ Возвращается ВСЯ опубликованная редакция, а не только номер:
  // фронт объявлял `{ version: number }` — правда, но семь полей из
  // восьми терялись.
  response: v.object({
    id: v.pipe(v.string(), v.uuid()),
    kind: v.string(),
    version: v.number(),
    body: v.string(),
    /** Отпечаток текста: по нему видно, ту ли редакцию подписал клиент. */
    hash: v.string(),
    isActive: v.boolean(),
    createdAt: v.string(),
    createdBy: v.nullable(v.string()),
  }),
  summary: 'Публикация редакции правового текста: договор, политика, правила' })

documentRoute({ method: 'post', path: '/v1/admin/theme', scope: 'staff',
  body: ThemeBody,
  response: v.object({
    theme: v.record(v.string(), v.unknown()),
    /**
     * Вердикт по контрасту возвращается ВМЕСТЕ с сохранённым, чтобы
     * предупреждение осталось на экране после сохранения, а не исчезло
     * вместе с формой.
     */
    contrast: v.nullable(v.record(v.string(), v.unknown())),
  }),
  summary: 'Тема тенанта: цвета, логотип, проверка контраста' })

documentRoute({ method: 'post', path: '/v1/admin/integrations', scope: 'staff',
  body: IntegrationsBody,
  response: v.object({ ok: v.literal(true), botUsername: v.nullable(v.string()) }),
  summary: 'Подключение мессенджера тенанта: Telegram или MAX' })

documentRoute({ method: 'post', path: '/v1/admin/plan', scope: 'staff',
  body: PlanBody,
  response: v.object({ planCode: v.string(), planName: v.string() }),
  summary: 'Смена тарифа проката' })

documentRoute({ method: 'post', path: '/v1/admin/privacy', scope: 'staff',
  body: PrivacyBody,
  /**
   * ⚠️ Форма НЕ раскрыта намеренно: выгрузка отдаёт
   * `Record<string, Record<string, unknown>[]>` — набор таблиц, состав
   * которых зависит от данных тенанта. Описать его точнее значило бы
   * выдумать структуру, которой в коде нет.
   */
  response: v.record(v.string(), v.unknown()),
  summary: 'Права субъекта ПД: выгрузка, удаление, выгрузка всего тенанта' })

documentRoute({ method: 'post', path: '/v1/admin/staff', scope: 'staff',
  body: StaffBody,
  response: v.union([
    v.object({ id: v.pipe(v.string(), v.uuid()) }),
    v.object({ updated: v.literal(true) }),
    v.object({ archived: v.literal(true) }),
    v.object({ unlocked: v.literal(true) }),
  ]),
  summary: 'Сотрудники: приглашение, правка, архив, снятие блокировки, PIN' })

export function registerTenantMutations(app: App, deps: Deps): void {
  app.post('/v1/admin/branches', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'inventory.manage', 'multiBranch')
    return postBranches(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/schedule', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'inventory.manage', 'advancedInventory')
    return postSchedule(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/texts', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'staff.manage', 'branding')
    return postTexts(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/theme', async (httpReq) => {
    const s = await requirePlanFeature(deps.db, httpReq.cookies[SESSION_COOKIE], 'staff.manage', 'branding')
    return postTheme(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/integrations', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'integrations.manage')
    return postIntegrations(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/plan', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'plan.manage')
    return postPlan(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/privacy', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'staff.manage')
    return postPrivacy(s, { body: httpReq.body }, deps)
  })
  app.post('/v1/admin/staff', async (httpReq) => {
    const s = await requirePermission(httpReq.cookies[SESSION_COOKIE], 'staff.manage')
    return postStaff(s, { body: httpReq.body }, deps)
  })
}
