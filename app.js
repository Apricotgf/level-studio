/* 多层关卡设计工作台
   在参考实现之上新增：自由拖动编辑模式、任意楼层数量、墙体与门洞编辑。 */
const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const svg = $('canvas');

const DOOR_COLOR = '#c8a06a';   // 墙体颜色跟随所在楼层，门用独立的木色
const WINDOW_COLOR = '#9ec9e8'; // 玻璃色
const TYPE_NAME = { rect: '方形', circle: '圆形', arrow: '箭头', stairs: '楼梯', wall: '墙体' };
const TYPE_LABEL = { rect: '多边形', circle: '圆形', arrow: '箭头', stairs: '楼梯', wall: '墙体' };
const TYPE_ICON = { rect: '□', circle: '○', arrow: '↗', stairs: '▟', wall: '▮' };
const PALETTE = ['#22ad88', '#67a8d1', '#dfb76a', '#b18bc7', '#df8b82', '#6e8499'];
const MAX_FLOORS = 999;

let serial = 0;
const uid = p => p + Date.now().toString(36) + '-' + (serial++);
// 楼层配色：同一层的所有体块（含墙体）共用一种颜色
const floorColor = f => PALETTE[((f - 1) % PALETTE.length + PALETTE.length) % PALETTE.length];

function defaultState() {
  const floors = [1, 2, 3, 4, 5], floorHeights = {};
  floors.forEach((f, i) => floorHeights[f] = i * 4);
  return {
    name: '未命名关卡', floors, floorHeights, hiddenFloors: [], layers: [], shapes: [],
    gap: 4, wallHeight: 3, snapMode: 'grid', snapStep: 1,
    opacity: { wall: .9, door: .85, window: .35, slab: .5 }
  };
}

let state = defaultState();
let activeLayer = null, floor = 1, selected = null, selectedDoor = null, selectedWindow = null;
let tool = 'select', view = '2', zoom = 1, pan = { x: 0, y: 0 }, angle = -.65, tilt = .62;
let history = [], future = [], drag = null, space = false, wallDraft = null;
const collapsedFloors = new Set();
let objectClipboard = null, pasteCount = 0;

/* ---------- 基础工具 ---------- */
function el(tag, attrs = {}, parent = svg) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}
const clone = v => JSON.parse(JSON.stringify(v));
function checkpoint() { history.push(clone(state)); if (history.length > 80) history.shift(); future = []; undoButtons(); }
function undoButtons() { $('undo').disabled = !history.length; $('redo').disabled = !future.length; }
function toast(msg) {
  $('toast').textContent = msg; $('toast').classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').classList.remove('show'), 2400);
}
const layer = s => state.layers.find(l => l.id === s.layer);
const shape = () => state.shapes.find(s => s.id === selected) || null;
const shapeOfLayer = id => state.shapes.find(s => s.layer === id) || null;
// 开口（门 / 窗）都挂在墙上，用这两个 id 记录当前选中的是谁
const OPEN_KEY = { door: 'doors', window: 'windows' };
function clearOpening() { selectedDoor = null; selectedWindow = null; }
function openingList(wall, kind) { return wall[OPEN_KEY[kind]] || (wall[OPEN_KEY[kind]] = []); }
function currentOpening() {
  const s = shape(); if (!s) return null;
  for (const kind of ['window', 'door']) {
    const id = kind === 'window' ? selectedWindow : selectedDoor;
    if (!id) continue;
    const obj = (s[OPEN_KEY[kind]] || []).find(o => o.id === id);
    if (obj) return { kind, wall: s, obj };
  }
  return null;
}
const ptsOf = a => a.map(p => `${p.x},${p.y}`).join(' ');
function segPoint(seg, t) { const len = dist(seg.a, seg.b) || 1; const k = t / len; return { x: seg.a.x + (seg.b.x - seg.a.x) * k, y: seg.a.y + (seg.b.y - seg.a.y) * k }; }

/* ---------- 视图与吸附 ---------- */
function unit() { return 40 * zoom; }
function center() { return { x: svg.clientWidth / 2 + pan.x, y: svg.clientHeight / 2 + pan.y }; }
function project(p, f = 1) {
  const c = center(), u = unit();
  if (view === '2') return { x: c.x + p.x * u, y: c.y + p.y * u };
  const ca = Math.cos(angle), sa = Math.sin(angle);
  return { x: c.x + (p.x * ca - p.y * sa) * u, y: c.y + (p.x * sa + p.y * ca) * u * Math.sin(tilt) - floorHeight(state, f) * u * Math.cos(tilt) };
}
function projectAt(p, f) { const q = project(p, f); if (view === '3') q.y -= (p.z || 0) * unit() * Math.cos(tilt); return q; }
function world(e) {
  const r = svg.getBoundingClientRect(), c = center();
  return { x: (e.clientX - r.left - c.x) / unit(), y: (e.clientY - r.top - c.y) / unit() };
}
function localOf(x, y) { const r = svg.getBoundingClientRect(); return { x: x - r.left, y: y - r.top }; }

/* 触屏：双指缩放 + 平移（iPad / 安卓平板 / 触屏笔记本） */
const touchPointers = new Map();
let gesture = null;
const isCoarse = () => !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
function startGesture() {
  const [a, b] = [...touchPointers.values()];
  gesture = {
    dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    zoom, pan: { ...pan }
  };
}
function updateGesture() {
  const [a, b] = [...touchPointers.values()];
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  const z = clamp(gesture.zoom * (d / gesture.dist), .005, 3);
  const sc = { x: svg.clientWidth / 2, y: svg.clientHeight / 2 };
  // 手势开始时中心点下的世界坐标，始终跟在当前双指中心下（2D / 3D 通用）
  const k = {
    x: (gesture.center.x - sc.x - gesture.pan.x) / (40 * gesture.zoom),
    y: (gesture.center.y - sc.y - gesture.pan.y) / (40 * gesture.zoom)
  };
  zoom = z;
  pan = { x: c.x - sc.x - k.x * 40 * z, y: c.y - sc.y - k.y * 40 * z };
  render();
}
// 自由拖动模式下不做任何吸附；网格模式按步长吸附；Shift 临时反转当前模式
function quantP(p, invert = false) {
  const snapped = state.snapMode !== 'free';
  if (!(invert ? !snapped : snapped)) return { x: p.x, y: p.y };
  const s = state.snapStep || 1;
  return { x: Math.round(p.x / s) * s, y: Math.round(p.y / s) * s };
}
function setSnapMode(mode) {
  state.snapMode = mode === 'free' ? 'free' : 'grid';
  $('snapGrid').classList.toggle('active', state.snapMode === 'grid');
  $('snapFree').classList.toggle('active', state.snapMode === 'free');
  $('modeGrid').classList.toggle('active', state.snapMode === 'grid');
  $('modeFree').classList.toggle('active', state.snapMode === 'free');
  $('snapStep').disabled = state.snapMode === 'free';
  render();
}

