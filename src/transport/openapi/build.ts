/**
 * Сборка документа OpenAPI из реестра схем.
 *
 * ⚠️ Собирается ИЗ КОДА, а не пишется отдельно. Документация,
 * написанная рядом с кодом, расходится с ним за месяц — а публичный
 * API нужен внешним разработчикам: виджет встраивается в чужие сайты,
 * и там читают спецификацию, а не исходники (19.42).
 */
import { toJsonSchema } from '@valibot/to-json-schema'
import type { GenericSchema } from 'valibot'
import { documentedRoutes, type RouteDoc } from './registry'

/** Версия документа: та же, что у пакета. */
const VERSION = '0.1.0'

type Json = Record<string, unknown>

/**
 * ⚠️ `toJsonSchema` бросает на конструкциях, которых нет в JSON Schema
 * (например, на `v.custom`). Валить сборку из-за одного роута нельзя —
 * тогда спецификация не соберётся вовсе; вместо этого поле остаётся
 * без описания, а роут в документации присутствует.
 */
function convert(schema: GenericSchema): Json {
  try {
    const out = toJsonSchema(schema) as Json
    delete out.$schema
    return out
  } catch {
    return { type: 'object', description: 'Схема не выразима в JSON Schema' }
  }
}

/** `/v1/orders/:token` → `/api/v1/orders/{token}` */
function toOpenApiPath(path: string): string {
  return `/api${path}`.replace(/:([a-zA-Z]+)/g, '{$1}')
}

function paramsOf(path: string): Json[] {
  return [...path.matchAll(/:([a-zA-Z]+)/g)].map((m) => ({
    name: m[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }))
}

function queryParamsOf(schema: GenericSchema): Json[] {
  const js = convert(schema)
  const props = (js.properties ?? {}) as Record<string, Json>
  const required = (js.required ?? []) as string[]
  return Object.entries(props).map(([name, s]) => ({
    name,
    in: 'query',
    required: required.includes(name),
    schema: s,
  }))
}

function operationOf(r: RouteDoc): Json {
  const op: Json = {
    summary: r.summary,
    tags: [r.scope === 'public' ? 'Публичный API' : 'Рабочие экраны'],
    parameters: [...paramsOf(r.path), ...(r.query ? queryParamsOf(r.query) : [])],
    responses: {
      200: {
        description: 'Успех',
        content: { 'application/json': { schema: convert(r.response) } },
      },
      // ⚠️ Конверт ошибки один на весь API: `{ error: { code, message } }`.
      // Виджет реагирует на `code`, а не на текст — тексты переводятся.
      default: {
        description: 'Отказ',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                error: {
                  type: 'object',
                  properties: {
                    code: { type: 'string' },
                    message: { type: 'string' },
                    details: { type: 'object' },
                  },
                  required: ['code', 'message'],
                },
              },
              required: ['error'],
            },
          },
        },
      },
    },
  }
  if (r.body) {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: convert(r.body) } },
    }
  }
  return op
}

export function buildOpenApi(): Json {
  const paths: Record<string, Json> = {}

  for (const r of documentedRoutes()) {
    const p = toOpenApiPath(r.path)
    paths[p] = { ...(paths[p] ?? {}), [r.method]: operationOf(r) }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Прокат снаряжения — API',
      version: VERSION,
      description:
        'Публичный контур нужен для встраивания виджета бронирования '
        + 'в чужие сайты. Рабочие контуры (админка, стойка) требуют сессии '
        + 'сотрудника и описаны здесь же, чтобы фронт мог выводить типы ответов.',
    },
    paths,
  }
}
