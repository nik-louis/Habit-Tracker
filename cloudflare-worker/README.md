# Push-напоминания — второй, более надёжный триггер (Cloudflare Workers)

Необязательное дополнение к уже работающему `.github/workflows/push-reminders.yml`. GitHub Actions
не гарантирует время срабатывания `schedule`-запусков на бесплатных репозиториях — при нагрузке на
платформу плановые запуски молча пропускаются, а не встают в очередь (потому напоминания иногда
приходили на несколько часов позже, чем указано). Cloudflare Cron Triggers работают на своём
собственном планировщике и этой проблемы не имеют.

Этот Worker — не замена GitHub Actions, а параллельный второй источник: делает ровно ту же работу
(читает `/sync/{code}/push` в Firebase, решает, кому пора, шлёт Web Push), опираясь на тот же
`lastFired`, так что дублирования уведомлений не будет, даже если сработают оба почти одновременно —
кто бы ни сработал первым, второй увидит отметку и просто ничего не отправит повторно.

## Что понадобится

Все те же 5 значений, что уже введены в **GitHub → Settings → Secrets and variables → Actions**:
`FIREBASE_DB_URL`, `FIREBASE_SYNC_CODE`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
Ключи VAPID переиспользуются **как есть** — новую пару генерировать не нужно, переподключать
устройства к push тоже не нужно.

> Если исходных значений (особенно `VAPID_PRIVATE_KEY`) уже нигде не осталось — GitHub Secrets
> нельзя посмотреть повторно после сохранения — единственный выход: сгенерировать новую пару
> (`npx web-push generate-vapid-keys`), обновить `VAPID_PUBLIC_KEY` в `index.html` (строка с
> `const VAPID_PUBLIC_KEY=...`) и переподписать устройства (снять и заново включить напоминания в
> приложении). Без этого шага можно обойтись, если старые значения ещё где-то сохранены.

## Установка

1. Бесплатный аккаунт на [dash.cloudflare.com](https://dash.cloudflare.com), если его ещё нет
   (карта не требуется).
2. Локально, из этой папки:
   ```bash
   cd cloudflare-worker
   npm install
   npx wrangler login
   ```
   Откроется браузер для авторизации Wrangler в твоём Cloudflare-аккаунте.
3. Добавь секреты (для каждого — своя команда, вставишь значение по запросу):
   ```bash
   npx wrangler secret put FIREBASE_DB_URL
   npx wrangler secret put FIREBASE_SYNC_CODE
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   npx wrangler secret put VAPID_SUBJECT
   ```
4. Разверни:
   ```bash
   npx wrangler deploy
   ```
   В выводе будет адрес вида `https://habitunity-push-reminders.<твой-поддомен>.workers.dev` — он
   не нужен для работы cron'а (тот сработает сам по расписанию), но пригодится для ручной проверки.
5. Проверка: `Cloudflare Dashboard → Workers & Pages → habitunity-push-reminders → Settings →
   Triggers` — должен быть виден Cron Trigger `*/5 * * * *`. Живые логи — вкладка **Logs** там же,
   или `npx wrangler tail` в терминале.
6. Ручной прогон без ожидания cron'а — просто открой URL из шага 4 в браузере (или `curl`), затем
   посмотри Logs: там будет `Push reminders (Cloudflare): checked N device(s), sent M notification(s).`
   — та же диагностическая строка, что и в GitHub Actions.

## Дальнейшие изменения

`worker.js` намеренно держит свою копию `isDue()`/`advance()`/`minOfDay()`, идентичную
`.github/scripts/send-push-reminders.js` — если меняется логика типов напоминаний или правил
срабатывания, поправь оба файла. После правки — `npx wrangler deploy` заново (у GitHub Actions
версии переразворачивать ничего не надо, она берёт код прямо из `main` при каждом запуске).