/* ---------- 渲染：2D ---------- */
function drawGrid2D() {
  const c = center(), u = unit(), defs = el('defs');
  const pattern = el('pattern', { id: 'gridpattern', width: u, height: u, patternUnits: 'userSpaceOnUse', x: c.x, y: c.y }, defs);
  el('path', { d: `M ${u} 0 L 0 0 0 ${u}`, fill: 'none', stroke: '#dfe5dd', 'stroke-width': .7 }, pattern);
  el('rect', { width: '100%', height: '100%', fill: 'url(#gridpattern)' });
  el('line', { x1: c.x, x2: c.x, y1: 0, y2: svg.clientHeight, stroke: '#c8d6c9', 'stroke-width': 1 });
  el('line', { x1: 0, x2: svg.clientWidth, y1: c.y, y2: c.y, stroke: '#c8d6c9', 'stroke-width': 1 });
}
function sweepFlag(c, s, e) {
  const a0 = Math.atan2(s.y - c.y, s.x - c.x), a1 = Math.atan2(e.y - c.y, e.x - c.x);
  let d = a1 - a0;
  while (d <= -Math.PI) d += Math.PI * 2;
  while (d > Math.PI) d -= Math.PI * 2;
  return d > 0 ? 1 : 0;
}
function drawWall2D(s, f, active) {
  const u = unit(), th = Math.max(1.6, (s.thickness || .2) * u);
  const g = el('g', { 'pointer-events': 'none', opacity: active ? 1 : .2 });
  const segs = wallSegments(s);
  segs.forEach((seg, i) => {
    for (const sp of wallPlanSpans(s, i)) {   // 平面上开口处断开
      const A = project(segPoint(seg, sp.t0), f), B = project(segPoint(seg, sp.t1), f);
      el('line', { x1: A.x, y1: A.y, x2: B.x, y2: B.y, stroke: s.color, 'stroke-width': th, 'stroke-linecap': 'butt' }, g);
    }
  });
  for (const d of (s.doors || [])) {
    const an = openingAnchor(s, d); if (!an) continue;
    const c = doorColor(d);
    const hinge = project(an.hinge, f), tip = project(an.tip, f), jamb = project(an.jamb, f);
    const r = Math.max(2, dist(hinge, tip));
    el('line', { x1: hinge.x, y1: hinge.y, x2: tip.x, y2: tip.y, stroke: c, 'stroke-width': Math.max(2, th * .5), 'stroke-linecap': 'round' }, g);
    el('path', { d: `M${tip.x},${tip.y} A${r},${r} 0 0 ${sweepFlag(hinge, tip, jamb)} ${jamb.x},${jamb.y}`, fill: 'none', stroke: shade(c, .75), 'stroke-width': 1.2, 'stroke-dasharray': '4 3' }, g);
  }
  for (const w of (s.windows || [])) {
    const an = openingAnchor(s, w); if (!an) continue;
    const c = windowColor(w);
    const a = project(an.hinge, f), b = project(an.jamb, f);
    const half = { x: an.nrm.x * (s.thickness || .2) / 2 * u, y: an.nrm.y * (s.thickness || .2) / 2 * u };
    el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: c, 'stroke-width': Math.max(2, th * .75), 'stroke-linecap': 'butt' }, g); // 玻璃
    el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: shade(c, .55), 'stroke-width': .9 }, g);                                   // 中线
    for (const p of [a, b]) {                                                                                                          // 两侧窗框
      el('line', { x1: p.x - half.x, y1: p.y - half.y, x2: p.x + half.x, y2: p.y + half.y, stroke: shade(c, .5), 'stroke-width': 1.4 }, g);
    }
  }
}
function doorColor(d) { return d.color || DOOR_COLOR; }
function windowColor(w) { return w.color || WINDOW_COLOR; }
function drawShapes2D() {
  const order = [...state.floors.filter(f => f !== floor), floor];
  for (const f of order) {
    const cur = f === floor;
    if (!cur && !$('ghost').checked) continue;
    for (const l of state.layers) {
      if (l.floor !== f || !layerVisible(state, l)) continue;
      const s = shapeOfLayer(l.id); if (!s) continue;
      if (s.type === 'wall') { drawWall2D(s, f, cur); continue; }
      const points = geometry(s).map(p => project(p, f));
      el('polygon', {
        points: ptsOf(points), fill: s.color, 'fill-opacity': cur ? .52 : .1, stroke: s.color,
        'stroke-width': selected === s.id ? 2.5 : 1.5, 'stroke-opacity': cur ? 1 : .25,
        'data-shape': s.id, 'pointer-events': cur && !l.locked ? 'all' : 'none',
        cursor: tool === 'select' ? 'move' : 'crosshair'
      });
      if (s.type === 'stairs') drawStairPlan(s, f, cur ? 1 : .25);
    }
  }
  // 墙体的点击热区（画在上层，保证门可点）
  for (const l of state.layers) {
    if (l.floor !== floor || !layerVisible(state, l) || l.locked) continue;
    const s = shapeOfLayer(l.id); if (!s || s.type !== 'wall') continue;
    const u = unit(), th = Math.max(1.6, (s.thickness || .2) * u);
    const pts = (s.closed ? [...s.points, s.points[0]] : s.points).map(p => project(p, floor));
    if (pts.length < 2) continue;
    el('path', {
      d: 'M' + pts.map(p => `${p.x},${p.y}`).join(' L'), fill: 'none', stroke: s.color, 'stroke-opacity': 0,
      'stroke-width': Math.max(14, th + 10), 'pointer-events': 'stroke', 'data-shape': s.id,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', cursor: tool === 'select' ? 'move' : 'crosshair'
    });
    for (const d of (s.doors || [])) {
      const an = openingAnchor(s, d); if (!an) continue;
      const hinge = project(an.hinge, floor), tip = project(an.tip, floor);
      el('path', {
        d: `M${hinge.x},${hinge.y} L${tip.x},${tip.y}`, fill: 'none', stroke: doorColor(d), 'stroke-opacity': 0,
        'stroke-width': 18, 'pointer-events': 'stroke', 'data-door': d.id, cursor: 'move'
      });
    }
    for (const w of (s.windows || [])) {
      const an = openingAnchor(s, w); if (!an) continue;
      const a = project(an.hinge, floor), b = project(an.jamb, floor);
      el('path', {
        d: `M${a.x},${a.y} L${b.x},${b.y}`, fill: 'none', stroke: windowColor(w), 'stroke-opacity': 0,
        'stroke-width': 18, 'pointer-events': 'stroke', 'data-window': w.id, cursor: 'move'
      });
    }
  }
}
function drawStairPlan(s, f, opacity) {
  if (s.points.length !== 4) return;
  const g = el('g', { 'pointer-events': 'none', opacity });
  for (let i = 1; i < (s.stairSteps || 12); i++) {
    const a = project(stairPoint(s, 0, i / (s.stairSteps || 12)), f), b = project(stairPoint(s, 1, i / (s.stairSteps || 12)), f);
    el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: s.color, 'stroke-width': 1 }, g);
  }
  const a = project(stairPoint(s, .5, .12), f), b = project(stairPoint(s, .5, .85), f);
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.max(1, Math.hypot(dx, dy)), ux = dx / len, uy = dy / len;
  el('path', {
    d: `M${a.x},${a.y} L${b.x},${b.y} M${b.x - ux * 8 - uy * 5},${b.y - uy * 8 + ux * 5} L${b.x},${b.y} L${b.x - ux * 8 + uy * 5},${b.y - uy * 8 - ux * 5}`,
    stroke: shade(s.color, .55), 'stroke-width': 2, fill: 'none'
  }, g);
}
function drawVertexHandles(s) {
  const pts = s.points, closed = s.type === 'rect' ? true : !!s.closed;
  pts.forEach((p, i) => {
    const a = project(p);
    const next = pts[(i + 1) % pts.length];
    if (closed || i < pts.length - 1) {
      const m = project({ x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 });
      el('circle', { cx: m.x, cy: m.y, r: 8, fill: '#fff', stroke: '#0a9f80', 'data-mid': i, cursor: 'copy' });
      const t = el('text', { x: m.x, y: m.y + 4, 'text-anchor': 'middle', fill: '#0a9f80', 'font-size': 12, 'pointer-events': 'none' });
      t.textContent = '+';
    }
    el('circle', { cx: a.x, cy: a.y, r: 5, fill: '#0a9f80', stroke: '#fff', 'stroke-width': 2, 'data-vertex': i, cursor: 'move' });
  });
}
function drawResizeHandles(s) {
  const b = bounds(s.points);
  const a = project(b), z = project({ x: b.x + b.w, y: b.y + b.h });
  el('rect', { x: a.x - 3, y: a.y - 3, width: z.x - a.x + 6, height: z.y - a.y + 6, fill: 'none', stroke: '#159e80', 'stroke-dasharray': '4 3', 'pointer-events': 'none' });
  const corners = s.type === 'stairs' ? s.points.map((p, i) => [i, p]) : [[0, { x: b.x, y: b.y }], [1, { x: b.x + b.w, y: b.y }], [2, { x: b.x + b.w, y: b.y + b.h }], [3, { x: b.x, y: b.y + b.h }]];
  for (const [i, p] of corners) {
    const q = project(p);
    el('rect', { x: q.x - 4, y: q.y - 4, width: 8, height: 8, rx: 1, fill: '#fff', stroke: '#149d7d', 'data-resize': i, cursor: i % 2 ? 'nesw-resize' : 'nwse-resize' });
  }
}
function drawRotationControl(s) {
  const c = project(rotationCenter(s)), b = bounds(s.points);
  const radius = Math.hypot(b.w, b.h) * 20 * zoom + 25, a = ((s.rotation || 0) - 90) * Math.PI / 180;
  const p = { x: c.x + Math.cos(a) * radius, y: c.y + Math.sin(a) * radius };
  el('line', { x1: c.x, y1: c.y, x2: p.x, y2: p.y, stroke: '#128b73', 'stroke-width': 1, 'stroke-dasharray': '3 4', 'pointer-events': 'none' });
  el('circle', { cx: p.x, cy: p.y, r: 10, fill: '#fff', stroke: '#128b73', 'stroke-width': 1.5, 'data-rotate': 'true', cursor: 'grab' });
  const label = el('text', { x: p.x, y: p.y + 4, 'text-anchor': 'middle', fill: '#128b73', 'font-size': 13, 'pointer-events': 'none' });
  label.textContent = '↻';
}
function drawOverlay() {
  const s = shape();
  if (!s || view !== '2') return;
  const l = layer(s);
  if (!l || l.floor !== floor || !layerVisible(state, l) || l.locked) return;
  if (tool !== 'select' && tool !== 'vertex') return;
  if (s.type === 'wall') {
    if (tool === 'vertex') drawVertexHandles(s);
    else {
      const b = bounds(s.points), a = project(b), z = project({ x: b.x + b.w, y: b.y + b.h });
      el('rect', { x: a.x - 4, y: a.y - 4, width: z.x - a.x + 8, height: z.y - a.y + 8, fill: 'none', stroke: '#159e80', 'stroke-dasharray': '4 3', 'pointer-events': 'none' });
      for (const d of (s.doors || [])) {
        const an = openingAnchor(s, d); if (!an) continue;
        const q = project(an.center);
        el('rect', { x: q.x - 5, y: q.y - 5, width: 10, height: 10, rx: 2, fill: selectedDoor === d.id ? DOOR_COLOR : '#fff', stroke: '#a5823f', 'stroke-width': 1.5, 'data-door': d.id, cursor: 'move' });
      }
      for (const w of (s.windows || [])) {
        const an = openingAnchor(s, w); if (!an) continue;
        const q = project(an.center);
        el('rect', { x: q.x - 5, y: q.y - 5, width: 10, height: 10, rx: 2, fill: selectedWindow === w.id ? WINDOW_COLOR : '#fff', stroke: '#5b8fb5', 'stroke-width': 1.5, 'data-window': w.id, cursor: 'move' });
      }
    }
    drawRotationControl(s);
    return;
  }
  if (tool === 'vertex' && s.type === 'rect') drawVertexHandles(s);
  else drawResizeHandles(s);
  drawRotationControl(s);
}

