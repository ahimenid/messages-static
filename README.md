# Статика: список сообщений

Три файла (`index.html`, `styles.css`, `app.js`) + `mock.json` для превью. Никаких зависимостей и сборки — заливаются как есть в Object Storage с website hosting.

## Настройка

В начале `app.js`:

- `API_BASE` — URL API Gateway перед Cloud Function
- `YANDEX_CLIENT_ID` — client_id приложения Яндекс ID
- `POLL_MS` — интервал опроса (по умолчанию 7 с)

В приложении Яндекс ID указать Redirect URI = URL самой страницы (`https://<bucket>.website.yandexcloud.net/index.html`).

## Что должен отдавать бэкенд

Cookie сессии — `HttpOnly; Secure; SameSite=None` (фронт и API на разных доменах), и на API Gateway нужен CORS с `Access-Control-Allow-Credentials: true` и конкретным `Access-Control-Allow-Origin`.

- `POST /auth` — тело `{"token": "<OAuth-токен>"}`. Валидирует через `login.yandex.ru/info`, сверяет uid с whitelist. `200 {"login": "..."}` + Set-Cookie, `403` если uid не в списке.
- `GET /auth/me` — `200 {"login": "..."}` при живой сессии, иначе `401`.
- `POST /auth/logout` — гасит cookie.
- `GET /messages?room=<id>&after=<key>` — `200 {"messages": [...]}`, `401` при истёкшей сессии. `after` — последний известный ключ, ответ содержит только более поздние (ListObjectsV2 `StartAfter`).

Элемент массива:

```json
{
  "key": "room-id/2026-09-08T13:55:10Z-b7de.json",
  "timestamp": "2026-09-08T13:55:10Z",
  "source": "healthcheck",
  "level": "info | warning | error",
  "text": "текст сообщения"
}
```

`key` — ключ объекта в бакете, используется фронтом для дедупликации и как курсор `after`. Порядок в ответе не важен: ключи с ISO8601-префиксом сортируются лексикографически, новые показываются сверху.

## Превью без бэкенда

`index.html?mock=1` — авторизация пропускается, данные берутся из `mock.json`.
