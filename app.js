const NODE_W = 236;
const NODE_H = 158;
const H_GAP = 44;
const V_GAP = 104;
const PAD = 92;
const MIN_SCALE = 0.18;
const MAX_SCALE = 2;
const MOBILE_BREAKPOINT = 700;

const state = {
  data: null,
  nodeById: new Map(),
  parentMap: new Map(),
  childrenMap: new Map(),
  primaryLinks: [],
  secondaryLinks: [],
  visibleIds: new Set(),
  matches: new Set(),
  contextIds: new Set(),
  visibleRoots: [],
  visiblePrimaryLinks: [],
  visibleSecondaryLinks: [],
  ancestorsEnabled: true,
  query: '',
  activeFilters: new Set(),
  scale: 0.95,
  width: 0,
  height: 0,
  maxDepth: 0,
  selectedId: null,
  labels: true,
  ready: false,
  searchTimer: null
};

const el = {
  html: document.documentElement,
  boardTotal: document.getElementById('boardTotal'),
  search: document.getElementById('searchInput'),
  resultCount: document.getElementById('resultCount'),
  filterChips: document.getElementById('filterChips'),
  clearFilters: document.getElementById('clearFilters'),
  contextButton: document.getElementById('contextButton'),
  treeFrame: document.getElementById('treeFrame'),
  scroller: document.getElementById('treeScroller'),
  zoomWrap: document.getElementById('zoomWrap'),
  stage: document.getElementById('stage'),
  edgeLayer: document.getElementById('edgeLayer'),
  nodeLayer: document.getElementById('nodeLayer'),
  zoomBadge: document.getElementById('zoomBadge'),
  zoomReset: document.getElementById('zoomReset'),
  zoomIn: document.getElementById('zoomIn'),
  zoomOut: document.getElementById('zoomOut'),
  fitButton: document.getElementById('fitButton'),
  labelsButton: document.getElementById('labelsButton'),
  noResults: document.getElementById('noResults'),
  noResultsClear: document.getElementById('noResultsClear'),
  loadError: document.getElementById('loadError'),
  themeButton: document.getElementById('themeButton'),
  drawer: document.getElementById('detailDrawer'),
  drawerBody: document.getElementById('drawerBody'),
  drawerBackdrop: document.getElementById('drawerBackdrop'),
  closeDrawer: document.getElementById('closeDrawer'),
  toast: document.getElementById('toast')
};

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function tagLabel(tag) {
  return state.data?.tags?.[tag] || tag;
}

function branchData(node) {
  return state.data?.branches?.[node.branch] || { label: 'Board', color: '#777' };
}

function getNode(id) {
  return state.nodeById.get(id);
}

function hasActiveView() {
  return state.query.trim().length > 0 || state.activeFilters.size > 0;
}

function loadScriptMirror() {
  return new Promise((resolve, reject) => {
    if (window.FAMILY_TREE_DATA) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'data/family-tree.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load family-tree.js'));
    document.head.append(script);
  });
}

