# Будущее размещение REMAKE AI STUDIO

Выполняйте эту инструкцию после решения о размещении приложения. Локальный режим использует отдельные D1 и R2, поэтому для него не нужно создавать облачные ресурсы.

## 1. Создайте репозиторий в новом аккаунте GitHub

1. Войдите в новый GitHub-аккаунт. Нажмите **+ → New repository**. Имя репозитория может быть `remake-ai-studio`. Выберите **Private**, если исходный код должен быть доступен только вам и приглашённым разработчикам. При переносе исходников из архива оставьте поля для создания README, лицензии и `.gitignore` выключенными, чтобы репозиторий был пуст.
2. Распакуйте архив проекта. В терминале откройте папку с `package.json`. Проверьте, что рядом есть `.gitignore`. Он должен исключать зависимости, состояние Wrangler и локальные секреты. Рабочие фотографии, видео и копии данных загружайте через приложение или предусмотренную процедуру восстановления.
3. Инициализируйте репозиторий и отправьте код. Подставьте имя нового аккаунта вместо `YOUR_NEW_ACCOUNT`. В окне входа в GitHub выберите новый аккаунт.

   ```bash
   git init -b main
   git add .
   git status --short
   git commit -m "Initial REMAKE AI STUDIO release"
   git remote add origin https://github.com/YOUR_NEW_ACCOUNT/remake-ai-studio.git
   git push -u origin main
   ```

   Перед коммитом просмотрите список файлов. Для первого коммита Git может попросить настроить `user.name` и `user.email`. Команды `git config user.name "Ваше имя"` и `git config user.email "Ваш email"`, выполненные в папке проекта, действуют в этом репозитории.

[Официальная инструкция GitHub по созданию репозитория](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository)

## 2. Подготовьте базу D1 и закрытое хранилище R2

