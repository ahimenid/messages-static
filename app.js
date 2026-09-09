'use strict';

// Настройки. API_BASE — URL API Gateway перед Cloud Function.
var CONFIG = {
  API_BASE: 'https://example.apigw.yandexcloud.net',
  YANDEX_CLIENT_ID: '00000000000000000000000000000000',
  PAGE_SIZE: 100,
  WINDOW_HOURS: 72,
  POLL_DESKTOP_MS: 7000,
  POLL_MOBILE_MS: 60000
};

var LEVELS = ['trace', 'debug', 'info', 'warning', 'error', 'critical'];

var els = {
  panel: document.getElementById('settings'),
  openSettings: document.getElementById('open-settings'),
  room: document.getElementById('room'),
  level: document.getElementById('level'),
  unresolved: document.getElementById('unresolved'),
  status: document.getElementById('status'),
  list: document.getElementById('messages'),
  more: document.getElementById('more'),
  login: document.getElementById('login'),
  user: document.getElementById('user'),
  logout: document.getElementById('logout')
};

// mock=1 — превью без бэкенда, данные из mock.json.
var MOCK = new URLSearchParams(location.search).has('mock');

// Телефон определяем по типу указателя, а не по ширине окна:
// узкое окно на десктопе — всё ещё десктоп.
var wide = matchMedia('(min-width: 60rem)');
var coarse = matchMedia('(pointer: coarse)');

var state = {
  settings: { defaults: { min_level: 'info', unresolved_only: false }, rooms: {} },
  room: '',
  messages: [],   // от новых к старым
  resolved: Object.create(null),
  ids: Object.create(null),
  cursorNew: '',  // самый свежий известный ключ
  cursorOld: '',  // самый старый загруженный ключ
  etag: '',
  hasMore: false,
  timer: 0
};

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
  els.more.hidden = true;
  stopPolling();
  els.status.textContent = message || 'Требуется вход через Яндекс ID.';
}

/* --- настройки: общие + переопределение на комнату --- */

function roomSettings(room) {
  var defaults = state.settings.defaults || {};
  var override = (state.settings.rooms || {})[room] || {};
  return {
    min_level: override.min_level || defaults.min_level || 'info',
    unresolved_only: 'unresolved_only' in override
      ? override.unresolved_only
      : Boolean(defaults.unresolved_only)
  };
}

function saveRoomSettings() {
  if (!state.settings.rooms) state.settings.rooms = {};
  state.settings.rooms[state.room] = {
    min_level: els.level.value,
    unresolved_only: els.unresolved.checked
  };
  state.settings.last_room = state.room;
  if (MOCK) return Promise.resolve();

  return api('/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.settings)
  }).catch(function () {
    els.status.textContent = 'Настройки не сохранились, но фильтр применён.';
  });
}

function applyRoomSettings() {
  var settings = roomSettings(state.room);
  els.level.value = settings.min_level;
  els.unresolved.checked = settings.unresolved_only;
}

/* --- рендер --- */

function renderMessage(message) {
  var item = document.createElement('li');
  item.dataset.level = message.level || 'info';
  if (state.resolved[message.id]) item.dataset.resolved = '';

  var meta = document.createElement('p');
  meta.className = 'meta';

  var source = document.createElement('span');
  source.className = 'source';
  source.textContent = message.source || 'unknown';

  var level = document.createElement('span');
  level.textContent = message.level || 'info';

  var time = document.createElement('time');
  if (message.timestamp) {
    time.dateTime = message.timestamp;
    var parsed = new Date(message.timestamp);
    time.textContent = isNaN(parsed) ? message.timestamp : parsed.toLocaleString('ru-RU');
  }

  meta.append(source, level, time);

  if (state.resolved[message.id]) {
    var mark = document.createElement('span');
    mark.className = 'resolved';
    mark.textContent = '✓ решено';
    meta.append(mark);
  }

  var text = document.createElement('p');
  text.className = 'text';
  text.textContent = message.text || '';

  item.append(meta, text);
  return item;
}

