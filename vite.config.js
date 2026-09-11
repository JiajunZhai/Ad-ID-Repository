import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import gplay from 'google-play-scraper';

const rootDir = process.cwd();
const dataDir = path.resolve(rootDir, 'data');
const iconsDir = path.resolve(rootDir, 'icons');
const META_FILE = path.join(dataDir, 'play-meta.json');

const readMeta = () => {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf-8')); } catch { return {}; }
};
const writeMeta = (m) => fs.writeFileSync(META_FILE, JSON.stringify(m, null, 2), 'utf-8');
const safePkg = (p) => {
  const s = String(p || '').trim();
  const m = s.match(/[?&]id=([a-zA-Z0-9._-]+)/);
  const cand = (m ? m[1] : s.replace(/[^a-zA-Z0-9._-]/g, '')).toLowerCase();
  return /^[a-zA-Z][a-zA-Z0-9._-]*\.[a-zA-Z0-9._-]+$/.test(cand) && !/https|storeapps|playgoogle|play\.google/i.test(cand) ? cand : '';
};
const imageExt = (b) => {
  const d = new Uint8Array(b);
  if (d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) return 'png';
  if (d[0] === 0xff && d[1] === 0xd8) return 'jpg';
  if (d[0] === 0x52 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x46) return 'webp';
  return 'png';
};

async function downloadIcon(pkg, url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw Error(`icon http ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = imageExt(buf);
  const file = `${pkg}.${ext}`;
  fs.writeFileSync(path.join(iconsDir, file), buf);
  return file;
}

async function playLookup(pkg, refresh) {
  const meta = readMeta();
  const hit = meta[pkg];
  if (hit && !refresh) {
    return { pkg, found: !!hit.found, title: hit.title ?? null, dev: hit.dev ?? null, genre: hit.genre ?? null, icon: hit.icon ?? null, state: hit.state ?? 'err', cached: true };
  }
  try {
    const d = await gplay.app({ appId: pkg, lang: 'en', country: 'us' });
    let icon = null, state = 'err';
    if (d.icon) {
      try {
        const base = String(d.icon).split('=')[0];
        icon = await downloadIcon(pkg, `${base}=w512-h512-rw`);
        state = 'ok';
      } catch (err) {
        console.error(`[play] 图标下载失败 ${pkg}:`, err.message);
        state = 'err';
      }
    }
    const entry = { pkg, found: true, title: d.title || null, dev: d.developer || null, genre: d.genre || null, icon, state, at: Date.now() };
    meta[pkg] = entry;
    writeMeta(meta);
    return { ...entry, cached: false };
  } catch (err) {
    const msg = String((err && (err.message || err)) || '');
    const notFound = /404|not.?found|not in|does not/i.test(msg);
    const entry = { pkg, found: false, title: null, dev: null, genre: null, icon: null, state: 'err', msg: notFound ? null : msg, at: Date.now() };
    if (notFound) {
      meta[pkg] = entry;
      writeMeta(meta);
    } else {
      console.error(`[play] 抓取失败 ${pkg}（瞬态，不缓存）:`, msg);
    }
    return { ...entry, cached: false };
  }
}

export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  server: {
    port: 3333,
    open: true
  },
  plugins: [
    {
      name: 'ad-id-local-storage-plugin',
      configureServer(server) {
        // data 与 icons 缓存目录
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

        const parseJsonBody = (req) =>
          new Promise((resolve) => {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
              try {
                resolve(JSON.parse(body || '{}'));
              } catch {
                resolve({});
              }
            });
          });

        server.middlewares.use(async (req, res, next) => {
          const u = new URL(req.url || '/', 'http://localhost');

          // 1. 获取所有应用数据列表
          if (u.pathname === '/api/apps' && req.method === 'GET') {
            try {
              const files = fs.readdirSync(dataDir).filter((file) => file.endsWith('.json') && file !== 'play-meta.json');
              const apps = [];
              for (const file of files) {
                const content = fs.readFileSync(path.join(dataDir, file), 'utf-8');
                try {
                  apps.push(JSON.parse(content));
                } catch (err) {
                  console.error(`解析 ${file} 失败:`, err);
                  fs.renameSync(path.join(dataDir, file), path.join(dataDir, `${file}.broken`));
                }
              }
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, data: apps }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ success: false, message: err.message }));
            }
            return;
          }

          // 2. 保存/更新单个应用数据为 [应用名].json
          if (u.pathname === '/api/apps/save' && req.method === 'POST') {
            try {
              const { app, oldName } = await parseJsonBody(req);
              if (!app || !app.name) {
                res.statusCode = 400;
                res.end(JSON.stringify({ success: false, message: '应用数据或名称不能为空' }));
                return;
              }

              if (oldName && oldName !== app.name) {
                const oldFile = path.join(dataDir, `${oldName}.json`);
                if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
              }

              const targetFile = path.join(dataDir, `${app.name}.json`);
              fs.writeFileSync(targetFile, JSON.stringify(app, null, 2), 'utf-8');

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, message: '保存成功' }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ success: false, message: err.message }));
            }
            return;
          }

          // 3. 删除应用对应的 JSON 文件
          if (u.pathname === '/api/apps/delete' && req.method === 'POST') {
            try {
              const { name } = await parseJsonBody(req);
              const targetFile = path.join(dataDir, `${name}.json`);
              if (fs.existsSync(targetFile)) {
                fs.unlinkSync(targetFile);
              }
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, message: '删除成功' }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ success: false, message: err.message }));
            }
            return;
          }

          // 4. Google Play 包名抓取（缓存到 data/play-meta.json + icons/）
          if (u.pathname === '/api/play/lookup' && req.method === 'GET') {
            const pkg = safePkg(u.searchParams.get('pkg') || '');
            const refresh = u.searchParams.get('refresh') === '1';
            if (!pkg) {
              res.statusCode = 400;
              res.end(JSON.stringify({ success: false, message: '缺少 pkg 参数' }));
              return;
            }
            try {
              const r = await playLookup(pkg, refresh);
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Cache-Control', 'no-store');
              res.end(JSON.stringify({ success: true, data: r }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ success: false, message: err.message }));
            }
            return;
          }

          // 5. 本地图标静态服务（icons/<包名>.<ext>，长缓存不重复抓取）
          if (u.pathname.startsWith('/icons/')) {
            const fname = path.basename(u.pathname);
            const fp = path.join(iconsDir, fname);
            if (!fs.existsSync(fp)) {
              res.statusCode = 404;
              res.end('not found');
              return;
            }
            const ext = path.extname(fname).slice(1);
            const ct = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg' }[ext] || 'application/octet-stream';
            res.setHeader('Content-Type', ct);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            fs.createReadStream(fp).pipe(res);
            return;
          }

          next();
        });
      }
    }
  ]
}));