async function loadTreeData() {
  if (window.location.protocol === 'file:') {
    await loadScriptMirror();
    return window.FAMILY_TREE_DATA;
  }

  try {
    const response = await fetch('data/family-tree.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`JSON request failed with ${response.status}`);
    return await response.json();
  } catch (error) {
    await loadScriptMirror().catch(() => {});
    if (window.FAMILY_TREE_DATA) return window.FAMILY_TREE_DATA;
    throw error;
  }
}

function prepareData(data) {
  state.data = data;
  state.nodeById = new Map(data.nodes.map((node) => [node.id, node]));
  state.childrenMap = new Map(data.nodes.map((node) => [node.id, []]));
  state.parentMap = new Map();

  state.primaryLinks = data.links
    .filter((link) => link.primary)
    .filter((link) => state.nodeById.has(link.from) && state.nodeById.has(link.to));
  state.secondaryLinks = data.links
    .filter((link) => !link.primary)
    .filter((link) => state.nodeById.has(link.from) && state.nodeById.has(link.to));

  for (const link of state.primaryLinks) {
    if (state.parentMap.has(link.to)) continue;
    state.parentMap.set(link.to, link.from);
    state.childrenMap.get(link.from).push(link.to);
  }

  for (const children of state.childrenMap.values()) {
    children.sort((a, b) => (getNode(a)?.order ?? 0) - (getNode(b)?.order ?? 0));
  }
}

function nodeMatches(node) {
  const query = state.query.trim().toLowerCase();

  if (query) {
    const searchable = [
      node.name,
      node.alias,
      node.maker,
      node.year,
      node.delta,
      branchData(node).label,
      ...node.tags.map(tagLabel)
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    if (!searchable.includes(query)) return false;
  }

  for (const filterId of state.activeFilters) {
    const filter = state.data.filters.find((item) => item.id === filterId);
    if (!filter) continue;
    if (!filter.tags.some((tag) => node.tags.includes(tag))) return false;
  }

  return true;
}

function computeVisibility() {
  const allIds = new Set(state.data.nodes.map((node) => node.id));

  if (!hasActiveView()) {
    state.matches = allIds;
    state.visibleIds = new Set(allIds);
    state.contextIds = new Set();
    return;
  }

  const matches = new Set();
  for (const node of state.data.nodes) {
    if (nodeMatches(node)) matches.add(node.id);
  }

  const visible = new Set(matches);
  if (state.ancestorsEnabled) {
    for (const id of matches) {
      let parentId = state.parentMap.get(id);
      while (parentId && !visible.has(parentId)) {
        visible.add(parentId);
        parentId = state.parentMap.get(parentId);
      }
    }
  }

  state.matches = matches;
  state.visibleIds = visible;
  state.contextIds = new Set([...visible].filter((id) => !matches.has(id)));
}

function layoutTree() {
  const visibleNodes = state.data.nodes.filter((node) => state.visibleIds.has(node.id));
  const visibleSet = state.visibleIds;
  const children = new Map(visibleNodes.map((node) => [node.id, []]));
  const parent = new Map();

  state.visiblePrimaryLinks = state.primaryLinks.filter(
    (link) => visibleSet.has(link.from) && visibleSet.has(link.to)
  );
  state.visibleSecondaryLinks = state.secondaryLinks.filter(
    (link) => visibleSet.has(link.from) && visibleSet.has(link.to)
  );

  for (const link of state.visiblePrimaryLinks) {
    if (parent.has(link.to)) continue;
    parent.set(link.to, link.from);
    children.get(link.from).push(link.to);
  }

  for (const childIds of children.values()) {
    childIds.sort((a, b) => (getNode(a)?.order ?? 0) - (getNode(b)?.order ?? 0));
  }

  const roots = visibleNodes
    .filter((node) => !parent.has(node.id))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  let cursor = PAD;
  let maxDepth = 0;

  function visit(node, depth) {
    const childIds = children.get(node.id) || [];
    let x;

    if (childIds.length === 0) {
      x = cursor + NODE_W / 2;
      cursor += NODE_W + H_GAP;
    } else {
      const childXs = childIds.map((childId) => visit(getNode(childId), depth + 1));
      x = (childXs[0] + childXs[childXs.length - 1]) / 2;
    }

    node._x = x;
    node._y = PAD + depth * (NODE_H + V_GAP);
    node._depth = depth;
    maxDepth = Math.max(maxDepth, depth);
    return x;
  }

  roots.forEach((root, index) => {
    if (index > 0) cursor += H_GAP;
    visit(root, 0);
  });

  state.visibleRoots = roots;
  state.width = Math.max(cursor - H_GAP + PAD, 760);
  state.height = Math.max(PAD * 2 + (maxDepth + 1) * NODE_H + maxDepth * V_GAP, 342);
  state.maxDepth = maxDepth;

  el.stage.style.width = `${state.width}px`;
  el.stage.style.height = `${state.height}px`;
  el.zoomWrap.style.width = `${state.width * state.scale}px`;
  el.zoomWrap.style.height = `${state.height * state.scale}px`;
  el.stage.style.transform = `scale(${state.scale})`;
  el.edgeLayer.setAttribute('viewBox', `0 0 ${state.width} ${state.height}`);
  el.edgeLayer.setAttribute('width', state.width);
  el.edgeLayer.setAttribute('height', state.height);

  const label = `${Math.round(state.scale * 100)}%`;
  el.zoomBadge.textContent = label;
  el.zoomReset.textContent = label;
  centerStage();
}

function centerStage() {
  const extra = el.scroller.clientHeight - state.height * state.scale;
  el.zoomWrap.style.marginTop = extra > 0 ? `${extra / 2}px` : '0px';
}

function edgePath(source, target) {
  const sx = source._x;
  const sy = source._y + NODE_H;
  const tx = target._x;
  const ty = target._y;
  const midY = sy + (ty - sy) * 0.52;
  const radius = 12;

  if (Math.abs(tx - sx) < 1.5) return `M ${sx} ${sy} V ${ty}`;

  const direction = tx > sx ? 1 : -1;
  return [
    `M ${sx} ${sy}`,
    `V ${midY - radius}`,
    `Q ${sx} ${midY} ${sx + direction * radius} ${midY}`,
    `H ${tx - direction * radius}`,
    `Q ${tx} ${midY} ${tx} ${midY + radius}`,
    `V ${ty}`
  ].join(' ');
}

function reusePath(source, target) {
  const targetIsRight = target._x >= source._x;
  const sx = source._x + (targetIsRight ? NODE_W / 2 : -NODE_W / 2);
  const sy = source._y + NODE_H * 0.6;
  const tx = target._x + (targetIsRight ? -NODE_W / 2 : NODE_W / 2);
  const ty = target._y + NODE_H * 0.4;
  const bend = Math.max(70, Math.abs(tx - sx) * 0.38) * (targetIsRight ? 1 : -1);
  return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`;
}

function createSvgElement(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}

function renderEdges() {
  el.edgeLayer.replaceChildren();

  for (const link of state.visiblePrimaryLinks) {
    const source = getNode(link.from);
    const target = getNode(link.to);
    const edgeType = link.type === 'inspired' ? 'inspired' : 'direct';

    const path = createSvgElement('path', {
      d: edgePath(source, target),
      class: `edge ${edgeType}`,
      'data-from': link.from,
      'data-to': link.to
    });
    el.edgeLayer.append(path);

    if (link.label) {
      const midY = source._y + NODE_H + (target._y - source._y - NODE_H) * 0.52;
      const label = createSvgElement('text', {
        x: target._x,
        y: midY + 14,
        class: 'edge-label',
        'data-from': link.from,
        'data-to': link.to
      });
      label.textContent = link.label;
      el.edgeLayer.append(label);
    }
  }

  for (const link of state.visibleSecondaryLinks) {
    const source = getNode(link.from);
    const target = getNode(link.to);

    const path = createSvgElement('path', {
      d: reusePath(source, target),
      class: 'edge reuse',
      'data-from': link.from,
      'data-to': link.to
    });
    el.edgeLayer.append(path);

    if (link.label) {
      const label = createSvgElement('text', {
        x: (source._x + target._x) / 2,
        y: (source._y + target._y) / 2 + NODE_H * 0.52 - 10,
        class: 'edge-label reuse',
        'data-from': link.from,
        'data-to': link.to
      });
      label.textContent = link.label;
      el.edgeLayer.append(label);
    }
  }
}

function cardMarkup(node) {
  const branch = branchData(node);
  const tags = node.tags.slice(0, 3).map((tag) =>
    `<span class="card-tag">${esc(tagLabel(tag))}</span>`
  );
  if (node.tags.length > 3) {
    tags.push(`<span class="card-tag is-more">+${node.tags.length - 3}</span>`);
  }

  return `
    <span class="card-meta">
      <i class="branch-dot" aria-hidden="true"></i>
      <span class="branch-name">${esc(branch.label)}</span>
      <span class="card-year">${esc(node.year)}</span>
    </span>
    <span class="card-name">${esc(node.name)}</span>
    <span class="card-maker">${esc(node.maker)}${node.alias ? ` · ${esc(node.alias)}` : ''}</span>
    <span class="card-delta"><span class="delta-mark" aria-hidden="true">Δ</span> ${esc(node.delta)}</span>
    <span class="card-tags">${tags.join('')}</span>
  `;
}

function renderCards() {
  el.nodeLayer.replaceChildren();

  for (const node of state.data.nodes) {
    if (!state.visibleIds.has(node.id)) continue;

    const branch = branchData(node);
    const isContext = state.contextIds.has(node.id);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'node-card';
    if (node.root) card.classList.add('is-root');
    if (isContext) card.classList.add('is-context');
    card.dataset.id = node.id;
    card.style.left = `${node._x - NODE_W / 2}px`;
    card.style.top = `${node._y}px`;
    card.style.setProperty('--branch', branch.color);
    card.setAttribute(
      'aria-label',
      `${node.name} by ${node.maker}, ${node.year}. ${node.delta}. ${node.tags.map(tagLabel).join(', ')}.${isContext ? ' Ancestor context.' : ''}`
    );
    card.innerHTML = cardMarkup(node);
    card.addEventListener('click', () => openNode(node.id));
    el.nodeLayer.append(card);
  }

  if (state.selectedId && state.visibleIds.has(state.selectedId)) {
    el.nodeLayer
      .querySelector(`[data-id="${cssEscape(state.selectedId)}"]`)
      ?.classList.add('is-selected');
    highlightSelection(state.selectedId);
  }
}

function renderFilters() {
  el.filterChips.replaceChildren();

  for (const filter of state.data.filters) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'filter-chip';
    button.textContent = filter.label;
    button.dataset.filter = filter.id;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      if (state.activeFilters.has(filter.id)) {
        state.activeFilters.delete(filter.id);
      } else {
        state.activeFilters.add(filter.id);
      }
      syncFilterButtons();
      rebuildView({ focus: true });
    });
    el.filterChips.append(button);
  }
}

function syncFilterButtons() {
  el.filterChips.querySelectorAll('[data-filter]').forEach((button) => {
    const active = state.activeFilters.has(button.dataset.filter);
    button.setAttribute('aria-pressed', String(active));
  });

  const activeView = hasActiveView();
  el.clearFilters.hidden = !activeView;
  el.contextButton.disabled = !activeView;
  el.contextButton.classList.toggle('is-on', activeView && state.ancestorsEnabled);
  el.contextButton.setAttribute('aria-pressed', String(activeView && state.ancestorsEnabled));
}

function updateCounts() {
  el.boardTotal.textContent = state.data.nodes.length;

  if (!hasActiveView()) {
    el.resultCount.textContent = `${state.data.nodes.length} boards`;
  } else {
    const matchText = `${state.matches.size} match${state.matches.size === 1 ? '' : 'es'}`;
    const contextText = state.contextIds.size
      ? ` + ${state.contextIds.size} ancestor${state.contextIds.size === 1 ? '' : 's'}`
      : '';
    el.resultCount.textContent = `${matchText}${contextText}`;
  }

  el.noResults.hidden = state.matches.size !== 0;
}

function rebuildView(options = {}) {
  computeVisibility();

  if (state.selectedId && !state.visibleIds.has(state.selectedId)) {
    closeDrawer({ updateHash: false });
  }

  layoutTree();
  renderEdges();
  renderCards();
  updateCounts();
  syncFilterButtons();
  state.ready = true;

  if (options.focus && hasActiveView() && state.matches.size > 0) {
    requestAnimationFrame(() => focusMatches());
  } else if (options.reset) {
    requestAnimationFrame(() => resetView());
  }
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function setScale(nextScale, anchor) {
  const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
  const oldScale = state.scale;
  if (Math.abs(scale - oldScale) < 0.0005 && state.ready) return;

  const rect = el.scroller.getBoundingClientRect();
  const anchorX = anchor?.x ?? rect.width / 2;
  const anchorY = anchor?.y ?? rect.height / 2;
  const contentX = (el.scroller.scrollLeft + anchorX) / oldScale;
  const contentY = (el.scroller.scrollTop + anchorY) / oldScale;

  state.scale = scale;
  el.zoomWrap.style.width = `${state.width * scale}px`;
  el.zoomWrap.style.height = `${state.height * scale}px`;
  el.stage.style.transform = `scale(${scale})`;

  el.scroller.scrollLeft = contentX * scale - anchorX;
  el.scroller.scrollTop = contentY * scale - anchorY;

  const label = `${Math.round(scale * 100)}%`;
  el.zoomBadge.textContent = label;
  el.zoomReset.textContent = label;
  centerStage();
}

function focusMatches() {
  const nodes = [...state.matches]
    .map(getNode)
    .filter((node) => node && Number.isFinite(node._x) && Number.isFinite(node._y));

  if (!nodes.length) return;

  const minX = Math.min(...nodes.map((node) => node._x));
  const maxX = Math.max(...nodes.map((node) => node._x));
  const minY = Math.min(...nodes.map((node) => node._y));
  const maxY = Math.max(...nodes.map((node) => node._y + NODE_H));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const maxScroll = Math.max(0, state.height * state.scale - el.scroller.clientHeight);
  let top = Math.max(0, Math.min(maxScroll, centerY * state.scale - el.scroller.clientHeight / 2));

  const cutCard = [...state.visibleIds]
    .map(getNode)
    .filter((node) => node && (node._y + NODE_H) * state.scale > top)
    .sort((a, b) => a._y - b._y)[0];

  if (cutCard) {
    const snapped = Math.max(0, cutCard._y * state.scale - 18);
    if (snapped < top && maxY * state.scale - snapped <= el.scroller.clientHeight - 12) {
      top = snapped;
    }
  }

  el.scroller.scrollTo({
    left: Math.max(0, centerX * state.scale - el.scroller.clientWidth / 2),
    top,
    behavior: 'auto'
  });
}

function fitTree() {
  if (!state.data) return;
  const rect = el.scroller.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const scaleX = (rect.width - 52) / state.width;
  const scaleY = (rect.height - 52) / state.height;
  setScale(clamp(Math.min(scaleX, scaleY), MIN_SCALE, 1), {
    x: rect.width / 2,
    y: rect.height / 2
  });

  requestAnimationFrame(() => {
    el.scroller.scrollLeft = Math.max(0, (state.width * state.scale - el.scroller.clientWidth) / 2);
    el.scroller.scrollTop = Math.max(0, (state.height * state.scale - el.scroller.clientHeight) / 2);
  });
}

function resetView() {
  const root = state.visibleRoots[0] || state.data.nodes.find((node) => node.root);
  if (!root) return;

  const target = window.innerWidth < MOBILE_BREAKPOINT ? 0.84 : 0.95;
  setScale(target, { x: el.scroller.clientWidth / 2, y: el.scroller.clientHeight / 2 });
  el.scroller.scrollLeft = Math.max(0, root._x * state.scale - el.scroller.clientWidth / 2);
  el.scroller.scrollTop = 0;
}

function scrollToNode(id, targetScale) {
  if (!state.visibleIds.has(id)) return;
  const node = getNode(id);
  if (!node) return;

  const desiredScale = targetScale || Math.max(state.scale, window.innerWidth < MOBILE_BREAKPOINT ? 0.84 : 0.95);
  if (state.scale < desiredScale) {
    setScale(desiredScale, { x: el.scroller.clientWidth / 2, y: el.scroller.clientHeight / 2 });
  }

  el.scroller.scrollTo({
    left: Math.max(0, node._x * state.scale - el.scroller.clientWidth / 2),
    top: Math.max(0, node._y * state.scale - el.scroller.clientHeight / 2 + 20),
    behavior: 'smooth'
  });

  const card = el.nodeLayer.querySelector(`[data-id="${cssEscape(id)}"]`);
  if (card) {
    card.classList.remove('pulse');
    void card.offsetWidth;
    card.classList.add('pulse');
    window.setTimeout(() => card.classList.remove('pulse'), 800);
  }
}

function branchChip(node) {
  return `<span class="detail-eyebrow" style="--branch:${esc(branchData(node).color)}">
    <i class="branch-dot" aria-hidden="true"></i>
    ${esc(branchData(node).label)}
    <span class="detail-year">${esc(node.year)}</span>
  </span>`;
}

function chip(node) {
  return `<button type="button" class="node-chip" data-open-node="${esc(node.id)}"
    style="--chip-branch:${esc(branchData(node).color)}">${esc(node.name)}</button>`;
}

function renderDrawer(node) {
  const parent = state.parentMap.get(node.id) ? getNode(state.parentMap.get(node.id)) : null;
  const children = (state.childrenMap.get(node.id) || []).map(getNode).filter(Boolean);
  const sourceSafe = node.source && isSafeHttpUrl(node.source.url);
  const changes = node.changes.map((change) => `<li>${esc(change)}</li>`).join('');
  const tags = node.tags.map((tag) => `<span class="detail-tag">${esc(tagLabel(tag))}</span>`).join('');

  const parentBlock = parent
    ? `<div class="lineage-row"><span class="lineage-label">Descends from</span>${chip(parent)}</div>`
    : `<div class="lineage-row"><span class="lineage-label">Root of this tree</span></div>`;

  const childrenBlock = children.length
    ? `<div class="detail-section">
        <h3>Branches directly below</h3>
        <div class="children-list">${children.map(chip).join('')}</div>
      </div>`
    : '';

  el.drawerBody.innerHTML = `
    ${branchChip(node)}
    <h2 class="detail-title" id="detailTitle">${esc(node.name)}</h2>
    <p class="detail-maker">${esc(node.maker)}${node.alias ? ` · ${esc(node.alias)}` : ''}</p>
    <p class="detail-summary">${esc(node.summary)}</p>
    <div class="detail-tags">${tags}</div>

    <section class="detail-section">
      <h3>Changes at this step</h3>
      <ul class="change-list">${changes}</ul>
    </section>

    <section class="detail-section">
      <h3>Lineage</h3>
      ${parentBlock}
    </section>

    ${childrenBlock}

    <section class="detail-section">
      <h3>Evidence &amp; source</h3>
      <blockquote class="evidence">${esc(node.evidence)}</blockquote>
      ${sourceSafe ? `<a class="source-link" href="${esc(node.source.url)}" target="_blank" rel="noopener">
        <span>${esc(node.source.label || 'Open project')}</span>
        <span aria-hidden="true">↗</span>
      </a>` : ''}
      <div class="detail-actions">
        <button type="button" class="ghost-button" id="copyNodeLink">Copy link to this board</button>
      </div>
    </section>
  `;

  el.drawerBody.querySelector('#copyNodeLink')?.addEventListener('click', copyCurrentLink);
  el.drawerBody.querySelectorAll('[data-open-node]').forEach((button) => {
    button.addEventListener('click', () => openNode(button.dataset.openNode, { scroll: true }));
  });
}

function highlightSelection(id) {
  const related = new Set([id]);
  let parentId = state.parentMap.get(id);
  while (parentId) {
    related.add(parentId);
    parentId = state.parentMap.get(parentId);
  }
  (state.childrenMap.get(id) || []).forEach((childId) => related.add(childId));

  el.edgeLayer.querySelectorAll('.edge').forEach((edge) => {
    const active =
      (edge.dataset.to === id || edge.dataset.from === id) &&
      (related.has(edge.dataset.from) || related.has(edge.dataset.to));
    edge.classList.toggle('is-active', active);
  });

  el.edgeLayer.querySelectorAll('.edge-label').forEach((label) => {
    const active = label.dataset.to === id || label.dataset.from === id;
    label.classList.toggle('is-active', active);
  });
}

function clearHighlight() {
  el.edgeLayer.querySelectorAll('.edge.is-active, .edge-label.is-active').forEach((item) => {
    item.classList.remove('is-active');
  });
}

function openNode(id, options = {}) {
  const node = getNode(id);
  if (!node) return;

  state.selectedId = id;
  renderDrawer(node);

  el.drawer.classList.add('is-open');
  el.drawer.setAttribute('aria-hidden', 'false');
  el.drawerBackdrop.hidden = false;
  requestAnimationFrame(() => el.drawerBackdrop.classList.add('is-open'));
  document.body.classList.add('drawer-open');

  el.nodeLayer.querySelectorAll('.node-card').forEach((card) => {
    card.classList.toggle('is-selected', card.dataset.id === id);
  });
  clearHighlight();
  highlightSelection(id);

  if (options.scroll) scrollToNode(id);
  if (options.updateHash !== false) {
    try {
      history.replaceState(null, '', `#${encodeURIComponent(id)}`);
    } catch {}
  }
  el.closeDrawer.focus({ preventScroll: true });
}