function visibleMessages() {
  if (!els.unresolved.checked) return state.messages;
  return state.messages.filter(function (message) {
    return !state.resolved[message.id];
  });
}

function plural(count) {
  var tail = count % 100;
  if (tail > 4 && tail < 21) return 'сообщений';
  tail = count % 10;
  if (tail === 1) return 'сообщение';
  if (tail > 1 && tail < 5) return 'сообщения';
  return 'сообщений';
}

function render() {
  var items = visibleMessages();
  var list = document.createDocumentFragment();
  items.forEach(function (message) { list.append(renderMessage(message)); });
  els.list.replaceChildren(list);
  els.more.hidden = !state.hasMore;
  els.status.textContent = items.length
    ? items.length + ' ' + plural(items.length) + ', обновлено в ' + new Date().toLocaleTimeString('ru-RU')
    : 'Сообщений нет.';
}

/* --- загрузка --- */

function query(extra) {
  var params = new URLSearchParams({
    room: state.room,
    min_level: els.level.value,
    limit: String(CONFIG.PAGE_SIZE)
  });
  if (els.unresolved.checked) params.set('unresolved', '1');
  Object.keys(extra || {}).forEach(function (key) {
    if (extra[key]) params.set(key, extra[key]);
  });
  return '?' + params.toString();
}

function mergeMessages(messages, atEnd) {
  var fresh = messages.filter(function (message) {
    if (!message.id || state.ids[message.id]) return false;
    state.ids[message.id] = true;
    return true;
  });

  fresh.sort(function (a, b) { return a.key < b.key ? 1 : -1; });
  if (atEnd) state.messages = state.messages.concat(fresh);
  else state.messages = fresh.concat(state.messages);

  if (state.messages.length) {
    state.cursorNew = state.messages[0].key;
    state.cursorOld = state.messages[state.messages.length - 1].key;
  }
}

function applyResolved(ids) {
  (ids || []).forEach(function (id) { state.resolved[id] = true; });
}

function handle(response, atEnd, poll) {
  if (response.status === 401) { showSignedOut('Сессия истекла, войдите снова.'); return null; }
  if (response.status === 304) return null; // условный запрос: ничего нового
  if (!response.ok) throw new Error('HTTP ' + response.status);

  // ETag сравнивается только между одинаковыми запросами опроса.
  if (poll) state.etag = response.headers.get('ETag') || '';

  return response.json().then(function (data) {
    applyResolved(data.resolved);
    mergeMessages(data.messages || [], atEnd);
    if (typeof data.has_more === 'boolean') state.hasMore = data.has_more;
    render();
  });
}

function loadInitial() {
  els.status.textContent = 'Загрузка…';
  state.messages = [];
  state.ids = Object.create(null);
  state.resolved = Object.create(null);
  state.cursorNew = '';
  state.cursorOld = '';
  state.etag = '';
  els.list.replaceChildren();

  var request = MOCK
    ? mockMessages({ atEnd: true })
    : api('/messages' + query({ window_hours: String(CONFIG.WINDOW_HOURS) }));

  return request.then(function (response) { return handle(response, true); })
    .catch(function (error) { els.status.textContent = 'Не удалось загрузить: ' + error.message; });
}

function loadNewer() {
  var options = state.etag ? { headers: { 'If-None-Match': state.etag } } : {};
  var request = MOCK
    ? mockMessages({ after: state.cursorNew })
    : api('/messages' + query({ after: state.cursorNew }), options);

  return request.then(function (response) { return handle(response, false, true); })
    .catch(function (error) { els.status.textContent = 'Обновление не прошло: ' + error.message; });
}

function loadOlder() {
  els.more.disabled = true;
  var request = MOCK
    ? mockMessages({ before: state.cursorOld, atEnd: true })
    : api('/messages' + query({ before: state.cursorOld }));

  return request.then(function (response) { return handle(response, true); })
    .catch(function (error) { els.status.textContent = 'Не удалось догрузить: ' + error.message; })
    .then(function () { els.more.disabled = false; });
}

/* --- опрос --- */

