# Короткие команды. `make help` — список.
.PHONY: help install dev up down reset psql check typecheck test arch baseline build worker migrate seed

help:  ## Показать список команд
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install:  ## Поставить зависимости
	npm install

dev: up migrate ## Поднять БД и запустить сервис — основная команда
	npm run dev

up:  ## Поднять Postgres и сопутствующие сервисы
	docker compose up -d --wait
	@echo ""
	@echo "  Postgres  localhost:55432   rental/rental"
	@echo "  Почта     http://localhost:58025"
	@echo ""

down:  ## Остановить сервисы, данные сохраняются
	docker compose down

reset:  ## Снести всё вместе с данными и развернуть заново
	docker compose down -v
	docker compose up -d --wait
	npm run db:migrate
	npm run db:seed
	@echo "Окружение пересобрано с чистой БД."

psql:  ## Консоль psql
	docker compose exec postgres psql -U rental -d rental

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
