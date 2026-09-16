/**
 * Рубильники функций по тенанту (17.19).
 *
 * ⚠️ ОТДЕЛЬНО от тарифа, и это принципиально. Тариф отвечает «за что
 * заплачено», рубильник — «что сейчас включено»:
 *   прокат выключает онлайн-бронирование на два дня инвентаризации —
 *     он не менял тариф;
 *   у одного тенанта сломалась интеграция и её надо погасить именно
 *     ему — менять план из-за аварии нельзя;
 *   новую функцию раскатывают на три проката из ста — это не тариф.
 * Смешать значит менять тарифный план ради временной операции,
 * а потом объяснять, почему в счёте другой план.
 *
 * ⚠️ Рубильник переопределяет тариф В ОБЕ СТОРОНЫ: можно выключить
 * оплаченное и включить неоплаченное. Второе нужно не реже первого —
 * пилот, компенсация за аварию, тестирование новой функции.
 *
 * ⚠️ Ставит их ПЛАТФОРМА, а не тенант. Смысл в том, чтобы поддержка
 * могла погасить функцию у конкретного проката — в том числе когда
 * у самого проката всё «работает». Поэтому у tenant_flag нет RLS
 * и нет прав на запись у прикладной роли.
 */
import type { PoolClient } from 'pg'
import { apiError } from '~/kernel/errors'

/**
 * Известные рубильники.
 *
 * ⚠️ Список здесь, а не enum в БД: имена меняются чаще схемы,
 * а неизвестное имя в таблице просто не находит потребителя
 * и ничего не ломает.
 */
export const FLAGS = {
  online_booking: 'Онлайн-бронирование',
  notifications: 'Уведомления клиентам',
  waitlist: 'Лист ожидания',
  widget: 'Встраиваемый виджет',
  reports: 'Отчёты',
} as const

export type FlagName = keyof typeof FLAGS

export interface Flag {
  flag: string
  enabled: boolean
  reason: string
  until: Date | null
  setAt: Date
}

/**
 * Действующие рубильники тенанта.
 *
 * ⚠️ Истёкшие НЕ возвращаются: временный рубильник, о котором забыли,
 * иначе продолжал бы гасить функцию молча. Строка остаётся в таблице
 * как след, но перестаёт действовать сама.
 */
export async function activeFlags(
  c: PoolClient,
  tenantId: string,
): Promise<Map<string, Flag>> {
  const { rows } = await c.query<Record<string, unknown>>(
    `SELECT flag, enabled, reason, until, set_at
     FROM tenant_flag
     WHERE tenant_id = $1 AND (until IS NULL OR until > now())`,
    [tenantId],
  )
  return new Map(rows.map((r) => [r.flag as string, {
    flag: r.flag as string,
    enabled: r.enabled as boolean,
    reason: r.reason as string,
    until: (r.until as Date) ?? null,
    setAt: r.set_at as Date,
  }]))
}

/**
 * Включена ли функция.
 *
 * ⚠️ Умолчание передаётся вызывающим, а не берётся отсюда: что считать
 * включённым по умолчанию, знает тариф, а не этот модуль. Отсутствие
 * рубильника означает «решения нет» — и тогда работает умолчание,
 * а не «выключено».
 */
export function isEnabled(
  flags: Map<string, Flag>,
  name: FlagName,
  fallback: boolean,
): boolean {
  return flags.get(name)?.enabled ?? fallback
}

/**
 * Ставит или снимает рубильник.
 *
 * ⚠️ Причина обязательна (железное правило №13) и проверяется ещё и
 * в БД: через месяц «почему у них выключено бронирование» иначе
 * не выяснить, а спросить будет уже некого.
 */
export async function setFlag(
  c: PoolClient,
  opts: {
    tenantId: string
    flag: FlagName
    enabled: boolean
    reason: string
    /** Временный рубильник: снимется сам. */
    until?: Date | null
    staffId?: string
  },
): Promise<void> {
  if (opts.reason.trim().length < 3) {
    throw apiError('VALIDATION_FAILED', 'Рубильник требует причины')
  }

  await c.query(
    `INSERT INTO tenant_flag (tenant_id, flag, enabled, reason, until, set_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, flag) DO UPDATE
       SET enabled = excluded.enabled,
           reason  = excluded.reason,
           until   = excluded.until,
           set_by  = excluded.set_by,
           set_at  = now()`,
    [opts.tenantId, opts.flag, opts.enabled, opts.reason.trim(),
     opts.until ?? null, opts.staffId ?? null],
  )
}

/** Снимает рубильник целиком: тенант возвращается к умолчанию тарифа. */
export async function clearFlag(
  c: PoolClient,
  opts: { tenantId: string, flag: FlagName },
): Promise<void> {
  await c.query(
    `DELETE FROM tenant_flag WHERE tenant_id = $1 AND flag = $2`,
    [opts.tenantId, opts.flag],
  )
}
