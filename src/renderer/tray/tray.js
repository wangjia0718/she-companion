'use strict';

// 托盘悬停浮层：列出有哪些角色发了新消息、各几条；点某一行打开对应角色的聊天。
// 数据由主进程通过 tray:update 推送，页面加载时也会主动拉一次。

const API = window.api;
const els = {
  card: document.getElementById('card'),
  list: document.getElementById('list'),
  total: document.getElementById('total'),
  open: document.getElementById('open'),
};

function firstChar(name) {
  const text = typeof name === 'string' ? name.trim() : '';
  return text ? text.slice(0, 1) : '她';
}

function previewOf(item) {
  const text = typeof item.latestText === 'string' ? item.latestText.trim() : '';
  return text || (window.SheI18n ? window.SheI18n.t('发来一条新消息') : '发来一条新消息');
}

function openChat(characterId) {
  if (!API) return;
  const payload = characterId ? { target: 'chat', characterId } : { target: 'chat' };
  API.invoke('window:open', payload)
    .catch(() => {})
    .finally(() => window.close());
}

function renderRow(item) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'row';
  row.setAttribute('role', 'listitem');
  row.title = `${item.name || '她'}：${item.count} 条新消息`;

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  if (item.avatarUrl) {
    const img = document.createElement('img');
    img.src = item.avatarUrl;
    img.alt = '';
    img.draggable = false;
    img.addEventListener('error', () => {
      img.remove();
      avatar.textContent = firstChar(item.name);
    });
    avatar.appendChild(img);
  } else {
    avatar.textContent = firstChar(item.name);
  }

  const info = document.createElement('span');
  info.className = 'info';
  const nameLine = document.createElement('span');
  nameLine.className = 'name-line';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = item.name || '她';
  name.setAttribute('data-i18n-skip', '');
  nameLine.appendChild(name);
  const preview = document.createElement('span');
  preview.className = 'preview';
  preview.textContent = previewOf(item);
  preview.setAttribute('data-i18n-skip', '');
  info.append(nameLine, preview);

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = String(item.count);

  row.append(avatar, info, count);
  row.addEventListener('click', () => openChat(item.characterId));
  return row;
}

function render(data) {
  const items = data && Array.isArray(data.items) ? data.items : [];
  const total = data && Number.isFinite(data.total)
    ? data.total
    : items.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
  els.total.textContent = total > 0 ? String(total) : '';
  els.list.textContent = '';

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '没有新消息';
    els.list.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    if (item && typeof item === 'object') fragment.appendChild(renderRow(item));
  }
  els.list.appendChild(fragment);
}

function bindHover() {
  if (!API) return;
  els.card.addEventListener('mouseenter', () => {
    API.invoke('tray:popupHover', { inside: true }).catch(() => {});
  });
  els.card.addEventListener('mouseleave', () => {
    API.invoke('tray:popupHover', { inside: false }).catch(() => {});
  });
}

async function boot() {
  bindHover();
  els.open.addEventListener('click', () => openChat(null));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.close();
  });

  if (!API) {
    render({ items: [], total: 0 });
    return;
  }

  try {
    const settings = await API.invoke('settings:get');
    if (window.SheI18n) {
      window.SheI18n.apply(settings && settings.ui && settings.ui.language === 'en' ? 'en' : 'zh');
    }
  } catch (error) {
    // 读取失败就按中文渲染，不影响未读列表
  }

  API.on('tray:update', render);
  API.invoke('tray:unread')
    .then(render)
    .catch(() => render({ items: [], total: 0 }));
}

boot();
