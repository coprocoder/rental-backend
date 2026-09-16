/**
 * Границы слоёв и модулей — проверкой, а не договорённостью.
 *
 * ⚠️ Определяющий признак модульного монолита — границы, которые НЕЛЬЗЯ
 * нарушить, а не папки с красивыми именами. Сейчас связность низкая, и
 * держится она на вкусе разработчика: достаточно одного «мне нужно только
 * одно поле из их таблицы», и через год вернуться назад невозможно.
 *
 * Семь правил из `plans/06-ЭТАПЫ.md`. Каждое несёт причину: причина —
 * это то, что делает правило исполнимым, а не формальным.
 */
module.exports = {
  forbidden: [
    {
      name: 'transport-is-top',
      severity: 'error',
      comment:
        'Общий транспортный набор (src/transport) доступен только HTTP-слою '
        + 'модулей, сборке приложения и самому себе. Если в него ходят service, domain '
        + 'или database — значит бизнес-логика узнала про HTTP, и переносимость потеряна.',
      from: {
        pathNot: [
          '^src/transport/',
          '^src/main\\.ts$',
          '^src/modules/[^/]+/http/',
          // ⚠️ Реестр модулей — часть сборки приложения, а не бизнес-слой:
          // он существует ровно для того, чтобы зарегистрировать маршруты.
          '^src/modules/registry\\.ts$',
        ],
      },
      to: { path: '^src/transport/' },
    },
    {
      name: 'service-no-http',
      severity: 'error',
      comment:
        'Сервис не знает про HTTP. Как только в сигнатуру попадает объект запроса, '
        + 'сценарий нельзя вызвать из воркера, из теста и из мобильного приложения стойки.',
      from: { path: '/service/' },
      to: { path: 'node_modules/(fastify|@fastify)' },
    },
    {
      name: 'domain-no-io',
      severity: 'error',
      comment:
        'domain не делает ввод-вывод: ни запросов к БД, ни pg, ни внешних систем. '
        + 'Правила предметной области обязаны проверяться без базы — иначе их '
        + 'не покрывают тестами, а значит не покрывают вовсе.',
      from: { path: '/domain/' },
      to: { path: '(/database/|/integrations/|node_modules/pg)' },
    },
    {
      name: 'database-no-http',
      severity: 'error',
      comment:
        'Слой БД не знает про HTTP. Запрос, бросающий HTTP-ошибку, это маршрут в '
        + 'маскировке: его нельзя переиспользовать вторым сценарием.',
      from: { path: '/database/' },
      to: { path: '(^src/transport|node_modules/(fastify|@fastify))' },
    },
    {
      name: 'module-private-internals',
      severity: 'error',
      comment:
        'Модуль виден снаружи только через свой index.ts. Иначе через год всё связано '
        + 'со всем, и переименование колонки ломает чужой модуль.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/',
        pathNot: [
          '^src/modules/$1/',
          '^src/modules/[^/]+/index\\.ts$',
        ],
      },
    },
    {
      name: 'no-module-cycles',
      severity: 'error',
      comment:
        'Цикл между модулями = один модуль, разложенный по двум каталогам.',
      from: { path: '^src/modules/' },
      to: { circular: true },
    },
    {
      name: 'common-is-leaf',
      severity: 'error',
      comment:
        'common ни от чего не зависит: там контракт с фронтом и чистые утилиты, и любая '
        + 'его зависимость уезжает в браузерный бандл.',
      from: { path: '^src/common/' },
      to: { pathNot: '^src/common/' },
    },
    {
      name: 'kernel-knows-no-domain',
      severity: 'error',
      comment:
        'kernel не знает предметную область. Как только он про неё узнал, он перестал '
        + 'быть kernel и стал модулем, от которого зависят все.',
      from: { path: '^src/kernel/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'Файл, который никто не импортирует, чаще всего забыт, а не нужен.\n'
        + '⚠️ src/common исключён НАМЕРЕННО и временно: там контракт с фронтом, '
        + 'и пока переехала часть эндпоинтов, часть его модулей ещё никем здесь не '
        + 'используется. Убрать исключение, когда переезд завершится, — иначе '
        + 'правило перестанет ловить настоящие потери.',
      from: {
        orphan: true,
        pathNot: ['^src/main\\.ts$', '\\.d\\.ts$', '^src/common/'],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: { path: '(\\.test\\.ts$|/test/)' },
  },
}