function closeDrawer(options = {}) {
  state.selectedId = null;
  el.drawer.classList.remove('is-open');
  el.drawer.setAttribute('aria-hidden', 'true');
  el.drawerBackdrop.classList.remove('is-open');
  document.body.classList.remove('drawer-open');
  window.setTimeout(() => {
    if (!el.drawer.classList.contains('is-open')) el.drawerBackdrop.hidden = true;
  }, 260);

  el.nodeLayer.querySelectorAll('.node-card.is-selected').forEach((card) => {
    card.classList.remove('is-selected');
  });
  clearHighlight();

  if (options.updateHash !== false) {
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    } catch {}
  }
}

async function copyCurrentLink() {
  const url = window.location.href;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = url;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  showToast('Link copied');
}

let toastTimer;
function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('is-open');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.toast.classList.remove('is-open'), 1800);
}

function updateThemeButton() {
  const dark = el.html.dataset.theme === 'dark';
  el.themeButton.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  el.themeButton.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#101417' : '#f3efe7');
}

function toggleTheme() {
  const next = el.html.dataset.theme === 'dark' ? 'light' : 'dark';
  el.html.dataset.theme = next;
  try {
    localStorage.setItem('ferris-tree-theme', next);
  } catch {}
  updateThemeButton();
}

function clearAllFilters() {
  window.clearTimeout(state.searchTimer);
  state.query = '';
  el.search.value = '';
  state.activeFilters.clear();
  syncFilterButtons();
  rebuildView({ reset: true });
}

