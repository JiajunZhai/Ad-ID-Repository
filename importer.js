// importer.js — XLSX 导入解析与合并（纯函数，零依赖，Node/浏览器通用）
export const RATIO = { L: 1.15, H: 1.35, M: 1.8 };
const TIERS = ['L', 'H', 'M'];
const TYPE_NAMES = { rewarded: '激励视频', interstitial: '插屏', banner: '横幅', appopen: '开屏', native: '原生' };
export function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

const FIELDS = [
  ['app', '应用', 'A'], ['platform', '聚合平台', 'B'], ['code', '广告位', 'C'], ['group', '价值分组', 'D'], ['ecpm', '参考eCPM', 'E'],
  ['L_name', 'L组广告单元名称', 'F'], ['L_id', 'L组广告ID', 'G'], ['L_floor', 'L组底价', 'H'], ['L_meta', 'L组Meta广告ID', 'I'],
  ['H_name', 'H组广告单元名称', 'J'], ['H_id', 'H组广告ID', 'K'], ['H_floor', 'H组底价', 'L'], ['H_meta', 'H组Meta广告ID', 'M'],
  ['M_name', 'M组广告名称', 'N'], ['M_id', 'M组广告ID', 'O'], ['M_floor', 'M组底价', 'P'], ['M_meta', 'M组Meta广告ID', 'Q']
];
const TIER_DEFS = { L: { name: 'L_name', id: 'L_id', floor: 'L_floor', meta: 'L_meta' }, H: { name: 'H_name', id: 'H_id', floor: 'H_floor', meta: 'H_meta' }, M: { name: 'M_name', id: 'M_id', floor: 'M_floor', meta: 'M_meta' } };

export function inferType(code) {
  const c = String(code || '').toLowerCase();
  let key = null;
  if (/inter/.test(c)) key = 'interstitial';
  else if (/reward/.test(c)) key = 'rewarded';
  else if (/banner/.test(c)) key = 'banner';
  else if (/splash/.test(c)) key = 'appopen';
  else if (/open/.test(c)) key = 'appopen';
  else if (/native/.test(c)) key = 'native';
  else if (/(?:^|[-_.])int(?:$|[-_.])/.test(c)) key = 'interstitial';
  return key ? { key, name: TYPE_NAMES[key] } : null;
}
export function makeAdName(appName, platform, code, group, tier, floor) {
  // 流量分组作为完整名称保留内部空格，仅在字段之间添加下划线。
  return [appName, platform, code, group, tier, floor]
    .map((x, i) => i === 3 ? String(x ?? '').trim() : String(x).trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\u4e00-\u9fff.-]/g, ''))
    .filter(Boolean).join('_');
}

// ---------------- ZIP ----------------
const u16 = (dv, o) => dv.getUint16(o, true), u32 = (dv, o) => dv.getUint32(o, true);
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function zipEntries(buf) {
  const dv = new DataView(buf), out = {}; let off = 0, guard = 0;
  while (off + 30 <= dv.byteLength && guard++ < 2000) {
    if (u32(dv, off) !== 0x04034b50) break;
    const method = u16(dv, off + 8), csize = u32(dv, off + 18), nameLen = u16(dv, off + 26), extraLen = u16(dv, off + 28);
    const name = new TextDecoder().decode(new Uint8Array(buf, off + 30, nameLen));
    const data = new Uint8Array(buf, off + 30 + nameLen + extraLen, csize);
    out[name] = method === 0 ? data : method === 8 ? await inflateRaw(data) : null;
    off += 30 + nameLen + extraLen + (out[name] ? csize : 0);
  }
  if (Object.keys(out).length < 2) throw new Error('不是有效的 XLSX/ZIP 文件');
  return out;
}

// ---------------- XML ----------------
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function tags(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g'); const out = []; let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function sharedStrings(xml) { return tags(xml, 'si').map(si => tags(si, 't').map(unesc).join('')); }
function sheetRows(xml, strings) {
  const rows = [];
  for (const rowXml of tags(xml, 'row')) {
    const cols = {}; const re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let m;
    while ((m = re.exec(rowXml))) {
      const attrs = m[1], inner = m[2] ?? '', rm = /r="([A-Z]+)(\d+)"/.exec(attrs);
      if (!rm) continue;
      const col = rm[1], t = /t="([^"]+)"/.exec(attrs)?.[1], v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      cols[col] = t === 's' ? (strings[+v] ?? '') : t === 'inlineStr' ? tags(inner, 't').map(unesc).join('') : v != null ? unesc(v) : '';
    }
    rows.push(cols);
  }
  return rows;
}

export async function parseXlsx(buf) {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前环境不支持 XLSX 解析（需 DecompressionStream）');
  const z = await zipEntries(buf);
  const strings = z['xl/sharedStrings.xml'] ? sharedStrings(new TextDecoder().decode(z['xl/sharedStrings.xml'])) : [];
  const sheetFile = Object.keys(z).find(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)) || 'xl/worksheets/sheet1.xml';
  if (!z[sheetFile]) throw new Error(`缺少工作表 ${sheetFile}`);
  const rows = sheetRows(new TextDecoder().decode(z[sheetFile]), strings);
  if (!rows.length) throw new Error('工作表为空');
  return { rows };
}

// ---------------- 模型构建 ----------------
function resolveLetters(header) {
  const map = {};
  for (const [key, label, def] of FIELDS) {
    const l = label.toLowerCase().replace(/[\s_]/g, ''); let hit = null;
    for (const [c, v] of Object.entries(header)) {
      if (String(v || '').toLowerCase().replace(/[\s_]/g, '') === l) { hit = c; break; }
    }
    map[key] = hit || def;
  }
  return map;
}
const num = v => { if (v == null || String(v).trim() === '') return null; const n = parseFloat(String(v).replace(/[¥$,\s]/g, '')); return isNaN(n) ? null : n; };

