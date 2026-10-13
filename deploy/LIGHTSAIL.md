# Публикация на AWS Lightsail

Все шаги ниже выполняет человек — владелец AWS-аккаунта. Агент только подготовил файлы.

> **До начала:** получите согласование руководства на хранение рабочих задач в AWS
> и решите, на чей аккаунт (личный или компании) оформляется Lightsail.

## 1. Сервер
1. Откройте <https://lightsail.aws.amazon.com> → **Create instance**.
2. Регион: **Frankfurt (eu-central-1)**. Платформа: **Linux/Unix**, образ: **OS Only → Ubuntu 24.04 LTS**.
3. План: **2 GB RAM** (хватает с запасом; 1 GB тоже работает).
4. Создайте инстанс, затем **Networking → Create static IP** и привяжите его к инстансу.
5. **Networking → IPv4 Firewall**: оставьте SSH (22), добавьте **HTTP (80)** и **HTTPS (443)**.
   SSH лучше ограничить своим IP («Restrict to IP address»).
6. **Snapshots → Enable automatic snapshots** — ежедневная резервная копия всего сервера (база, аватарки, мелодии).

## 2. Домен
У регистратора домена создайте A-запись, например `planner.ваш-домен` → статический IP из шага 1.4.
Без домена HTTPS не выпустится.

## 3. Установка
Подключитесь через кнопку **Connect using SSH** в Lightsail и выполните:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker
git clone https://github.com/gyysara/Planner.git planner && cd planner
cp .env.example .env
nano .env        # DOMAIN, INVITE_CODE, (позже) TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME
chmod 600 .env
docker compose up -d --build
```

Через 1–2 минуты откройте `https://ваш-домен` — должна появиться форма входа.

## 4. Telegram-бот
1. В Telegram откройте **@BotFather** → `/newbot`, задайте имя и username бота.
2. Скопируйте ключ (token) и username в `.env` на сервере — **только туда**, не в код и не в чат.
3. Перезапустите: `docker compose up -d`.
4. Каждый пользователь в планнере: **Настройки → Подключить Telegram → Start** в боте.

## 5. Обновление и обслуживание
```bash
cd ~/planner && git pull && docker compose up -d --build   # обновить
docker compose logs -f app                                  # журнал
docker compose exec app node --disable-warning=ExperimentalWarning scripts/delete-user.js <логин>   # удалить пользователя
```

## 6. Перед реальными данными
1. Пройдите тестовый сценарий из README («Проверка») вдвоём с одним гейм-менеджером.
2. Удалите тестовых пользователей и «Проект Альфа».
3. Только после этого вносите реальные задачи. Коммерческие условия (суммы, проценты скидок, условия договоров) в планнер не вносим.