/* ---------- 渲染：3D ---------- */
function sideShade(color, n) {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const nx = n.x * ca - n.y * sa, ny = n.x * sa + n.y * ca;
  const d = nx * -.5 + ny * -.86;
  return shade(color, clamp(.58 + .22 * d, .34, .8));
}
function pushWallFaces(wall, f, faces, opacity = 1) {
  const segs = wallSegments(wall), half = (wall.thickness || .2) / 2, H = wall.height || 3;
  const z = (p, h) => ({ x: p.x, y: p.y, z: h });
  segs.forEach((seg, i) => {
    const len = dist(seg.a, seg.b); if (len < 1e-6) return;
    const dir = { x: (seg.b.x - seg.a.x) / len, y: (seg.b.y - seg.a.y) / len }, nrm = { x: -dir.y, y: dir.x };
    for (const sp of wallSpans(wall, i)) {
      const A = { x: seg.a.x + dir.x * sp.t0, y: seg.a.y + dir.y * sp.t0 };
      const B = { x: seg.a.x + dir.x * sp.t1, y: seg.a.y + dir.y * sp.t1 };
      const p0 = { x: A.x + nrm.x * half, y: A.y + nrm.y * half }, p1 = { x: B.x + nrm.x * half, y: B.y + nrm.y * half };
      const p2 = { x: B.x - nrm.x * half, y: B.y - nrm.y * half }, p3 = { x: A.x - nrm.x * half, y: A.y - nrm.y * half };
      const stroke = shade(wall.color, .6);
      faces.push({ points: [z(p0, sp.h1), z(p1, sp.h1), z(p2, sp.h1), z(p3, sp.h1)], f, color: shade(wall.color, 1), stroke, kind: 'wall-top', id: wall.id, opacity, depthBias: .6 });
      faces.push({ points: [z(p0, sp.h1), z(p1, sp.h1), z(p1, sp.h0), z(p0, sp.h0)], f, color: sideShade(wall.color, nrm), stroke, kind: 'wall-side', id: wall.id, opacity, depthBias: 0 });
      faces.push({ points: [z(p3, sp.h1), z(p2, sp.h1), z(p2, sp.h0), z(p3, sp.h0)], f, color: sideShade(wall.color, { x: -nrm.x, y: -nrm.y }), stroke, kind: 'wall-side', id: wall.id, opacity, depthBias: 0 });
    }
  });
}
function pushDoorLeaf(wall, d, f, faces, opacity = .95) {
  const an = openingAnchor(wall, d); if (!an) return;
  const dh = Math.min(d.height || 2.1, wall.height || 3), c = doorColor(d);
  const b = d.open ? an.tip : an.jamb;   // 关闭时门扇填满门洞，开启时甩出 90°
  faces.push({
    points: [{ ...an.hinge, z: 0 }, { ...b, z: 0 }, { ...b, z: dh }, { ...an.hinge, z: dh }],
    f, color: shade(c, .85), stroke: shade(c, .5), kind: 'door', id: wall.id, opacity, depthBias: .3
  });
}
function pushWindowPane(wall, w, f, faces, opacity = .35) {
  const an = openingAnchor(wall, w); if (!an) return;
  const H = wall.height || 3;
  const z0 = clamp(w.sill || 0, 0, H), z1 = clamp(z0 + (w.height || 1.4), 0, H);
  if (z1 - z0 < 1e-4) return;
  const c = windowColor(w);
  faces.push({
    points: [{ ...an.hinge, z: z0 }, { ...an.jamb, z: z0 }, { ...an.jamb, z: z1 }, { ...an.hinge, z: z1 }],
    f, color: shade(c, 1), stroke: shade(c, .55), kind: 'window', id: wall.id, opacity, depthBias: .3
  });
}
function drawPreviewGrid(f, b, defs) {
  const o = project({ x: 0, y: 0 }, f), px = project({ x: 1, y: 0 }, f), py = project({ x: 0, y: 1 }, f), u = unit();
  const group = el('g', { transform: 'matrix(' + [px.x - o.x, px.y - o.y, py.x - o.x, py.y - o.y, o.x, o.y].join(' ') + ')', 'pointer-events': 'none' });
  el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: '#edf4ed', 'fill-opacity': .12, stroke: '#a9bfb0', 'stroke-width': .8 / u }, group);
  if ($('grid').checked) {
    const majorStep = Math.max(5, 5 ** Math.ceil(Math.log(8 / Math.max(.001, u)) / Math.log(5)));
    for (const [id, step, color, width, opacity] of [['unit', 1, '#c6d5c8', .55, Math.min(1, u / 4)], ['major', majorStep, '#b5c7b9', .8, 1]]) {
      const patternId = 'preview-grid-' + f + '-' + id;
      const pattern = el('pattern', { id: patternId, width: step, height: step, patternUnits: 'userSpaceOnUse' }, defs);
      el('path', { d: 'M' + step + ' 0 H0 V' + step, fill: 'none', stroke: color, 'stroke-width': width / u }, pattern);
      el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: 'url(#' + patternId + ')', opacity }, group);
    }
  }
  const label = project({ x: b.x, y: b.y }, f);
  el('text', { x: label.x - 10, y: label.y - 12, fill: '#527e68', 'font-size': 13, 'font-weight': 600 }).textContent = f + 'F · 高度 ' + floorHeight(state, f);
}
function render3D() {
  const grid = previewGridBounds(state), defs = el('defs');
  for (const f of state.floors.filter(f => floorVisible(state, f))) drawPreviewGrid(f, grid, defs);
  const op = state.opacity || { wall: .9, door: .85, slab: .5 };
  const faces = [];
  for (const l of state.layers) {
    if (!layerVisible(state, l)) continue;
    const s = shapeOfLayer(l.id); if (!s) continue;
    if (s.type === 'wall') {
      if (op.wall > .02) pushWallFaces(s, l.floor, faces, op.wall);
      if (op.door > .02) for (const d of (s.doors || [])) pushDoorLeaf(s, d, l.floor, faces, op.door);
      if (op.window > .02) for (const w of (s.windows || [])) pushWindowPane(s, w, l.floor, faces, op.window);
      continue;
    }
    if (s.type === 'stairs' && s.points.length === 4) {
      for (const face of stairMesh(s, state.gap, stairRise(state, s))) faces.push({ ...face, f: l.floor, color: shade(s.color, face.shade), stroke: shade(s.color, .55), id: s.id, opacity: 1, depthBias: 0 });
      continue;
    }
    if (op.slab > .02) faces.push({ points: geometry(s), f: l.floor, color: s.color, stroke: s.color, id: s.id, opacity: op.slab, kind: 'plane', depthBias: 0 });
  }
  const depth = face => face.points.reduce((sum, p) => sum + (p.x * Math.sin(angle) + p.y * Math.cos(angle)) * Math.cos(tilt) + (floorHeight(state, face.f) + (p.z || 0)) * Math.sin(tilt), 0) / face.points.length + (face.depthBias || 0);
  faces.sort((a, b) => depth(a) - depth(b));
  for (const face of faces) {
    const soft = ['wall-top', 'wall-side', 'door', 'window'].includes(face.kind);
    el('polygon', {
      points: ptsOf(face.points.map(p => projectAt(p, face.f))), fill: face.color, 'fill-opacity': face.opacity,
      stroke: face.stroke, 'stroke-width': .7, 'stroke-linejoin': 'round', 'pointer-events': 'none',
      'stroke-opacity': soft ? clamp(face.opacity + .1, 0, 1) : 1
    });
  }
}
function render() {
  svg.replaceChildren();
  for (const w of state.shapes) if (w.type === 'wall') syncOpenings(w);
  if (view === '3') { render3D(); }
  else {
    if ($('grid').checked) drawGrid2D();
    drawShapes2D();
    drawOverlay();
  }
  updateChrome();
}
function updateChrome() {
  $('empty').hidden = state.shapes.length > 0 || view === '3';
  $('zoomLabel').textContent = Math.round(zoom * 100) + '%';
  const oc = openingCounts(state);
  $('stats').textContent = state.shapes.length + ' 个图形'
    + (oc.doors ? ' · ' + oc.doors + ' 扇门' : '') + (oc.windows ? ' · ' + oc.windows + ' 扇窗' : '');
  $('status').textContent = view === '3' ? '3D 空间预览' : floor + 'F · ' + (state.layers.find(l => l.id === activeLayer)?.name || '');
  const touch = isCoarse();
  $('hint').textContent = view === '3' ? (touch ? '单指拖动旋转视角 · 双指缩放 / 平移' : '拖动旋转视角 · 滚轮缩放 · 空格拖动平移')
    : tool === 'wall' ? (touch ? '点击添加墙节点 · 点首点闭合 · 双击结束 · 点其他工具也可结束' : '点击添加墙节点 · 点首点闭合 · 双击或 Enter 结束 · Esc 取消')
      : tool === 'door' ? '点击墙体添加门洞 · 拖动现有门可沿墙滑动'
        : tool === 'window' ? '点击墙体添加窗洞 · 拖动现有窗可沿墙滑动'
          : tool === 'vertex' ? '拖动顶点调整轮廓 · 点击 ＋ 增加顶点'
            : tool === 'select' ? (touch
              ? (state.snapMode === 'free' ? '自由拖动：不受网格约束 · 双指缩放 / 平移' : '网格吸附中 · 双指缩放 / 平移 · 长按拖动可再编辑')
              : (state.snapMode === 'free' ? '自由拖动：不受网格约束 · Shift 临时吸附' : '网格吸附中 · Shift 临时自由 · Alt 拖动复制 · 空格平移'))
              : '在画布上拖动绘制 · Esc 返回选择';
}