1. Войдите в выбранный аккаунт [Cloudflare](https://dash.cloudflare.com/). Установите зависимости проекта через `npm ci`, если ещё этого не делали. Для команд Wrangler выполните `npx wrangler login` и проверьте выбранный аккаунт командами `npx wrangler whoami` и `npx wrangler d1 list`.
2. В панели Cloudflare откройте **Storage & databases → D1 SQL Database → Create database**, назовите базу `remake-ai-studio` и скопируйте **Database ID** из её карточки. Можно создать её через терминал командой `npx wrangler d1 create remake-ai-studio`. Запишите ID и имя в соответствующие поля D1 в `wrangler.jsonc`. Имя самого binding сохраните таким, как оно указано в шаблоне проекта.
3. В панели Cloudflare откройте **R2 Object Storage → Overview → Create bucket**. При первой активации R2 Cloudflare может попросить подключить биллинг и добавить способ оплаты. Проверьте условия перед активацией. Выберите класс **Standard**, скопируйте имя bucket в `wrangler.jsonc` и оставьте выключенными **Public Development URL** и публичный custom domain для bucket. Рабочие файлы выдаёт Worker через API.
4. Проверьте конфигурацию и подготовьте схему до первого запуска Worker.

   ```bash
   npx wrangler d1 migrations apply remake-ai-studio --remote
   npx wrangler d1 execute remake-ai-studio --remote --file database/seeds/initial.sql
   npm run build
   npx wrangler deploy --dry-run
   ```

   Имя базы в командах должно совпадать с вашим `database_name`. Если Wrangler предлагает сохранить изменения автоматически, сравните итоговый файл с конфигурацией проекта. ID базы и имя bucket задают привязки. API-токены, пароли и ключи S3 хранятся отдельно. Для стандартного запуска этого приложения ключи R2 в React не требуются.

[Руководство Cloudflare D1](https://developers.cloudflare.com/d1/get-started/) · [Миграции](https://developers.cloudflare.com/d1/reference/migrations/) · [Создание bucket](https://developers.cloudflare.com/r2/buckets/create-buckets/) · [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## 3. Свяжите новый репозиторий с Worker

Приложение использует Workers со Static Assets. Интерфейс и API обслуживаются с одного адреса, API доступно под `/api/`. Используйте **Workers & Pages → Create application → GitHub** и выберите созданный репозиторий. В окне установки GitHub App можно выдать доступ только выбранному репозиторию.

| Поле Workers Builds | Значение |
| --- | --- |
| Worker name | Значение `name` из `wrangler.jsonc` |
| Production branch | `main` |
| Root directory | Корень репозитория, если там находятся `package.json` и `wrangler.jsonc` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Node.js | 22.13 или новее. При необходимости задайте поддерживаемую версию через `NODE_VERSION` |

Перед первой сборкой отправьте проверенную конфигурацию с фактическими ID привязок в новый репозиторий. Нажатие **Save and Deploy** создаёт рабочую версию приложения. Если хотите оставить первый выпуск управляемым вручную, после применения миграций можно выполнить `npm run build` и `npx wrangler deploy`, а затем подключить существующий Worker к репозиторию в **Settings → Builds**.

Отключите сборки веток предварительного просмотра или используйте для них отдельные базу и bucket. У всех экземпляров, подключённых к одним и тем же привязкам, общие данные. Если нужен собственный адрес, добавьте **Custom Domain** к Worker в **Settings → Domains & Routes**. Публичный адрес Worker предоставляет доступ к студии. Доступ к GitHub-репозиторию этого не меняет.

[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) · [Параметры сборки](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) · [Static Assets](https://developers.cloudflare.com/workers/static-assets/)

## 4. Проверьте доступ из Беларуси

Используйте чистую тестовую библиотеку и локации, где реально будут работать со студией. Проводите проверки без VPN и с выключенным прокси. Запишите дату, оператора, браузер, устройство и результат.

| Подключение | Устройства и проверки |
| --- | --- |
| Домашний интернет | Ноутбук и Android. Загрузите страницу, откройте карточку по прямой ссылке, проверьте сохранение |
| Мобильный интернет | Android через мобильные данные. Загрузите фото и видео, откройте фотогалерею, скачайте оригиналы |
| iPhone при наличии | Safari по Wi-Fi и через мобильную сеть. Проверьте галерею, буфер обмена, скачивание, безопасные области экрана и добавление на домашний экран |
| Две сети одновременно | Измените статус на телефоне, дождитесь обновления на втором устройстве, сравните SHA-256 загруженного и скачанного файла |

Повторите проверку на выбранном production-адресе. Если `workers.dev` недоступен, проверьте собственный домен Worker, а затем возможность замены инфраструктуры по [архитектурной схеме](ARCHITECTURE.md). Успех на одном операторе не подтверждает доступ через другого. Доступ пользователям нужен только к адресу студии, GitHub и панель Cloudflare используются для обслуживания.

## 5. Обновляйте приложение

Сделайте резервную копию и ознакомьтесь с новыми миграциями. После локальных проверок примените миграции командой `npx wrangler d1 migrations apply remake-ai-studio --remote`. Затем отправьте проверенный коммит в ветку выпуска при подключённом Workers Builds или соберите и разверните Worker вручную. Проверьте раздел «Система», открытие карточек и небольшую пробную загрузку. Откат версии Worker не откатывает схему D1 и изменения R2. Для возврата базы и медиа используйте процедуру из [BACKUP.md](BACKUP.md).

## Стоимость и пределы

Ориентиры по официальным тарифам на 14 ноября 2026 года. Фактическая сумма зависит от плана, региона оплаты, налогов, числа запросов, использования Storage и независимых копий.

| Статья | Ориентир |
| --- | --- |
| R2 Standard | 10 GB-month, 1 млн операций класса A и 10 млн операций класса B в месяц включены. Стандартное хранение сверх квоты стоит $0,015 за GB-month |
| R2 Standard, 100 GB в течение месяца | Около $1,35 только за хранение, если весь бесплатный объём доступен |
| R2 Standard, 500 GB в течение месяца | Около $7,35 только за хранение при тех же условиях |
| D1 Workers Free | 5 млн прочитанных и 100 тыс. записанных строк в день, 500 MB на базу и 5 GB суммарно |
| Workers Free | До 100 тыс. запросов в сутки и 10 мс CPU на HTTP-запрос. Время ожидания сервисов не входит в CPU. Крупные загрузки и архивы проверьте на выбранном плане |
| Workers Paid | Базовый план от $5 в месяц. Возможна дополнительная плата за потребление |
| Независимые копии и домен | Стоимость определяется отдельным поставщиком |

В приложении отображаются объём и пользовательские пороги. Фактические счета, квоты и состояние бюджета смотрите в панели Cloudflare. В **Billing → Spend Management** можно настроить уведомление о расходах и отдельный лимит Workers. Лимит Workers охватывает его запросы и CPU, а у R2 своя тарификация. При росте расходов проверьте операции загрузки, скачивания, хранения превью и корзины. [Управление расходами в Cloudflare](https://developers.cloudflare.com/billing/manage/spend-management/)

[R2 Pricing](https://developers.cloudflare.com/r2/pricing/) · [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) · [Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)

## Проверки в будущем репозитории

В архиве есть [пример проверок GitHub Actions](examples/github-checks.yml.example). После создания нового репозитория можно скопировать его в `.github/workflows/checks.yml`. Он запускает проверку типов, сборку и тесты с локальными D1/R2. Публикация выполняется через выбранный способ запуска Workers, описанный выше.
