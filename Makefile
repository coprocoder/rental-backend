# Короткие команды. `make help` — список.
.PHONY: help install dev check typecheck test arch baseline build worker migrate seed

help:  ## Показать список команд
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install:  ## Поставить зависимости
	npm install

dev:  ## Запустить сервис с перезапуском по изменению
	npm run dev

check: typecheck test arch  ## Всё, что гоняет CI

typecheck:  ## Проверить типы
	npm run typecheck

test:  ## Прогнать тесты
	npm test

arch:  ## Проверить границы слоёв и модулей
	npm run arch

baseline:  ## Сверить ответы с эталоном старого стенда (нужны оба сервиса)
	.claude/skills/baseline/compare.sh all

build:  ## Собрать в dist/
	npm run build

worker:  ## Запустить фоновый обработчик
	npm run worker

migrate:  ## Накатить миграции: сгенерированные, затем ручной SQL
	npm run db:migrate

seed:  ## Залить демо-данные, идемпотентно
	npm run db:seed