/* ---------- 楼层 / 图层 ---------- */
function chooseFloor(f) { floor = f; selected = null; clearOpening(); activeLayer = null; panels(); properties(); render(); }
function selectObject(s) { collapsedFloors.delete(layer(s).floor); selected = s.id; clearOpening(); activeLayer = s.layer; floor = layer(s).floor; panels(); properties(); render(); }
function refresh() { panels(); properties(); render(); }
function toggleFloorVisibility(f) {
  checkpoint();
  const hidden = new Set(state.hiddenFloors || []);
  if (hidden.has(f)) hidden.delete(f); else hidden.add(f);
  state.hiddenFloors = [...hidden]; drag = null; refresh();
}
function toggleLayerVisibility(l) { checkpoint(); l.visible = !l.visible; drag = null; refresh(); }
function setFloorHeight(f, value) {
  const h = Number(value);
  if (String(value).trim() === '' || !Number.isFinite(h) || Math.abs(h) > 100000) { toast('请输入 -100000 至 100000 之间的高度'); return false; }
  if (h === floorHeight(state, f)) return true;
  checkpoint();
  state.floorHeights = Object.fromEntries(state.floors.map(n => [n, floorHeight(state, n)]));
  state.floorHeights[f] = h;
  refresh(); return true;
}
function addFloor() {
  if (state.floors.length >= MAX_FLOORS) { toast('楼层数量已达上限 ' + MAX_FLOORS); return; }
  checkpoint();
  const next = Math.max(...state.floors) + 1;
  state.floorHeights = Object.fromEntries(state.floors.map(f => [f, floorHeight(state, f)]));
  state.floorHeights[next] = floorHeight(state, Math.max(...state.floors)) + state.gap;
  state.floors.push(next);
  chooseFloor(next);
  toast('已新增 ' + next + 'F');
}
function setFloorCount(n) {
  n = clamp(Math.round(Number(n)) || 1, 1, MAX_FLOORS);
  if (n === state.floors.length) { $('floorCount').value = n; return; }
  checkpoint();
  const heights = Object.fromEntries(state.floors.map(f => [f, floorHeight(state, f)]));
  if (n > state.floors.length) {
    for (let f = state.floors.length + 1; f <= n; f++) heights[f] = heights[f - 1] + state.gap;
    state.floors = Array.from({ length: n }, (_, i) => i + 1);
  } else {
    state.floors = state.floors.filter(f => f <= n);
    const keep = new Set(state.floors);
    const drop = new Set(state.layers.filter(l => !keep.has(l.floor)).map(l => l.id));
    state.layers = state.layers.filter(l => keep.has(l.floor));
    state.shapes = state.shapes.filter(s => !drop.has(s.layer));
    if (!keep.has(floor)) { floor = Math.max(...state.floors); selected = null; clearOpening(); activeLayer = null; }
  }
  state.hiddenFloors = (state.hiddenFloors || []).filter(f => f <= n);
  state.floorHeights = heights;
  panels(); properties(); render();
  toast('楼层数量已设为 ' + n + ' 层');
}
function copyFloor(f) {
  if (state.floors.length >= MAX_FLOORS) { toast('楼层数量已达上限 ' + MAX_FLOORS); return; }
  checkpoint();
  const next = Math.max(...state.floors) + 1;
  state.floorHeights = Object.fromEntries(state.floors.map(x => [x, floorHeight(state, x)]));
  state.floorHeights[next] = floorHeight(state, Math.max(...state.floors)) + state.gap;
  state.floors.push(next);
  for (const l of state.layers.filter(l => l.floor === f)) {
    const src = shapeOfLayer(l.id); if (!src) continue;
    const copy = clone(src); copy.id = uid('s'); copy.layer = 'l' + copy.id;
    if (copy.type === 'wall') { reidOpenings(copy); copy.color = floorColor(next); }
    state.layers.push({ ...clone(l), id: copy.layer, name: l.name, floor: next, visible: true, locked: false });
    state.shapes.push(copy);
  }
  floor = next; selected = null; clearOpening(); activeLayer = null;
  refresh(); toast('已把 ' + f + 'F 复制为 ' + next + 'F');
}
function eyeButton(visible, label, action, inherited = false) {
  const btn = document.createElement('button');
  btn.className = 'eye-button' + (visible ? '' : ' is-hidden') + (inherited ? ' inherited-hidden' : '');
  btn.title = (visible ? '隐藏' : '显示') + label + (inherited ? '（所属楼层已隐藏）' : '');
  btn.setAttribute('aria-label', btn.title); btn.setAttribute('aria-pressed', String(visible));
  const icon = el('svg', { viewBox: '0 0 24 24', width: 19, height: 19, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, btn);
  el('path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z' }, icon);
  el('circle', { cx: 12, cy: 12, r: 3 }, icon);
  if (!visible) el('path', { d: 'm3 3 18 18' }, icon);
  btn.onclick = e => { e.stopPropagation(); action(); };
  return btn;
}
function panels() {
  const tabs = $('floorTabs'); tabs.replaceChildren();
  const prev = document.createElement('button'); prev.textContent = '‹'; prev.title = '上一楼层';
  prev.onclick = () => { const i = state.floors.indexOf(floor); if (i > 0) chooseFloor(state.floors[i - 1]); };
  const next = document.createElement('button'); next.textContent = '›'; next.title = '下一楼层';
  next.onclick = () => { const i = state.floors.indexOf(floor); if (i < state.floors.length - 1) chooseFloor(state.floors[i + 1]); };
  const selector = document.createElement('select'); selector.id = 'floorSelect'; selector.setAttribute('aria-label', '当前楼层');
  for (const f of state.floors) { const o = document.createElement('option'); o.value = f; o.textContent = f + 'F'; selector.appendChild(o); }
  selector.value = floor; selector.onchange = () => chooseFloor(+selector.value);
  const count = document.createElement('span'); count.textContent = '共 ' + state.floors.length + ' 层';
  tabs.append(prev, selector, next, count);

  const list = $('layerList'); list.replaceChildren();
  for (const f of [...state.floors].reverse()) {
    const group = document.createElement('section');
    group.className = 'floor-group' + (floorVisible(state, f) ? '' : ' floor-hidden');
    const heading = document.createElement('div');
    heading.className = 'floor-heading' + (f === floor ? ' current' : '');
    const swatch = document.createElement('span');
    swatch.className = 'floor-swatch'; swatch.style.background = floorColor(f);
    swatch.title = f + 'F 的楼层配色 ' + floorColor(f);
    heading.appendChild(swatch);
    const choose = document.createElement('button'); choose.textContent = f + 'F · 楼层'; choose.onclick = () => chooseFloor(f);
    heading.appendChild(choose);
    const info = document.createElement('span');
    const items = state.layers.filter(l => l.floor === f);
    const counts = state.shapes.filter(s => s.type === 'wall' && items.some(l => l.id === s.layer))
      .reduce((acc, s) => ({ doors: acc.doors + (s.doors || []).length, windows: acc.windows + (s.windows || []).length }), { doors: 0, windows: 0 });
    info.textContent = items.length + ' 个体块'
      + (counts.doors ? ' · ' + counts.doors + ' 门' : '') + (counts.windows ? ' · ' + counts.windows + ' 窗' : '');
    heading.appendChild(info);
    const heightLabel = document.createElement('label');
    heightLabel.className = 'floor-height'; heightLabel.textContent = '高度';
    const heightInput = document.createElement('input');
    heightInput.type = 'number'; heightInput.step = 'any'; heightInput.value = floorHeight(state, f);
    heightInput.setAttribute('aria-label', f + 'F 高度');
    heightInput.title = '此楼层的绝对高度（单位），可输入小数或负数';
    heightInput.onclick = e => e.stopPropagation();
    heightInput.onchange = () => { if (!setFloorHeight(f, heightInput.value)) heightInput.value = floorHeight(state, f); };
    heightInput.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); heightInput.blur(); } };
    heightLabel.appendChild(heightInput); heading.appendChild(heightLabel);
    const dup = document.createElement('button'); dup.className = 'mini-button'; dup.textContent = '⧉';
    dup.title = '复制此楼层到新楼层'; dup.setAttribute('aria-label', '复制 ' + f + 'F');
    dup.onclick = e => { e.stopPropagation(); copyFloor(f); };
    heading.appendChild(dup);
    heading.appendChild(eyeButton(floorVisible(state, f), f + 'F 楼层', () => toggleFloorVisibility(f)));
    const fold = document.createElement('button');
    fold.className = 'floor-fold'; fold.textContent = collapsedFloors.has(f) ? '▸' : '▾';
    fold.title = '展开 / 收起子图层';
    fold.setAttribute('aria-expanded', String(!collapsedFloors.has(f)));
    fold.onclick = () => { if (collapsedFloors.has(f)) collapsedFloors.delete(f); else collapsedFloors.add(f); panels(); };
    heading.appendChild(fold);
    group.appendChild(heading);
    const children = document.createElement('div');
    children.id = 'floor-children-' + f; children.hidden = collapsedFloors.has(f);
    group.appendChild(children);
    for (const l of [...items].reverse()) {
      const obj = shapeOfLayer(l.id); if (!obj) continue;
      const row = document.createElement('div');
      row.className = 'layer' + (selected === obj.id ? ' active' : '');
      row.dataset.layer = l.id;
      row.setAttribute('aria-label', obj.name + ' 图层');
      const icon = document.createElement('button');
      icon.className = 'layer-icon'; icon.textContent = TYPE_ICON[obj.type] || '□'; icon.style.color = obj.color;
      icon.title = '选择体块'; icon.onclick = () => selectObject(obj);
      row.appendChild(icon);
      const name = document.createElement('input');
      name.value = obj.name; name.readOnly = true; name.disabled = l.locked;
      name.setAttribute('aria-label', '体块图层名称');
      name.title = '单击选择体块，双击重命名';
      name.onclick = e => { e.stopPropagation(); if (!name.readOnly) return; selected = obj.id; clearOpening(); activeLayer = l.id; floor = f; panels(); properties(); render(); svg.focus({ preventScroll: true }); };
      name.ondblclick = e => { e.stopPropagation(); if (l.locked) return; name.readOnly = false; name.focus(); name.select(); };
      name.onblur = () => { name.readOnly = true; };
      name.onkeydown = e => {
        if (e.key === 'Enter') { e.stopPropagation(); name.blur(); svg.focus({ preventScroll: true }); }
        if (e.key === 'Escape') { e.stopPropagation(); name.value = obj.name; name.blur(); svg.focus({ preventScroll: true }); }
      };
      name.onchange = () => { checkpoint(); obj.name = l.name = name.value || '未命名体块'; properties(); render(); };
      row.appendChild(name);
      if (obj.type === 'wall') {
        const nd = (obj.doors || []).length, nw = (obj.windows || []).length;
        const badge = document.createElement('span');
        badge.className = 'door-badge';
        badge.textContent = [nd ? nd + ' 门' : '', nw ? nw + ' 窗' : ''].filter(Boolean).join(' · ') || '无开口';
        row.appendChild(badge);
      }
      row.appendChild(eyeButton(l.visible, obj.name + ' 图层', () => toggleLayerVisibility(l), !floorVisible(state, f)));
      const lock = document.createElement('button');
      lock.className = 'mini-button'; lock.textContent = l.locked ? '▣' : '♧';
      lock.title = '锁定或解锁体块'; lock.setAttribute('aria-label', lock.title);
      lock.onclick = e => { e.stopPropagation(); checkpoint(); l.locked = !l.locked; refresh(); };
      row.appendChild(lock);
      row.onclick = () => { selectObject(obj); svg.focus({ preventScroll: true }); };
      children.appendChild(row);
    }
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'floor-empty'; empty.textContent = '此楼层暂无体块，选择后在画布绘制';
      children.appendChild(empty);
    }
    list.appendChild(group);
  }
  const cur = shape();
  const locked = !cur || !!layer(cur)?.locked;
  $('layerUp').disabled = $('layerDown').disabled = $('deleteLayer').disabled = locked;
  $('copyLayer').disabled = !cur;
  $('floorCount').value = state.floors.length;
  undoButtons();
}
function reorder(id, direction) {
  const l = state.layers.find(x => x.id === id); if (!l || l.locked) return;
  const siblings = state.layers.filter(x => x.floor === l.floor);
  const i = siblings.indexOf(l), other = siblings[i + direction];
  if (!other) return;
  checkpoint();
  const a = state.layers.indexOf(l), b = state.layers.indexOf(other);
  [state.layers[a], state.layers[b]] = [state.layers[b], state.layers[a]];
  refresh();
}
// 复制墙体时给门 / 窗换新 id，避免和原件共用标识
function reidOpenings(wall) {
  wall.doors = (wall.doors || []).map(d => ({ ...clone(d), id: uid('d') }));
  wall.windows = (wall.windows || []).map(w => ({ ...clone(w), id: uid('w') }));
}
function copyObject(source, sourceLayer, { targetFloor = sourceLayer.floor, offset = { x: 0, y: 0 }, afterLayerId = sourceLayer.id } = {}) {
  const copy = clone(source);
  copy.id = uid('s'); copy.layer = 'l' + copy.id;
  copy.name = source.name + ' 副本';
  copy.points = copy.points.map(p => ({ x: p.x + offset.x, y: p.y + offset.y }));
  if (copy.type === 'wall') { reidOpenings(copy); copy.color = floorColor(targetFloor); }
  const newLayer = { ...clone(sourceLayer), id: copy.layer, name: copy.name, floor: targetFloor, visible: true, locked: false };
  const after = state.layers.findIndex(l => l.id === afterLayerId);
  state.layers.splice(after < 0 ? state.layers.length : after + 1, 0, newLayer);
  state.shapes.push(copy);
  return copy;
}
function duplicate() {
  const source = shape(); if (!source) return;
  checkpoint();
  selectObject(copyObject(source, layer(source), { offset: { x: 1, y: 1 } }));
  svg.focus({ preventScroll: true });
}
function pasteClipboard() {
  if (!objectClipboard) return false;
  if (!floorVisible(state, floor)) { toast('当前楼层已隐藏，请先显示该楼层再粘贴'); return true; }
  checkpoint(); pasteCount++;
  const copy = copyObject(objectClipboard.shape, objectClipboard.layer, { targetFloor: floor, offset: { x: pasteCount, y: pasteCount }, afterLayerId: activeLayer });
  selectObject(copy); svg.focus({ preventScroll: true });
  return true;
}
function moveToFloor(s, f) { layer(s).floor = f; floor = f; activeLayer = s.layer; if (s.type === 'wall') s.color = floorColor(f); }
function removeShape(id) {
  const s = state.shapes.find(x => x.id === id);
  state.shapes = state.shapes.filter(x => x.id !== id);
  state.layers = state.layers.filter(l => l.id !== (s ? s.layer : id));
}
function remove() {
  const s = shape(); if (!s || layer(s).locked) return;
  checkpoint(); removeShape(s.id);
  selected = null; clearOpening(); activeLayer = null; refresh();
}

