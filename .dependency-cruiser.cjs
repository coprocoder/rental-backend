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
        'Общий транспортный набор (src/transport) доступен только транспортному слою '
        + 'модулей, сборке приложения и самому себе. Если в него ходят usecase, domain '
        + 'или gateway — значит бизнес-логика узнала про HTTP, и переносимость потеряна.',
      from: {
        pathNot: [
          '^src/transport/',
          '^src/main\\.ts$',
          '^src/modules/[^/]+/transport/',
          // ⚠️ Реестр модулей — часть сборки приложения, а не бизнес-слой:
          // он существует ровно для того, чтобы зарегистрировать маршруты.
          '^src/modules/registry\\.ts$',
        ],
      },
      to: { path: '^src/transport/' },
    },
    {
      name: 'usecase-no-http',
      severity: 'error',
      comment:
        'usecase не знает про HTTP. Как только в сигнатуру попадает объект запроса, '
        + 'сценарий нельзя вызвать из воркера, из теста и из мобильного приложения стойки.',
      from: { path: '/usecase/' },
      to: { path: 'node_modules/(fastify|@fastify)' },
    },
    {
      name: 'domain-no-io',
      severity: 'error',
      comment:
        'domain не делает ввод-вывод: ни gateway, ни pg, ни внешних систем. '
        + 'Правила предметной области обязаны проверяться без базы — иначе их '
        + 'не покрывают тестами, а значит не покрывают вовсе.',
      from: { path: '/domain/' },
      to: { path: '(/gateway/|/integrations/|node_modules/pg)' },
    },
    {
      name: 'gateway-no-http',
      severity: 'error',
      comment:
        'gateway не знает про HTTP. Шлюз, бросающий HTTP-ошибку, это маршрут в маскировке: '
        + 'его нельзя переиспользовать вторым эндпоинтом.',
      from: { path: '/gateway/' },
      to: { path: '(^src/transport|node_modules/(fastify|@fastify))' },
    },
    {
      name: 'module-private-internals',
      severity: 'error',
      comment:
        'Модуль виден снаружи только через *.public.ts. Иначе через год всё связано со всем, '
        + 'и переименование колонки ломает чужой модуль.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/',
        pathNot: [
          '^src/modules/$1/',
          '^src/modules/[^/]+/[^/]+\\.public\\.ts$',
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
      name: 'shared-is-leaf',
      severity: 'error',
      comment:
        'shared ни от чего не зависит: это контракт с фронтом, и любая его зависимость '
        + 'уезжает в браузерный бандл.',
      from: { path: '^src/shared/' },
      to: { pathNot: '^src/shared/' },
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
        + '⚠️ src/shared исключён НАМЕРЕННО и временно: это контракт с фронтом, '
        + 'и пока переехала часть эндпоинтов, часть его модулей ещё никем здесь не '
        + 'используется. Убрать исключение, когда переезд завершится, — иначе '
        + 'правило перестанет ловить настоящие потери.',
      from: {
        orphan: true,
        pathNot: ['^src/main\\.ts$', '\\.d\\.ts$', '^src/shared/'],
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