export function buildImportModel(rows, typeMap = {}) {
  const L = resolveLetters(rows[0]), cell = (r, k) => String(r[L[k]] ?? '').trim(), entries = [];
  const link = (appName, code) => entries.find(e => e.app === appName && e.code === code);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], appName = cell(r, 'app'), code = cell(r, 'code'), group = cell(r, 'group'), pf = cell(r, 'platform'), pTokens = pf.split(/[,，、/;；]+/).map(t => t.trim()).filter(Boolean), platform = pTokens[0] ?? pf, eCPM = num(cell(r, 'ecpm'));
    if (!appName || !code || !group) { continue; }
    if (eCPM == null) { continue; }
    const oKey = `${appName}|${code}`, overrideT = typeMap[oKey], type = inferType(code) ?? (overrideT ? { key: overrideT, name: TYPE_NAMES[overrideT] } : null);
    let e = link(appName, code);
    if (!e) { e = { app: appName, code, platform, platformOptions: pTokens.length > 1 ? pTokens : null, type, typeKey: type?.key, typeName: type?.name, unknown: !type, segments: [] }; entries.push(e); }
    else if (e.platform !== platform) e.platform = platform;
    let s = e.segments.find(x => x.name === group && Math.abs((x.eCPM || 0) - eCPM) <= 0.001);
    const sNew = !s;
    if (sNew) s = { name: group, eCPM, tiers: {} };
    for (const t of TIERS) {
      const d = TIER_DEFS[t], name = cell(r, d.name), id = cell(r, d.id), meta = cell(r, d.meta), floor = num(cell(r, d.floor));
      if (!name && !id && !meta && floor == null) continue;
      const expected = round2(eCPM * RATIO[t]), floorOk = floor != null && Math.abs(expected - floor) < 1;
      s.tiers[t] = { name, id, meta, floor, expected, floorOk };
    }
    if (!Object.keys(s.tiers).length) continue;
    if (!e.unknown && sNew) e.segments.push(s);
  }
  const mismatches = [], nameMismatches = [], unknown = [];
  for (const e of entries) {
    if (e.unknown) { unknown.push(e); continue; }
    for (const s of e.segments) for (const t of TIERS) {
      const tr = s.tiers[t]; if (!tr) continue;
      if (tr.floor != null && !tr.floorOk) mismatches.push({ app: e.app, code: e.code, group: s.name, tier: t, sheet: tr.floor, expected: tr.expected, diff: Math.round((tr.floor - tr.expected) * 100) / 100, pct: tr.expected ? Math.round((tr.floor - tr.expected) / tr.expected * 1000) / 10 : 0 });
      if (tr.name) {
        const expect = makeAdName(e.app, e.platform, e.code, s.name, t, tr.expected);
        if (expect !== tr.name) nameMismatches.push({ app: e.app, code: e.code, group: s.name, tier: t, sheet: tr.name, expected: expect });
      }
    }
  }
  return { entries, mismatches, nameMismatches, unknown };
}

// ---------------- 合并（按组更新） ----------------
let _n = Date.now(); const gid = p => `${p}-${++_n}`;
export function applyImport(warehouse, model, platformMap = {}) {
  const touched = [];
  const report = { created: { apps: [], placements: [], segments: [], ids: [] }, unknown: [], eCPMChanged: [], mismatches: model.mismatches };
  for (const e of model.entries) {
    if (e.unknown) { report.unknown.push(e); continue; }
    const platform = platformMap[`${e.app}|${e.code}`] || e.platform;
    let a = warehouse.find(x => x.name === e.app);
    if (!a) { a = { id: gid('app'), name: e.app, formats: [] }; warehouse.push(a); report.created.apps.push(e.app); }
    let f = a.formats.find(x => x.key === e.typeKey);
    if (!f) { f = { id: gid('format'), name: e.typeName, key: e.typeKey, placements: [] }; a.formats.push(f); }
    let p = f.placements.find(x => x.code === e.code);
    if (!p) { p = { id: gid('placement'), code: e.code, mediation: platform, segments: [] }; f.placements.push(p); report.created.placements.push(`${e.app}/${e.code}`); }
    else if (p.mediation !== platform) p.mediation = platform;
    for (const seg of e.segments) {
      let s = p.segments.find(x => x.name === seg.name && Math.abs((x.eCPM || 0) - seg.eCPM) <= 0.001);
      if (!s) { s = { id: gid('segment'), name: seg.name, priority: Math.max(0, ...p.segments.map(x => +x.priority)) + 1, eCPM: seg.eCPM, idConfigs: [] }; p.segments.push(s); report.created.segments.push(`${e.app}/${e.code}/${seg.name}`); }
      for (const t of TIERS) {
        const tr = seg.tiers[t]; if (!tr) continue;
        let c = s.idConfigs.find(x => x.groupTag === t);
        if (!c) { c = { id: gid('id'), network: platform, groupTag: t, placementId: '', metaSourceId: '', discountRatio: 1, isLocked: true }; s.idConfigs.push(c); report.created.ids.push(`${seg.name}/${t}`); }
        else if (c.network !== platform) c.network = platform;
        c.placementId = tr.id ?? ''; c.metaSourceId = tr.meta ?? '';
      }
      touched.push({ app: a, placement: p, segment: s });
    }
  }
  return { touched, report };
}