/* ---------- 属性面板 ---------- */
function syncOpenings(wall) {
  const n = wallSegments(wall).length;
  for (const key of ['doors', 'windows']) {
    if (!wall[key]) wall[key] = [];
    for (const o of wall[key]) { o.seg = clamp(o.seg | 0, 0, Math.max(0, n - 1)); o.t = clamp(o.t, 0, 1); }
  }
}
function selectOpening(kind, id) {
  if (kind === 'window') { selectedWindow = id; selectedDoor = null; } else { selectedDoor = id; selectedWindow = null; }
  properties(); render();
}
function renderOpeningList(kind) {
  const s = shape(), box = $(kind === 'window' ? 'windowList' : 'doorList');
  const list = s ? (s[OPEN_KEY[kind]] || []) : [];
  const name = kind === 'window' ? '窗' : '门';
  box.replaceChildren();
  if (!s || s.type !== 'wall' || !list.length) {
    const p = document.createElement('p');
    p.className = 'muted intro'; p.textContent = '这面墙还没有' + name + '洞。';
    box.appendChild(p); return;
  }
  list.forEach((o, i) => {
    const row = document.createElement('div');
    const activeId = kind === 'window' ? selectedWindow : selectedDoor;
    row.className = 'door-row' + (activeId === o.id ? ' active' : '');
    const label = document.createElement('button');
    label.className = 'door-label';
    label.textContent = `${name} ${i + 1} · 第 ${o.seg + 1} 段 · ${Math.round(o.t * 100)}% · 宽 ${(+o.width).toFixed(2)}`;
    label.onclick = () => { selectOpening(kind, o.id); properties(); render(); };
    const del = document.createElement('button');
    del.className = 'mini-button'; del.textContent = '×'; del.title = '删除这扇' + name;
    del.onclick = e => {
      e.stopPropagation(); checkpoint();
      s[OPEN_KEY[kind]] = (s[OPEN_KEY[kind]] || []).filter(x => x.id !== o.id);
      if (kind === 'window') { if (selectedWindow === o.id) selectedWindow = null; }
      else if (selectedDoor === o.id) selectedDoor = null;
      refresh();
    };
    row.append(label, del);
    box.appendChild(row);
  });
}
function properties() {
  const s = shape();
  const open = currentOpening();
  const door = open && open.kind === 'door' ? open.obj : null;
  const win = open && open.kind === 'window' ? open.obj : null;
  $('shapeProperties').hidden = !s;
  $('noSelection').hidden = !!s;
  $('shapeTag').textContent = s ? (door ? '门洞' : win ? '窗洞' : (TYPE_LABEL[s.type] || s.type)) : '未选择';
  if (!s) { $('doorProperties').hidden = $('windowProperties').hidden = $('wallProperties').hidden = true; return; }
  $('shapeName').value = s.name;
  $('shapeColor').value = s.color;
  $('colorValue').textContent = String(s.color).toUpperCase();
  const sel = $('shapeLayer'); sel.replaceChildren();
  for (const f of state.floors) { const o = document.createElement('option'); o.value = f; o.textContent = f + 'F'; sel.appendChild(o); }
  sel.value = layer(s).floor;
  const b = s.type === 'stairs' ? stairDimensions(s) : bounds(s.points);
  $('shapeWidth').value = +b.w.toFixed(2);
  $('shapeHeight').value = +b.h.toFixed(2);
  $('rotation').value = s.rotation || 0;
  $('stairsProperties').hidden = s.type !== 'stairs';
  $('wallProperties').hidden = s.type !== 'wall';
  const canVertex = s.type === 'rect' || s.type === 'wall';
  $('editVertices').hidden = !canVertex;
  $('vertexHelp').hidden = !canVertex;
  if (s.type === 'stairs') {
    $('stairSteps').value = s.stairSteps || 12;
    $('stairFloors').value = s.stairFloors || 1;
    $('stairReverse').value = s.stairReverse ? 'reverse' : 'forward';
    $('stairsConnection').textContent = layer(s).floor + 'F → ' + (layer(s).floor + (s.stairFloors || 1)) + 'F · 高度差 ' + Number(stairRise(state, s).toFixed(4)) + ' 单位';
  }
  if (s.type === 'wall') {
    $('wallThickness').value = s.thickness || .24;
    $('wallHeight').value = s.height || 3;
    $('wallClosed').checked = !!s.closed;
    const segs = wallSegments(s);
    $('wallSummary').textContent = `总长 ${wallLength(s).toFixed(2)} 单位 · ${s.points.length} 个节点 · ${segs.length} 段 · ${(s.doors || []).length} 门 ${(s.windows || []).length} 窗`;
    renderOpeningList('door');
    renderOpeningList('window');
  }
  $('doorProperties').hidden = !door;
  $('windowProperties').hidden = !win;
  if (win) {
    const H = s.height || 3;
    $('windowName').value = win.name || ('窗 ' + ((s.windows || []).indexOf(win) + 1));
    $('windowT').value = +win.t.toFixed(3);
    $('windowWidth').value = +win.width.toFixed(2);
    $('windowHeight').value = +win.height.toFixed(2);
    $('windowSill').value = +(win.sill || 0).toFixed(2);
    $('windowColor').value = windowColor(win);
    $('windowColorValue').textContent = windowColor(win).toUpperCase();
    $('windowNote').textContent = `开口位于 ${(+(win.sill || 0)).toFixed(2)} – ${(+((win.sill || 0) + win.height)).toFixed(2)} 单位高度（墙高 ${H}）`;
  }
  if (door) {
    $('doorName').value = door.name || ('门 ' + ((s.doors || []).indexOf(door) + 1));
    $('doorT').value = +door.t.toFixed(3);
    $('doorWidth').value = +door.width.toFixed(2);
    $('doorHeight').value = +door.height.toFixed(2);
    $('doorFlip').value = door.flip === -1 ? '-1' : '1';
    $('doorOpen').value = door.open ? 'open' : 'closed';
    $('doorColor').value = doorColor(door);
    $('doorColorValue').textContent = doorColor(door).toUpperCase();
  }
  const locked = layer(s).locked;
  for (const n of $('shapeProperties').querySelectorAll('input,select,button')) n.disabled = locked;
}
function panel(p) {
  $('layersPanel').hidden = p !== 'layers';
  $('propertiesPanel').hidden = p !== 'properties';
  document.querySelectorAll('[data-panel]').forEach(n => n.classList.toggle('active', n.dataset.panel === p));
  properties();
}
function mutate(fn) {
  const s = shape(); if (!s || layer(s).locked) return;
  checkpoint(); fn(s); panels(); properties(); render();
}
function mutateOpening(kind, fn) {
  const s = shape(); if (!s) return;
  const id = kind === 'window' ? selectedWindow : selectedDoor;
  const obj = (s[OPEN_KEY[kind]] || []).find(o => o.id === id);
  if (!obj) return;
  checkpoint(); fn(obj, s); panels(); properties(); render();
}

/* ---------- 工具与视图 ---------- */
function setTool(t) {
  if (view === '3') setView('2');
  if (wallDraft && t !== 'wall') finishWall(true);
  tool = t;
  document.querySelectorAll('[data-tool]').forEach(n => n.classList.toggle('active', n.dataset.tool === t));
  svg.style.cursor = t === 'pan' ? 'grab' : t === 'select' ? 'default' : 'crosshair';
  render();
}
function setView(v) {
  const changed = v !== view;
  if (changed) { view = v; pan = { x: 0, y: 0 }; zoom = 1; if (v === '3') fit3D(); }
  $('view2').classList.toggle('active', v === '2');
  $('view3').classList.toggle('active', v === '3');
  render();
  if (changed && v === '3') {   // 进 3D 时把不透明度滑块带到眼前
    panel('layers');
    const box = document.querySelector('#layersPanel .panel-sub:last-of-type');
    if (box) box.scrollIntoView({ block: 'nearest' });
  }
}
function fit3D() {
  pan = { x: 0, y: 0 }; zoom = 1;
  const gridBounds = previewGridBounds(state);
  const points = [];
  for (const f of state.floors.filter(f => floorVisible(state, f))) {
    for (const p of [{ x: gridBounds.x, y: gridBounds.y }, { x: gridBounds.x + gridBounds.w, y: gridBounds.y }, { x: gridBounds.x + gridBounds.w, y: gridBounds.y + gridBounds.h }, { x: gridBounds.x, y: gridBounds.y + gridBounds.h }]) points.push(project(p, f));
  }
  for (const s of state.shapes) {
    const l = layer(s); if (!l || !layerVisible(state, l)) continue;
    points.push(...geometry(s).map(p => project(p, l.floor)));
    if (s.type === 'wall') {
      for (const seg of wallSegments(s)) {
        for (const sp of wallSpans(s, seg.index)) {
          points.push(projectAt(segPoint(seg, sp.t0), l.floor));
          points.push({ x: projectAt(segPoint(seg, sp.t1), l.floor).x, y: projectAt(segPoint(seg, sp.t1), l.floor).y - (s.height || 3) * unit() * Math.cos(tilt) });
        }
      }
    }
    if (s.type === 'stairs') points.push(...stairMesh(s, state.gap, stairRise(state, s)).flatMap(face => face.points.map(p => projectAt(p, l.floor))));
  }
  if (!points.length) { zoom = 1; return; }
  const b = bounds(points);
  zoom = Math.max(.005, Math.min(1.2, (svg.clientWidth - 90) / Math.max(1, b.w), (svg.clientHeight - 160) / Math.max(1, b.h)));
  pan = { x: (svg.clientWidth / 2 - (b.x + b.w / 2)) * zoom, y: (svg.clientHeight / 2 - (b.y + b.h / 2)) * zoom + 25 };
}

