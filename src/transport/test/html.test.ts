/**
 * Документ для человека: HTML вместо JSON (19.44).
 *
 * ⚠️ Под этим текстом клиент ставит подпись, нажимая «соглашаюсь».
 * Раньше по ссылке из формы открывалось
 * `{"version":"v1","text":"⚠️ ТИПОВАЯ…` — договор в фигурных скобках
 * с экранированными переносами строк.
 */
import { describe, expect, it } from 'vitest'
import { documentPage, escapeHtml, wantsHtml } from '../html'

describe('выбор формы ответа', () => {
  /**
   * ⚠️ По `Accept`, а не по параметру в адресе: один адрес остаётся
   * и документом для человека, и JSON для виджета в чужом сайте.
   * Менять форму для всех было нельзя — это публичный API.
   */
  it('браузер по ссылке получает разметку', () => {
    expect(wantsHtml('text/html,application/xhtml+xml,application/xml;q=0.9')).toBe(true)
  })

  it('вызов из кода получает JSON', () => {
    expect(wantsHtml('application/json')).toBe(false)
    expect(wantsHtml(undefined)).toBe(false)
    expect(wantsHtml('*/*')).toBe(false)
  })
})

describe('страница документа', () => {
  it('переносы строк сохраняются', () => {
    // ⚠️ Нумерация пунктов договора держится на переносах и отступах.
    const html = documentPage({ title: 'Договор', version: 'v2', text: '1. Первый\n2. Второй' })

    expect(html).toContain('white-space: pre-wrap')
    expect(html).toContain('1. Первый\n2. Второй')
  })

  it('показывает название и редакцию', () => {
    const html = documentPage({ title: 'Правила проката', version: 'v3', text: 'текст' })

    expect(html).toContain('Правила проката')
    expect(html).toContain('Редакция v3')
  })

  /**
   * ⚠️ Текст приходит ОТ ТЕНАНТА: владелец правит договор через
   * админку. Незакрытый тег в его тексте сломал бы страницу, а скрипт —
   * выполнился бы в браузере клиента.
   */
  it('разметка из текста тенанта не исполняется', () => {
    const html = documentPage({
      title: 'Оферта',
      version: 'v1',
      text: '<script>alert(1)</script> и <b>жирный</b>',
    })

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('экранирует и название', () => {
    expect(documentPage({ title: '<b>X</b>', version: 'v1', text: '' })).not.toContain('<b>X</b>')
  })
})

describe('escapeHtml', () => {
  it('закрывает символы, ломающие разметку и атрибуты', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
  })
})