function bindEvents() {
  el.search.addEventListener('input', () => {
    state.query = el.search.value;
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => {
      rebuildView({ focus: true });
    }, 120);
  });

  el.search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      window.clearTimeout(state.searchTimer);
      rebuildView({ focus: true });
    }
    if (event.key === 'Escape') {
      window.clearTimeout(state.searchTimer);
      el.search.value = '';
      state.query = '';
      rebuildView({ reset: true });
      el.search.blur();
    }
  });

  el.clearFilters.addEventListener('click', clearAllFilters);
  el.noResultsClear.addEventListener('click', clearAllFilters);

  el.contextButton.addEventListener('click', () => {
    state.ancestorsEnabled = !state.ancestorsEnabled;
    syncFilterButtons();
    rebuildView({ focus: true });
  });

  el.zoomIn.addEventListener('click', () => setScale(state.scale * 1.18));
  el.zoomOut.addEventListener('click', () => setScale(state.scale / 1.18));
  el.zoomReset.addEventListener('click', resetView);
  el.fitButton.addEventListener('click', fitTree);

  el.labelsButton.addEventListener('click', () => {
    state.labels = !state.labels;
    el.stage.classList.toggle('hide-labels', !state.labels);
    el.labelsButton.classList.toggle('is-on', state.labels);
    el.labelsButton.setAttribute('aria-pressed', String(state.labels));
  });

  document.querySelectorAll('[data-target]').forEach((button) => {
    button.addEventListener('click', () => scrollToNode(button.dataset.target));
  });

  el.scroller.addEventListener(
    'wheel',
    (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const rect = el.scroller.getBoundingClientRect();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      setScale(state.scale * factor, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      });
    },
    { passive: false }
  );

  let drag = null;
  el.scroller.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch') return;
    if (event.button !== 0 || event.target.closest('.node-card')) return;
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: el.scroller.scrollLeft,
      top: el.scroller.scrollTop
    };
    el.scroller.setPointerCapture(event.pointerId);
    el.scroller.classList.add('is-dragging');
  });

  el.scroller.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    el.scroller.scrollLeft = drag.left - (event.clientX - drag.x);
    el.scroller.scrollTop = drag.top - (event.clientY - drag.y);
  });

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    el.scroller.classList.remove('is-dragging');
    if (el.scroller.hasPointerCapture(event.pointerId)) {
      el.scroller.releasePointerCapture(event.pointerId);
    }
  };

  el.scroller.addEventListener('pointerup', endDrag);
  el.scroller.addEventListener('pointercancel', endDrag);

  el.closeDrawer.addEventListener('click', () => closeDrawer());
  el.drawerBackdrop.addEventListener('click', () => closeDrawer());
  el.themeButton.addEventListener('click', toggleTheme);

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing =
      target instanceof Element &&
      target.matches('input, textarea, [contenteditable="true"]');
    if (typing) return;

    if (state.selectedId) {
      if (event.key === 'Escape') closeDrawer();
      return;
    }

    if (event.key === '/' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      el.search.focus();
      return;
    }

    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setScale(state.scale * 1.18);
    }
    if (event.key === '-') {
      event.preventDefault();
      setScale(state.scale / 1.18);
    }
    if (event.key === '0') {
      event.preventDefault();
      resetView();
    }
    if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      fitTree();
    }
  });

  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (getNode(id)) {
      openNode(id, { scroll: true, updateHash: false });
    } else if (!id && state.selectedId) {
      closeDrawer({ updateHash: false });
    }
  });
}

async function boot() {
  updateThemeButton();
  bindEvents();

  let data;
  try {
    data = await loadTreeData();
  } catch (error) {
    console.error(error);
    el.loadError.hidden = false;
    return;
  }

  prepareData(data);
  state.scale = window.innerWidth < MOBILE_BREAKPOINT ? 0.84 : 0.95;
  renderFilters();

  const hashId = decodeURIComponent(location.hash.slice(1));
  rebuildView({ reset: !getNode(hashId) });

  if (getNode(hashId)) {
    openNode(hashId, { scroll: true, updateHash: false });
  } else {
    el.scroller.focus({ preventScroll: true });
  }
}

boot();