/* ---------- 交互 ---------- */
function newShape(type, floorNum, points) {
  const id = uid('s'), layerId = 'l' + id;
  const name = TYPE_NAME[type] || '图形';
  state.layers.push({ id: layerId, name, floor: floorNum, visible: true, locked: false });
  const s = {
    id, type, layer: layerId, name, points,
    color: floorColor(floorNum),   // 墙体也跟随所在楼层配色
    rotation: 0
  };
  if (type === 'stairs') Object.assign(s, { stairSteps: 12, stairFloors: 1, stairReverse: false });
  if (type === 'wall') Object.assign(s, { thickness: .24, height: state.wallHeight || 3, closed: false, doors: [], windows: [] });
  state.shapes.push(s);
  return s;
}
function wallPointerDown(p, e) {
  const q = quantP(p, e.shiftKey);
  if (wallDraft) {
    const w = state.shapes.find(x => x.id === wallDraft);
    if (w) {
      if (w.points.length >= 3 && dist(q, w.points[0]) < .45) {
        checkpoint();
        if (dist(w.points[w.points.length - 1], w.points[0]) < .45) w.points.pop(); // 丢掉跟随光标的橡皮筋点
        w.closed = true;
        finishWall(); toast('墙体已闭合'); return;
      }
      const last = w.points[w.points.length - 1];
      if (dist(q, last) < .06) { finishWall(); return; }
      checkpoint();
      w.points.push({ x: q.x, y: q.y });
      drag = { kind: 'wallDraw', id: w.id };
      render(); return;
    }
    wallDraft = null;
  }
  checkpoint();
  const w = newShape('wall', floor, [{ x: q.x, y: q.y }, { x: q.x, y: q.y }]);
  wallDraft = w.id; selected = w.id; clearOpening(); activeLayer = w.layer;
  drag = { kind: 'wallDraw', id: w.id };
  panels(); properties(); render();
}
function finishWall(silent) {
  const id = wallDraft; wallDraft = null;
  const w = id ? state.shapes.find(x => x.id === id) : null;
  if (w) {
    w.points = w.points.filter((p, i) => i === 0 || dist(p, w.points[i - 1]) > 1e-6); // 去掉重复节点
    if (w.points.length < 2 || wallLength(w) < .02) removeShape(w.id);
    else { selected = w.id; clearOpening(); activeLayer = w.layer; }
  }
  drag = null;
  if (!silent) toast(wallLength(w || { points: [] }) > 0 ? '墙体完成 · 可继续绘制，按 Esc 返回选择' : '墙体已取消');
  panels(); properties(); render();
}
function makeOpening(kind, wall, seg, t, segLen) {
  const H = wall.height || 3;
  if (kind === 'window') return {
    id: uid('w'), seg, t, width: Math.min(1.6, Math.max(.5, segLen * .35)),
    height: Math.min(1.4, Math.max(.2, H * .45)), sill: Math.min(.9, Math.max(.1, H * .3)), color: WINDOW_COLOR
  };
  return {
    id: uid('d'), seg, t, width: Math.min(1.2, Math.max(.5, segLen * .35)),
    height: Math.min(2.2, H), sill: 0, flip: 1, open: false, color: DOOR_COLOR
  };
}
function placeOpening(kind, p) {
  const name = kind === 'window' ? '窗' : '门';
  let best = null;
  for (const w of state.shapes) {
    if (w.type !== 'wall') continue;
    const l = layer(w); if (!l || l.floor !== floor || !layerVisible(state, l) || l.locked) continue;
    const hit = nearestOnWall(w, p); if (!hit) continue;
    const threshold = Math.max(.5, (w.thickness || .24) * 1.8);
    if (hit.d <= threshold && (!best || hit.d < best.hit.d)) best = { wall: w, hit };
  }
  if (!best) { toast(name + '要开在墙上：把光标移到当前楼层的墙体上再点击'); return; }
  checkpoint();
  const wall = best.wall;
  const item = makeOpening(kind, wall, best.hit.seg, best.hit.t, best.hit.len);
  openingList(wall, kind).push(item);
  selected = wall.id; selectOpening(kind, item.id); activeLayer = wall.layer;
  panel('properties'); setTool('select'); panels(); properties(); render();
  toast('已加一扇' + name + ' · 拖动可沿墙滑动');
}
function addOpeningToWall(kind) {
  const s = shape(); if (!s || s.type !== 'wall') return;
  const name = kind === 'window' ? '窗' : '门';
  const segs = wallSegments(s); if (!segs.length) { toast('墙体太短，先画长一点'); return; }
  let idx = 0, bestLen = -1;
  segs.forEach((seg, i) => { const len = dist(seg.a, seg.b); if (len > bestLen) { bestLen = len; idx = i; } });
  checkpoint();
  const item = makeOpening(kind, s, idx, .5, bestLen);
  openingList(s, kind).push(item);
  selectOpening(kind, item.id);
  refresh(); toast('已添加' + name + '洞');
}
function beginMove(s) { checkpoint(); drag.moved = true; drag.start = clone(s); }