function pollInterval() {
  return coarse.matches ? CONFIG.POLL_MOBILE_MS : CONFIG.POLL_DESKTOP_MS;
}

function startPolling() {
  stopPolling();
  state.timer = setInterval(loadNewer, pollInterval());
}

function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = 0;
}

function openRoom(room) {
  state.room = room;
  applyRoomSettings();
  loadInitial().then(startPolling);
}

/* --- комнаты --- */

function fillRooms(rooms) {
  els.room.replaceChildren();
  rooms.forEach(function (room) {
    var option = document.createElement('option');
    option.value = room.id;
    option.textContent = room.title || room.id;
    els.room.append(option);
  });

  var preferred = state.settings.last_room;
  if (preferred && rooms.some(function (room) { return room.id === preferred; })) {
    els.room.value = preferred;
  }
}

function loadRooms() {
  var request = MOCK ? fetch('mock.json').then(mockRooms) : api('/rooms');

  return request.then(function (response) {
    if (response.status === 401) { showSignedOut(); return null; }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }).then(function (data) {
    if (!data) return;
    if (data.settings) state.settings = data.settings;
    fillRooms(data.rooms || []);
    if (!els.room.value) { els.status.textContent = 'Комнат нет.'; return; }
    openRoom(els.room.value);
  });
}

/* --- события --- */

els.room.addEventListener('change', function () {
  state.settings.last_room = els.room.value;
  openRoom(els.room.value);
  saveRoomSettings();
});

els.level.addEventListener('change', function () {
  saveRoomSettings();
  loadInitial();
});

els.unresolved.addEventListener('change', function () {
  saveRoomSettings();
  loadInitial();
});

els.more.addEventListener('click', loadOlder);

els.openSettings.addEventListener('click', function () { els.panel.showModal(); });

// На широком экране панель живёт в потоке страницы, модалка не нужна.
wide.addEventListener('change', function (event) {
  if (event.matches && els.panel.open) els.panel.close();
});

els.logout.addEventListener('click', function () {
  api('/auth/logout', { method: 'POST' }).catch(function () {}).then(function () {
    showSignedOut('Вы вышли.');
  });
});

// Пока вкладка скрыта — не опрашиваем; при возврате одно обновление сразу.
document.addEventListener('visibilitychange', function () {
  if (!state.room) return;
  if (document.hidden) stopPolling();
  else { loadNewer(); startPolling(); }
});

// Смена типа указателя (док-станция, планшет в режиме ноутбука) меняет темп опроса.
coarse.addEventListener('change', function () { if (state.timer) startPolling(); });

/* --- превью без бэкенда --- */

var mockData = null;

function mockLoad() {
  if (mockData) return Promise.resolve(mockData);
  return fetch('mock.json').then(function (response) { return response.json(); })
    .then(function (data) { mockData = data; return data; });
}

function mockResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function mockRooms() {
  return mockLoad().then(function (data) {
    return mockResponse({ rooms: data.rooms, settings: data.settings });
  });
}

function mockMessages(options) {
  return mockLoad().then(function (data) {
    var minIndex = LEVELS.indexOf(els.level.value);
    var resolved = (data.resolved || {})[state.room] || [];

    var messages = (data.messages || []).filter(function (message) {
      if (message.room !== state.room) return false;
      if (LEVELS.indexOf(message.level) < minIndex) return false;
      if (els.unresolved.checked && resolved.indexOf(message.id) !== -1) return false;
      if (options.after && message.key <= options.after) return false;
      if (options.before && message.key >= options.before) return false;
      return true;
    });

    messages.sort(function (a, b) { return a.key < b.key ? 1 : -1; });
    var page = messages.slice(0, CONFIG.PAGE_SIZE);

    return mockResponse({
      messages: page,
      resolved: resolved,
      has_more: messages.length > page.length
    });
  });
}

/* --- старт --- */

function start() {
  if (MOCK) {
    showSignedIn('mock');
    loadRooms();
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
      return loadRooms();
    });
  }).catch(function () {
    showSignedOut('Бэкенд недоступен.');
  });
}

start();
