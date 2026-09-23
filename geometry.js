// 几何与模型工具：旋转、楼层高度、楼梯网格、墙体分段、门洞切分。
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function shade(color, k) {
  const hex = String(color || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return color;
  return '#' + hex.match(/../g).map(v => clamp(Math.round(parseInt(v, 16) * k), 0, 255).toString(16).padStart(2, '0')).join('');
}

function snapRotation(value) {
  const n = Number(value);
  return Number.isFinite(n) ? ((Math.round(n / 15) * 15) % 360 + 360) % 360 : 0;
}
function rotationCenter(s) {
  if (s.type === 'circle') {
    const xs = s.points.map(p => p.x), ys = s.points.map(p => p.y);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  }
  return s.points.reduce((c, p) => ({ x: c.x + p.x / s.points.length, y: c.y + p.y / s.points.length }), { x: 0, y: 0 });
}
function rotateShapeTo(s, value) {
  const target = snapRotation(value), angle = (target - (s.rotation || 0)) * Math.PI / 180, c = rotationCenter(s);
  if (s.type !== 'circle') {
    s.points = s.points.map(p => ({
      x: c.x + (p.x - c.x) * Math.cos(angle) - (p.y - c.y) * Math.sin(angle),
      y: c.y + (p.x - c.x) * Math.sin(angle) + (p.y - c.y) * Math.cos(angle)
    }));
  }
  s.rotation = target;
  return target;
}

function floorVisible(level, f) { return !(level.hiddenFloors || []).includes(f); }
function floorHeight(level, f) {
  const heights = level.floorHeights;
  if (heights && Number.isFinite(heights[f])) return heights[f];
  if (!heights || level.floors.includes(f)) return (f - 1) * (level.gap || 4);
  const below = level.floors.filter(n => n < f), anchor = below.length ? Math.max(...below) : Math.min(...level.floors);
  return floorHeight(level, anchor) + (f - anchor) * 4;
}
function stairRise(level, s) {
  const l = level.layers.find(x => x.id === s.layer);
  if (!l) return level.gap || 4;
  return floorHeight(level, l.floor + (s.stairFloors || 1)) - floorHeight(level, l.floor);
}
function layerVisible(level, l) { return !!l && l.visible !== false && floorVisible(level, l.floor); }

function bounds(points) {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
function geometry(s) {
  const b = bounds(s.points);
  if (s.type === 'circle') {
    return Array.from({ length: 64 }, (_, i) => ({
      x: b.x + b.w / 2 + Math.cos(i * Math.PI / 32) * b.w / 2,
      y: b.y + b.h / 2 + Math.sin(i * Math.PI / 32) * b.h / 2
    }));
  }
  return s.points;
}
function previewGridBounds(level) {
  const visible = new Set(level.layers.filter(l => layerVisible(level, l)).map(l => l.id));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of level.shapes) {
    if (!visible.has(s.layer)) continue;
    for (const p of s.points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  }
  if (!Number.isFinite(minX)) return { x: -10, y: -8, w: 20, h: 16 };
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const w = Math.max(20, maxX - minX + 4), h = Math.max(16, maxY - minY + 4);
  const x = Math.floor(cx - w / 2), y = Math.floor(cy - h / 2);
  return { x, y, w: Math.ceil(cx + w / 2) - x, h: Math.ceil(cy + h / 2) - y };
}

/* ---------------- 楼梯 ---------------- */
function stairPoint(s, u, v, z = 0) {
  const [a, b, , d] = s.points; const t = s.stairReverse ? 1 - v : v;
  return { x: a.x + (b.x - a.x) * u + (d.x - a.x) * t, y: a.y + (b.y - a.y) * u + (d.y - a.y) * t, z };
}
function stairDimensions(s) {
  const [a, b, , d] = s.points;
  return { w: Math.hypot(b.x - a.x, b.y - a.y), h: Math.hypot(d.x - a.x, d.y - a.y) };
}
function stairRectangle(a, ux, uy, w, h) {
  return [{ ...a }, { x: a.x + ux.x * w, y: a.y + ux.y * w }, { x: a.x + ux.x * w + uy.x * h, y: a.y + ux.y * w + uy.y * h }, { x: a.x + uy.x * h, y: a.y + uy.y * h }];
}
function stairAxes(s) {
  const [a, b, , d] = s.points, dim = stairDimensions(s);
  return {
    ux: { x: (b.x - a.x) / Math.max(.001, dim.w), y: (b.y - a.y) / Math.max(.001, dim.w) },
    uy: { x: (d.x - a.x) / Math.max(.001, dim.h), y: (d.y - a.y) / Math.max(.001, dim.h) }
  };
}
function resizeStair(s, start, q, index) {
  const { ux, uy } = stairAxes(start), op = start.points[(index + 2) % 4];
  const dx = q.x - op.x, dy = q.y - op.y, sx = index === 0 || index === 3 ? -1 : 1, sy = index < 2 ? -1 : 1;
  const w = Math.max(.1, (dx * ux.x + dy * ux.y) * sx), h = Math.max(.1, (dx * uy.x + dy * uy.y) * sy);
  const a = { x: op.x - (sx < 0 ? ux.x * w : 0) - (sy < 0 ? uy.x * h : 0), y: op.y - (sx < 0 ? ux.y * w : 0) - (sy < 0 ? uy.y * h : 0) };
  s.points = stairRectangle(a, ux, uy, w, h);
}
function sizeStair(s, axis, value) {
  const { ux, uy } = stairAxes(s), d = stairDimensions(s);
  s.points = stairRectangle(s.points[0], ux, uy, axis === 'Width' ? value : d.w, axis === 'Height' ? value : d.h);
}
function stairMesh(s, gap, riseOverride) {
  const count = s.stairSteps || 12, rise = Number.isFinite(riseOverride) ? riseOverride : (s.stairFloors || 1) * gap, faces = [];
  const add = (points, k, kind) => faces.push({ points, shade: k, kind });
  for (let i = 0; i < count; i++) {
    const v = i / count, w = (i + 1) / count, z = (i + 1) * rise / count, low = i * rise / count;
    add([stairPoint(s, 0, v, z), stairPoint(s, 1, v, z), stairPoint(s, 1, w, z), stairPoint(s, 0, w, z)], 1, 'tread');
    add([stairPoint(s, 0, v, low), stairPoint(s, 1, v, low), stairPoint(s, 1, v, z), stairPoint(s, 0, v, z)], .67, 'riser');
  }
  return faces;
}

/* ---------------- 墙体 ---------------- */
// 墙是一条折线；closed 时首尾相连。返回 [{a,b,index}]
function wallSegments(wall) {
  const pts = wall.points || [], segs = [];
  const n = wall.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) segs.push({ a: pts[i], b: pts[(i + 1) % pts.length], index: i });
  return segs.filter(s => dist(s.a, s.b) > 1e-6).map((s, i) => ({ ...s, index: i }));
}
function wallLength(wall) {
  return wallSegments(wall).reduce((sum, s) => sum + dist(s.a, s.b), 0);
}
// 一段墙上的所有开口（门 + 窗）：{kind,ref,s0,s1,z0,z1}
// 门从地面开始（sill=0），窗有窗台高 sill，二者都保留上方过梁。
function wallOpenings(wall, segIndex) {
  const segs = wallSegments(wall), seg = segs[segIndex];
  if (!seg) return [];
  const len = dist(seg.a, seg.b), H = wall.height || 3, items = [];
  const push = (kind, ref) => {
    const w = clamp(ref.width || 1, .02, len);
    const c = clamp(ref.t, 0, 1) * len;
    const z0 = clamp(ref.sill || 0, 0, H);
    items.push({
      kind, ref,
      s0: clamp(c - w / 2, 0, len), s1: clamp(c + w / 2, 0, len),
      z0, z1: clamp(z0 + (ref.height || 1), 0, H)
    });
  };
  for (const d of (wall.doors || [])) if (d.seg === segIndex) push('door', d);
  for (const w of (wall.windows || [])) if (w.seg === segIndex) push('window', w);
  return items.sort((a, b) => a.s0 - b.s0);
}
// 2D 平面图上的连续实体段（开口处断开）
function wallPlanSpans(wall, segIndex) {
  const segs = wallSegments(wall), seg = segs[segIndex];
  if (!seg) return [];
  const len = dist(seg.a, seg.b), spans = [];
  let cur = 0;
  for (const o of wallOpenings(wall, segIndex)) {
    if (o.s0 - cur > 1e-4) spans.push({ t0: cur, t1: o.s0 });
    cur = Math.max(cur, o.s1);
  }
  if (len - cur > 1e-4) spans.push({ t0: cur, t1: len });
  return spans;
}
// 3D：把一段墙按开口切成竖直体块 {t0,t1,h0,h1}（h 相对本层地面）
function wallSpans(wall, segIndex) {
  const segs = wallSegments(wall), seg = segs[segIndex];
  if (!seg) return [];
  const len = dist(seg.a, seg.b), H = wall.height || 3, spans = [];
  let cur = 0;
  for (const o of wallOpenings(wall, segIndex)) {
    if (o.s0 - cur > 1e-4) spans.push({ t0: cur, t1: o.s0, h0: 0, h1: H });          // 开口左侧墙垛
    if (o.z0 > 1e-4) spans.push({ t0: o.s0, t1: o.s1, h0: 0, h1: o.z0 });            // 窗台以下
    if (H - o.z1 > 1e-4) spans.push({ t0: o.s0, t1: o.s1, h0: o.z1, h1: H });        // 开口上方过梁
    cur = Math.max(cur, o.s1);
  }
  if (len - cur > 1e-4) spans.push({ t0: cur, t1: len, h0: 0, h1: H });
  return spans.filter(s => s.t1 - s.t0 > 1e-4 && s.h1 - s.h0 > 1e-4);
}
// 开口的平面锚点（世界坐标）
function openingAnchor(wall, item) {
  const segs = wallSegments(wall), seg = segs[item.seg] || segs[0];
  if (!seg) return null;
  const len = dist(seg.a, seg.b) || .001;
  const dir = { x: (seg.b.x - seg.a.x) / len, y: (seg.b.y - seg.a.y) / len };
  const nrm = { x: -dir.y, y: dir.x };
  const w = clamp(item.width || 1, .02, len);
  const c = clamp(item.t, 0, 1) * len;
  const s0 = clamp(c - w / 2, 0, len), s1 = clamp(c + w / 2, 0, len);
  const at = t => ({ x: seg.a.x + dir.x * t, y: seg.a.y + dir.y * t });
  const flip = item.flip === -1 ? -1 : 1;
  const hinge = at(s0), jamb = at(s1);
  return {
    seg, dir, nrm, len, width: w, hinge, jamb,
    center: at((s0 + s1) / 2),
    tip: { x: hinge.x + nrm.x * flip * w, y: hinge.y + nrm.y * flip * w },
    s0, s1
  };
}
function doorAnchor(wall, door) { return openingAnchor(wall, door); }
// 世界点投影到某面墙最近的段，用于放门 / 拖门
function nearestOnWall(wall, p) {
  let best = null;
  for (const seg of wallSegments(wall)) {
    const len = dist(seg.a, seg.b) || .001;
    const dx = (seg.b.x - seg.a.x) / len, dy = (seg.b.y - seg.a.y) / len;
    const t = clamp(((p.x - seg.a.x) * dx + (p.y - seg.a.y) * dy) / len, 0, 1);
    const q = { x: seg.a.x + dx * len * t, y: seg.a.y + dy * len * t };
    const d = dist(p, q);
    if (!best || d < best.d) best = { d, seg: seg.index, t, len, point: q };
  }
  return best;
}
function openingCounts(state) {
  let doors = 0, windows = 0;
  for (const s of state.shapes) if (s.type === 'wall') { doors += (s.doors || []).length; windows += (s.windows || []).length; }
  return { doors, windows };
}
if (typeof module !== 'undefined') module.exports = { clamp, dist, shade, snapRotation, rotationCenter, rotateShapeTo, floorVisible, floorHeight, stairRise, layerVisible, bounds, geometry, previewGridBounds, stairPoint, stairDimensions, resizeStair, sizeStair, stairMesh, wallSegments, wallLength, wallOpenings, wallPlanSpans, wallSpans, openingAnchor, doorAnchor, nearestOnWall, openingCounts };