svg.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.button !== 1) return;
  svg.focus({ preventScroll: true });
  svg.setPointerCapture(e.pointerId);
  touchPointers.set(e.pointerId, localOf(e.clientX, e.clientY));
  if (touchPointers.size === 2) { endDrag(); startGesture(); return; }  // 第二根手指落下 → 转缩放/平移
  if (touchPointers.size > 2) return;
  const p = world(e);
  if (space || e.button === 1 || tool === 'pan') { drag = { kind: 'pan', x: e.clientX, y: e.clientY, pan: { ...pan } }; return; }
  if (view === '3') { drag = { kind: 'orbit', x: e.clientX, y: e.clientY, angle, tilt }; return; }
  const target = e.target, s = shape();
  const data = target.dataset || {};
  const openKind = data.window ? 'window' : data.door ? 'door' : null;
  const openId = data.window || data.door || null;
  if (openKind) {
    const wall = state.shapes.find(w => (w[OPEN_KEY[openKind]] || []).some(o => o.id === openId));
    if (wall && !layer(wall).locked && tool !== 'door' && tool !== 'window') {
      selected = wall.id; selectOpening(openKind, openId); activeLayer = wall.layer;
      checkpoint(); drag = { kind: 'openingMove', wallId: wall.id, kind2: openKind, openId };
      panels(); properties(); render(); return;
    }
  }
  if (target.hasAttribute('data-rotate') && s) {
    checkpoint(); const c = rotationCenter(s);
    drag = { kind: 'rotate', start: clone(s), center: c, angle: Math.atan2(p.y - c.y, p.x - c.x) }; return;
  }
  if (target.hasAttribute('data-mid') && s) {
    checkpoint(); const i = +target.dataset.mid;
    const a = s.points[i], b = s.points[(i + 1) % s.points.length];
    s.points.splice(i + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    drag = { kind: 'vertex', index: i + 1 }; render(); return;
  }
  if (target.hasAttribute('data-vertex') && s) { checkpoint(); drag = { kind: 'vertex', index: +target.dataset.vertex }; return; }
  if (target.hasAttribute('data-resize') && s) { checkpoint(); drag = { kind: 'resize', index: +target.dataset.resize, start: clone(s), box: bounds(s.points) }; return; }
  if (tool === 'select' || tool === 'vertex') {
    const id = target.dataset ? target.dataset.shape : null;
    selected = id || null; clearOpening();
    if (id) {
      const sh = shape(); activeLayer = sh.layer;
      if (e.altKey && !layer(sh).locked) {
        checkpoint();
        const copy = copyObject(sh, layer(sh), {});
        selected = copy.id; activeLayer = copy.layer; clearOpening();
        drag = { kind: 'move', start: clone(copy), p, moved: true };
      } else if (!layer(sh).locked) {
        drag = { kind: 'move', start: clone(sh), p, moved: false };
      }
    }
    panels(); properties(); render(); return;
  }
  if (tool === 'door') { placeOpening('door', p); return; }
  if (tool === 'window') { placeOpening('window', p); return; }
  if (tool === 'wall') { wallPointerDown(p, e); return; }
  if (!floorVisible(state, floor)) { toast('当前楼层已隐藏，请点击楼层旁的小眼睛显示后再绘制'); return; }
  checkpoint();
  collapsedFloors.delete(floor);
  const q = quantP(p, e.shiftKey);
  const sh = newShape(tool, floor, [q, { x: q.x + .01, y: q.y + .01 }]);
  selected = sh.id; clearOpening(); activeLayer = sh.layer;
  drag = { kind: 'draw', p: q };
  render();
});
svg.addEventListener('pointermove', e => {
  if (touchPointers.has(e.pointerId)) touchPointers.set(e.pointerId, localOf(e.clientX, e.clientY));
  if (gesture) { if (touchPointers.size >= 2) updateGesture(); return; }
  if (!drag) return;
  const p = world(e), s = shape(), shift = e.shiftKey;
  if (drag.kind === 'pan') { pan = { x: drag.pan.x + e.clientX - drag.x, y: drag.pan.y + e.clientY - drag.y }; render(); return; }
  if (drag.kind === 'orbit') { angle = drag.angle + (e.clientX - drag.x) * .008; tilt = clamp(drag.tilt + (e.clientY - drag.y) * .006, .15, 1.35); render(); return; }
  if (drag.kind === 'wallDraw') {
    const w = state.shapes.find(x => x.id === drag.id);
    if (w) { w.points[w.points.length - 1] = quantP(p, shift); render(); }
    return;
  }
  if (drag.kind === 'openingMove') {
    const wall = state.shapes.find(w => w.id === drag.wallId);
    const item = wall && (wall[OPEN_KEY[drag.kind2]] || []).find(o => o.id === drag.openId);
    if (wall && item) {
      const hit = nearestOnWall(wall, p);
      if (hit) { item.seg = hit.seg; item.t = hit.t; }
      properties(); render();
    }
    return;
  }
  if (!s) return;
  if (!drag.moved && (drag.kind === 'move' || drag.kind === 'resize' || drag.kind === 'vertex' || drag.kind === 'rotate')) beginMove(s);
  if (drag.kind === 'rotate') {
    let delta = Math.atan2(p.y - drag.center.y, p.x - drag.center.x) - drag.angle;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    s.points = clone(drag.start.points); s.rotation = drag.start.rotation || 0;
    rotateShapeTo(s, s.rotation + delta * 180 / Math.PI);
    if (s.type === 'wall') syncOpenings(s);
    $('rotation').value = s.rotation;
  }
  if (drag.kind === 'move') {
    const anchor = drag.start.points[0];
    const raw = { x: anchor.x + (p.x - drag.p.x), y: anchor.y + (p.y - drag.p.y) };
    const q = quantP(raw, shift);
    const delta = { x: q.x - anchor.x, y: q.y - anchor.y };
    s.points = drag.start.points.map(pt => ({ x: pt.x + delta.x, y: pt.y + delta.y }));
  }
  if (drag.kind === 'vertex') { s.points[drag.index] = quantP(p, shift); if (s.type === 'wall') syncOpenings(s); }
  if (drag.kind === 'resize') {
    if (s.type === 'stairs') { resizeStair(s, drag.start, quantP(p, shift), drag.index); render(); return; }
    const b = drag.box, q = quantP(p, shift);
    const op = [{ x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }, { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }][drag.index];
    let w = Math.max(.1, Math.abs(q.x - op.x)), h = Math.max(.1, Math.abs(q.y - op.y));
    if (s.type === 'circle') w = h = Math.max(w, h);
    const x = q.x < op.x ? op.x - w : op.x, y = q.y < op.y ? op.y - h : op.y;
    s.points = drag.start.points.map(a => ({ x: x + (a.x - b.x) / Math.max(.01, b.w) * w, y: y + (a.y - b.y) / Math.max(.01, b.h) * h }));
  }
  if (drag.kind === 'draw') {
    const q = quantP(p, shift), a = drag.p;
    const x = Math.min(a.x, q.x), y = Math.min(a.y, q.y);
    const w = Math.max(.05, Math.abs(q.x - a.x)), h = Math.max(.05, Math.abs(q.y - a.y));
    if (s.type === 'rect' || s.type === 'stairs') s.points = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    if (s.type === 'circle') { const d = Math.max(w, h); s.points = [a, { x: a.x + (q.x < a.x ? -d : d), y: a.y + (q.y < a.y ? -d : d) }]; }
    if (s.type === 'arrow') {
      const dx = q.x - a.x, dy = q.y - a.y, len = Math.max(.1, Math.hypot(dx, dy)), ux = dx / len, uy = dy / len;
      const head = Math.min(1.2, len * .4), th = .22;
      const trans = (u, v) => ({ x: a.x + u * ux - v * uy, y: a.y + u * uy + v * ux });
      s.points = [trans(0, -th), trans(len - head, -th), trans(len - head, -.65), trans(len, 0), trans(len - head, .65), trans(len - head, th), trans(0, th)];
    }
  }
  render();
});
function endDrag() {
  if (!drag) return;
  if (drag.kind === 'draw') {
    const s = shape();
    if (s) {
      const b = bounds(s.points);
      if (b.w < .1 || b.h < .1 || s.points.length < 3) {
        const a = drag.p;
        s.points = s.type === 'arrow'
          ? [{ x: a.x, y: a.y - .2 }, { x: a.x + 2, y: a.y - .2 }, { x: a.x + 2, y: a.y - .7 }, { x: a.x + 3, y: a.y }, { x: a.x + 2, y: a.y + .7 }, { x: a.x + 2, y: a.y + .2 }, { x: a.x, y: a.y + .2 }]
          : [{ ...a }, { x: a.x + 3, y: a.y }, { x: a.x + 3, y: a.y + 3 }, { x: a.x, y: a.y + 3 }];
        if (s.type === 'circle') s.points = [a, { x: a.x + 3, y: a.y + 3 }];
      }
      if (s.type === 'stairs') { const b2 = stairDimensions(s); if (b2.w < .1) s.points = [{ ...drag.p }, { x: drag.p.x + 3, y: drag.p.y }, { x: drag.p.x + 3, y: drag.p.y + 6 }, { x: drag.p.x, y: drag.p.y + 6 }]; }
      setTool('select'); panels();
      if (s.type === 'stairs') panel('properties');
    }
  }
  if (drag.kind === 'wallDraw') {
    const w = state.shapes.find(x => x.id === drag.id);
    if (w && w.points.length > 2 && dist(w.points[w.points.length - 1], w.points[w.points.length - 2]) < 1e-6) w.points.pop();
  }
  drag = null; properties(); render();
}
function endPointer(e) {
  touchPointers.delete(e.pointerId);
  if (touchPointers.size < 2) gesture = null;
  endDrag();
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', endPointer);
svg.addEventListener('pointerleave', e => { touchPointers.delete(e.pointerId); if (touchPointers.size < 2) gesture = null; });
svg.addEventListener('dblclick', () => { if (tool === 'wall' && wallDraft) finishWall(); });
svg.addEventListener('wheel', e => { e.preventDefault(); zoom = clamp(zoom * Math.exp(-e.deltaY * .001), .005, 3); render(); }, { passive: false });

/* ---------- 面板与按钮 ---------- */
document.querySelectorAll('[data-tool]').forEach(n => n.onclick = () => setTool(n.dataset.tool));
document.querySelectorAll('[data-panel]').forEach(n => n.onclick = () => panel(n.dataset.panel));
$('view2').onclick = () => setView('2');
$('view3').onclick = $('previewLink').onclick = () => setView('3');
$('zoomIn').onclick = () => { zoom = clamp(zoom * 1.2, .005, 3); render(); };
$('zoomOut').onclick = () => { zoom = clamp(zoom / 1.2, .005, 3); render(); };
$('fit').onclick = () => {
  if (view === '3') { fit3D(); render(); return; }
  pan = { x: 0, y: 0 }; zoom = 1;
  const points = state.shapes.filter(s => layer(s)?.floor === floor && layerVisible(state, layer(s))).flatMap(s => s.points);
  if (points.length) {
    const b = bounds(points);
    zoom = clamp(Math.min(1.5, (svg.clientWidth - 120) / (40 * Math.max(5, b.w)), (svg.clientHeight - 180) / (40 * Math.max(5, b.h))), .2, 1.5);
    pan = { x: -(b.x + b.w / 2) * 40 * zoom, y: -(b.y + b.h / 2) * 40 * zoom };
  }
  render();
};
$('addFloor').onclick = addFloor;
$('layerUp').onclick = () => shape() && reorder(shape().layer, 1);
$('layerDown').onclick = () => shape() && reorder(shape().layer, -1);
$('copyLayer').onclick = duplicate;
$('deleteLayer').onclick = remove;
$('addDoor').onclick = () => addOpeningToWall('door');
$('addWindow').onclick = () => addOpeningToWall('window');
$('editVertices').onclick = () => setTool('vertex');
for (const id of ['grid', 'ghost']) $(id).onchange = render;

$('snapGrid').onclick = $('modeGrid').onclick = () => setSnapMode('grid');
$('snapFree').onclick = $('modeFree').onclick = () => setSnapMode('free');
$('snapStep').onchange = () => { state.snapStep = +$('snapStep').value || 1; render(); };
for (const [key, id] of [['wall', 'wallOpacity'], ['door', 'doorOpacity'], ['window', 'windowOpacity'], ['slab', 'slabOpacity']]) {
  $(id).addEventListener('input', () => {
    state.opacity = state.opacity || defaultState().opacity;
    state.opacity[key] = +$(id).value / 100;
    $(id + 'Value').textContent = Math.round(state.opacity[key] * 100) + '%';
    render();
  });
}
$('recolorWalls').onclick = () => {
  const walls = state.shapes.filter(s => s.type === 'wall');
  if (!walls.length) { toast('还没有墙体'); return; }
  checkpoint();
  let changed = 0;
  for (const w of walls) {
    const l = layer(w); if (!l) continue;
    const c = floorColor(l.floor);
    if (w.color !== c) { w.color = c; changed++; }
  }
  refresh(); toast(changed ? '已把 ' + changed + ' 面墙体刷成楼层配色' : '所有墙体已经是楼层配色');
};
$('floorCount').onchange = () => setFloorCount($('floorCount').value);
$('gapInput').onchange = () => {
  const g = clamp(+$('gapInput').value || 4, .5, 30);
  checkpoint(); state.gap = g;
  state.floorHeights = Object.fromEntries(state.floors.map((f, i) => [f, i * g]));
  $('gapInput').value = g; refresh(); toast('层高已设为 ' + g + '，各层高度重新排布');
};
$('wallHeightInput').onchange = () => {
  state.wallHeight = clamp(+$('wallHeightInput').value || 3, .1, 100);
  $('wallHeightInput').value = state.wallHeight;
  toast('新建墙体的默认高度已设为 ' + state.wallHeight);
};

$('shapeName').onchange = () => mutate(s => { s.name = layer(s).name = $('shapeName').value || '未命名体块'; });
$('shapeColor').onchange = () => mutate(s => s.color = $('shapeColor').value);
$('shapeLayer').onchange = () => { mutate(s => moveToFloor(s, +$('shapeLayer').value)); panels(); };
for (const axis of ['Width', 'Height']) {
  $('shape' + axis).onchange = () => mutate(s => {
    const b = bounds(s.points), v = clamp(+$('shape' + axis).value || 1, .1, 10000);
    if (s.type === 'stairs') { sizeStair(s, axis, v); return; }
    s.points = s.points.map(p => ({
      x: axis === 'Width' || s.type === 'circle' ? b.x + (p.x - b.x) * v / Math.max(.01, b.w) : p.x,
      y: axis === 'Height' || s.type === 'circle' ? b.y + (p.y - b.y) * v / Math.max(.01, b.h) : p.y
    }));
  });
}
$('rotation').onchange = () => mutate(s => { rotateShapeTo(s, $('rotation').value); if (s.type === 'wall') syncOpenings(s); });
$('rotateLeft').onclick = () => mutate(s => rotateShapeTo(s, (s.rotation || 0) - 15));
$('rotateRight').onclick = () => mutate(s => rotateShapeTo(s, (s.rotation || 0) + 15));
$('stairSteps').onchange = () => mutate(s => s.stairSteps = clamp(Math.round(+$('stairSteps').value) || 12, 2, 64));
$('stairFloors').onchange = () => mutate(s => s.stairFloors = clamp(Math.round(+$('stairFloors').value) || 1, 1, 100));
$('stairReverse').onchange = () => mutate(s => s.stairReverse = $('stairReverse').value === 'reverse');
$('wallThickness').onchange = () => mutate(s => s.thickness = clamp(+$('wallThickness').value || .24, .02, 10));
$('wallHeight').onchange = () => mutate(s => s.height = clamp(+$('wallHeight').value || 3, .1, 100));
$('wallClosed').onchange = () => mutate(s => { s.closed = $('wallClosed').checked; syncOpenings(s); });
$('doorName').onchange = () => mutateOpening('door', d => d.name = $('doorName').value || '门');
$('doorT').onchange = () => mutateOpening('door', d => d.t = clamp(+$('doorT').value || 0, 0, 1));
$('doorWidth').onchange = () => mutateOpening('door', d => d.width = clamp(+$('doorWidth').value || 1, .1, 50));
$('doorHeight').onchange = () => mutateOpening('door', d => d.height = clamp(+$('doorHeight').value || 2.1, .1, 50));
$('doorFlip').onchange = () => mutateOpening('door', d => d.flip = $('doorFlip').value === '-1' ? -1 : 1);
$('doorOpen').onchange = () => mutateOpening('door', d => d.open = $('doorOpen').value === 'open');
$('doorColor').onchange = () => mutateOpening('door', d => d.color = $('doorColor').value);
$('windowName').onchange = () => mutateOpening('window', w => w.name = $('windowName').value || '窗');
$('windowT').onchange = () => mutateOpening('window', w => w.t = clamp(+$('windowT').value || 0, 0, 1));
$('windowWidth').onchange = () => mutateOpening('window', w => w.width = clamp(+$('windowWidth').value || 1, .1, 50));
$('windowHeight').onchange = () => mutateOpening('window', w => w.height = clamp(+$('windowHeight').value || 1.4, .1, 50));
$('windowSill').onchange = () => mutateOpening('window', w => w.sill = clamp(+$('windowSill').value || 0, 0, 50));
$('windowColor').onchange = () => mutateOpening('window', w => w.color = $('windowColor').value);
for (const [kind, btn, key] of [['door', 'deleteDoor', 'doors'], ['window', 'deleteWindow', 'windows']]) {
  $(btn).onclick = () => {
    const s = shape(); const id = kind === 'window' ? selectedWindow : selectedDoor;
    if (!s || !id) return;
    checkpoint();
    s[key] = (s[key] || []).filter(o => o.id !== id);
    if (kind === 'window') selectedWindow = null; else selectedDoor = null;
    refresh();
  };
}
$('deleteShape').onclick = remove;
for (const color of PALETTE) {
  const n = document.createElement('button');
  n.style.background = color; n.title = color; n.setAttribute('aria-label', '颜色 ' + color);
  n.onclick = () => mutate(s => s.color = color);
  $('swatches').appendChild(n);
}

function undo(redo = false) {
  const from = redo ? future : history, to = redo ? history : future;
  if (!from.length) return;
  to.push(clone(state)); state = from.pop();
  selected = null; clearOpening(); activeLayer = null; wallDraft = null;
  if (!state.floors.includes(floor)) floor = state.floors[0];
  $('projectName').value = state.name;
  syncSettings(); panels(); properties(); render();
}
$('undo').onclick = () => undo();
$('redo').onclick = () => undo(true);
$('projectName').onchange = () => { checkpoint(); state.name = $('projectName').value || '未命名关卡'; };

function onKeyDown(e) {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable || e.isComposing) return;
  const key = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (drag) return;
    if (key === 'c') { const s = shape(); if (s) { objectClipboard = { shape: clone(s), layer: clone(layer(s)) }; pasteCount = 0; toast('体块已复制，按 Ctrl+V 粘贴到当前楼层'); e.preventDefault(); } return; }
    if (key === 'v') { if (pasteClipboard()) e.preventDefault(); return; }
    if (key === 'z') { e.preventDefault(); undo(e.shiftKey); return; }
    return;
  }
  if (e.code === 'Space') { space = true; e.preventDefault(); }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (drag) return; e.preventDefault(); remove(); }
  if (e.key === 'Escape') { if (wallDraft) { finishWall(true); setTool('select'); return; } selected = null; clearOpening(); setTool('select'); properties(); render(); return; }
  if (e.key === 'Enter') { if (wallDraft) { finishWall(); return; } }
  if (key === 'g') { setSnapMode(state.snapMode === 'free' ? 'grid' : 'free'); toast(state.snapMode === 'free' ? '自由拖动：不按格子' : '网格吸附'); return; }
  const t = { v: 'select', r: 'rect', c: 'circle', a: 'arrow', s: 'stairs', w: 'wall', d: 'door', n: 'window', e: 'vertex', h: 'pan' }[key];
  if (t && !e.altKey && !drag) setTool(t);
}
window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', e => { if (e.code === 'Space') space = false; });
window.addEventListener('blur', () => { space = false; drag = null; });

