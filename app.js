'use strict';

// Настройки. API_BASE — URL API Gateway перед Cloud Function.
var CONFIG = {
  API_BASE: 'https://example.apigw.yandexcloud.net',
  YANDEX_CLIENT_ID: '00000000000000000000000000000000',
  POLL_MS: 7000
};

var els = {
  form: document.getElementById('room-form'),
  room: document.getElementById('room'),
  status: document.getElementById('status'),
  list: document.getElementById('messages'),
  login: document.getElementById('login'),
  user: document.getElementById('user'),
  logout: document.getElementById('logout')
};

// mock=1 — превью без бэкенда, данные из mock.json.
var MOCK = new URLSearchParams(location.search).has('mock');

var state = { room: '', after: '', timer: 0, seen: Object.create(null) };

function api(path, options) {
  var opts = options || {};
  opts.credentials = 'include'; // короткоживущая cookie от /auth
  return fetch(CONFIG.API_BASE + path, opts);
}

// https://yandex.ru/dev/id/doc/ru/tokens/token-create — implicit flow
function authorizeUrl() {
  var redirect = location.origin + location.pathname;
  return 'https://oauth.yandex.ru/authorize?response_type=token' +
    '&client_id=' + encodeURIComponent(CONFIG.YANDEX_CLIENT_ID) +
    '&redirect_uri=' + encodeURIComponent(redirect);
}

// Токен приходит во фрагменте: #access_token=...&token_type=bearer
function tokenFromHash() {
  if (!location.hash) return '';
  var token = new URLSearchParams(location.hash.slice(1)).get('access_token') || '';
  if (token) history.replaceState(null, '', location.pathname + location.search);
  return token;
}

function showSignedIn(login) {
  els.user.textContent = login ? 'Вы вошли как ' + login : 'Вы вошли';
  els.user.hidden = false;
  els.logout.hidden = false;
  els.login.hidden = true;
}

function showSignedOut(message) {
  els.login.href = authorizeUrl();
  els.login.hidden = false;
  els.user.hidden = true;
  els.logout.hidden = true;
  els.list.replaceChildren();
  stopPolling();
  els.status.textContent = message || 'Требуется вход через Яндекс ID.';
}

function renderMessage(message) {
  var item = document.createElement('li');
  if (message.level) item.dataset.level = message.level;

  var meta = document.createElement('p');
  meta.className = 'meta';

  var source = document.createElement('span');
  source.className = 'source';
  source.textContent = message.source || 'unknown';

  var time = document.createElement('time');
  if (message.timestamp) {
    time.dateTime = message.timestamp;
    var parsed = new Date(message.timestamp);
    time.textContent = isNaN(parsed) ? message.timestamp : parsed.toLocaleString('ru-RU');
  }

  var text = document.createElement('p');
  text.className = 'text';
  text.textContent = message.text || '';

  meta.append(source, time);
  item.append(meta, text);
  return item;
}

// Ключи вида room-id/{ISO8601}-{uuid}.json сортируются лексикографически,
// поэтому новое просто дописывается в начало списка.
function appendMessages(messages) {
  var fresh = document.createDocumentFragment();
  var added = 0;

  messages.forEach(function (message) {
    var key = message.key || message.id;
    if (!key || state.seen[key]) return;
    state.seen[key] = true;
    fresh.prepend(renderMessage(message));
    if (!state.after || key > state.after) state.after = key;
    added++;
  });

  if (added) els.list.prepend(fresh);
}

function fetchMessages() {
  var query = '?room=' + encodeURIComponent(state.room) +
    (state.after ? '&after=' + encodeURIComponent(state.after) : '');
  var request = MOCK ? fetch('mock.json') : api('/messages' + query);

  return request.then(function (response) {
    if (response.status === 401) {
      showSignedOut('Сессия истекла, войдите снова.');
      return;
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }).then(function (data) {
    if (!data) return;
    appendMessages(data.messages || []);
    els.status.textContent = els.list.children.length
      ? 'Обновлено в ' + new Date().toLocaleTimeString('ru-RU')
      : 'Сообщений пока нет.';
  }).catch(function (error) {
    els.status.textContent = 'Не удалось загрузить сообщения: ' + error.message;
  });
}

function startPolling(room) {
  stopPolling();
  state.room = room;
  state.after = '';
  state.seen = Object.create(null);
  els.list.replaceChildren();
  els.status.textContent = 'Загрузка…';
  fetchMessages();
  state.timer = setInterval(fetchMessages, CONFIG.POLL_MS);
}

function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = 0;
}

els.form.addEventListener('submit', function (event) {
  event.preventDefault();
  var room = els.room.value.trim();
  if (room) startPolling(room);
});

els.logout.addEventListener('click', function () {
  api('/auth/logout', { method: 'POST' }).catch(function () {}).then(function () {
    showSignedOut('Вы вышли.');
  });
});

// Пауза, пока вкладка не видна: не тратим вызовы функции впустую.
document.addEventListener('visibilitychange', function () {
  if (!state.room) return;
  if (document.hidden) stopPolling();
  else if (!state.timer) { fetchMessages(); state.timer = setInterval(fetchMessages, CONFIG.POLL_MS); }
});

function start() {
  if (MOCK) {
    showSignedIn('mock');
    startPolling(els.room.value.trim());
    return;
  }

  var token = tokenFromHash();
  var session = token
    ? api('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token })
      })
    : api('/auth/me');

  session.then(function (response) {
    if (!response.ok) {
      showSignedOut(response.status === 403 ? 'Доступ не разрешён для этого аккаунта.' : '');
      return;
    }
    return response.json().then(function (data) {
      showSignedIn(data.login);
      startPolling(els.room.value.trim());
    });
  }).catch(function () {
    showSignedOut('Бэкенд недоступен.');
  });
}

start();