/* ---------- 导入导出 ---------- */
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify({ format: 'level-studio', version: 3, ...state }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = (state.name || '关卡') + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('关卡已导出，包含图形、墙体、门与楼层信息');
};
$('import').onclick = () => $('file').click();
$('file').onchange = async () => {
  const file = $('file').files[0]; if (!file) return;
  try {
    if (file.size > 8e6) throw Error('too large');
    const next = normalizeLevel(JSON.parse(await file.text()));
    checkpoint();
    state = next; selected = null; clearOpening(); activeLayer = null; wallDraft = null;
    floor = state.floors[0];
    $('projectName').value = state.name;
    syncSettings(); refresh(); $('fit').click();
    toast('关卡已导入');
  } catch {
    toast('无法导入：请选择有效的关卡 JSON 文件');
  } finally { $('file').value = ''; }
};
function normalizeLevel(data) {
  if (!data || data.format !== 'level-studio' || ![1, 2, 3].includes(data.version)) throw Error('版本不支持');
  if (!Array.isArray(data.layers) || !Array.isArray(data.shapes)) throw Error('缺少图层');
  let floors = Array.isArray(data.floors) && data.floors.length ? [...new Set(data.floors.filter(f => Number.isInteger(f) && f >= 1))] : [...new Set(data.layers.map(l => l.floor).filter(f => Number.isInteger(f)))];
  if (!floors.length) floors = [1];
  floors.sort((a, b) => a - b);
  if (floors.length > MAX_FLOORS) throw Error('楼层过多');
  const layers = [], shapes = [];
  for (const l of data.layers) {
    if (!l || typeof l.id !== 'string' || !floors.includes(l.floor)) continue;
    layers.push({ id: l.id, name: String(l.name || '体块'), floor: l.floor, visible: l.visible !== false, locked: !!l.locked });
  }
  const ids = new Set();
  for (const s of data.shapes) {
    if (!s || !['rect', 'circle', 'arrow', 'stairs', 'wall'].includes(s.type)) continue;
    if (!Array.isArray(s.points) || s.points.length < 2 || s.points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) continue;
    if (!layers.some(l => l.id === s.layer)) continue;
    const copy = {
      id: ids.has(s.id) ? uid('s') : String(s.id), type: s.type, layer: s.layer,
      name: String(s.name || '体块'), color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : PALETTE[0],
      points: s.points.map(p => ({ x: p.x, y: p.y })), rotation: Number.isFinite(s.rotation) ? s.rotation : 0
    };
    if (s.type === 'stairs') Object.assign(copy, { stairSteps: clamp(Math.round(+s.stairSteps) || 12, 2, 64), stairFloors: clamp(Math.round(+s.stairFloors) || 1, 1, 100), stairReverse: !!s.stairReverse });
    if (s.type === 'wall') {
      copy.thickness = clamp(+s.thickness || .24, .02, 10);
      copy.height = clamp(+s.height || 3, .1, 100);
      copy.closed = !!s.closed;
      copy.doors = (Array.isArray(s.doors) ? s.doors : []).slice(0, 200).map(d => ({
        id: uid('d'), seg: Math.max(0, Math.round(+d.seg) || 0), t: clamp(+d.t || 0, 0, 1),
        width: clamp(+d.width || 1, .1, 50), height: clamp(+d.height || 2.1, .1, 50), sill: 0,
        flip: d.flip === -1 ? -1 : 1, open: !!d.open,
        color: /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : DOOR_COLOR, name: String(d.name || '门')
      }));
      copy.windows = (Array.isArray(s.windows) ? s.windows : []).slice(0, 200).map(w => ({
        id: uid('w'), seg: Math.max(0, Math.round(+w.seg) || 0), t: clamp(+w.t || 0, 0, 1),
        width: clamp(+w.width || 1.4, .1, 50), height: clamp(+w.height || 1.4, .1, 50),
        sill: clamp(+w.sill || 0, 0, 50),
        color: /^#[0-9a-f]{6}$/i.test(w.color) ? w.color : WINDOW_COLOR, name: String(w.name || '窗')
      }));
    }
    ids.add(copy.id); shapes.push(copy);
  }
  const floorHeights = {};
  for (const f of floors) floorHeights[f] = Number.isFinite(data.floorHeights?.[f]) ? data.floorHeights[f] : (f - 1) * (data.gap || 4);
  return {
    name: String(data.name || '导入的关卡'), floors, floorHeights,
    hiddenFloors: (Array.isArray(data.hiddenFloors) ? data.hiddenFloors : []).filter(f => floors.includes(f)),
    layers, shapes,
    gap: clamp(+data.gap || 4, .5, 30), wallHeight: clamp(+data.wallHeight || 3, .1, 100),
    snapMode: data.snapMode === 'free' ? 'free' : 'grid', snapStep: [1, .5, .25].includes(+data.snapStep) ? +data.snapStep : 1,
    opacity: {
      wall: Number.isFinite(data.opacity?.wall) ? clamp(+data.opacity.wall, 0, 1) : .9,
      door: Number.isFinite(data.opacity?.door) ? clamp(+data.opacity.door, 0, 1) : .85,
      window: Number.isFinite(data.opacity?.window) ? clamp(+data.opacity.window, 0, 1) : .35,
      slab: Number.isFinite(data.opacity?.slab) ? clamp(+data.opacity.slab, 0, 1) : .5
    }
  };
}
function syncSettings() {
  $('projectName').value = state.name;
  $('gapInput').value = state.gap;
  $('wallHeightInput').value = state.wallHeight;
  $('snapStep').value = String(state.snapStep || 1);
  const op = state.opacity || (state.opacity = defaultState().opacity);
  for (const [key, id] of [['wall', 'wallOpacity'], ['door', 'doorOpacity'], ['window', 'windowOpacity'], ['slab', 'slabOpacity']]) {
    $(id).value = Math.round(op[key] * 100);
    $(id + 'Value').textContent = Math.round(op[key] * 100) + '%';
  }
  setSnapMode(state.snapMode);
}

/* ---------- 启动 ---------- */
new ResizeObserver(() => render()).observe(svg);
syncSettings();
panels();
properties();
render();
