#!/usr/bin/env node
/**
 * Bounded live verification smoke for verified Xiaoyuzhou xyzfm podcasts
 * (nardinmarcus/rssreader#32). Kept strictly separate from deterministic npm test.
 *
 * Checks per show without activating failed sources or bypassing ACL/paywalls:
 * 1. Direct live HTTP probe of https://feed.xyzfm.space/{slug}
 * 2. Isolated local server activation attempt verifying failed feeds stay inactive
 * 3. Public Xiaoyuzhou show page episode/audio availability (newest & visible earliest)
 *    plus real browser playback check when `agent-browser` is available.
 */
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SHOWS = [
  {
    name: '张小珺商业访谈录（小宇宙）',
    key: 'xiaoyuzhou:626b46ea9cbbf0451cf5a962',
    pid: '626b46ea9cbbf0451cf5a962',
    rssUrl: 'https://feed.xyzfm.space/dk4yh3pkpjp3',
  },
  {
    name: '42章经',
    key: 'xiaoyuzhou:648b0b641c48983391a63f98',
    pid: '648b0b641c48983391a63f98',
    rssUrl: 'https://feed.xyzfm.space/evgg6xle9rdc',
  },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

function hasAgentBrowser() {
  try {
    execFileSync('which', ['agent-browser'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function fetchPublicShowSample(pid) {
  try {
    const html = execFileSync('curl', [
      '-sL',
      '--max-time', '15',
      '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      `https://www.xiaoyuzhoufm.com/podcast/${pid}`,
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const nextDataMatch = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (!nextDataMatch) return { status: 200, episodes: [] };
    const data = JSON.parse(nextDataMatch[1]);
    const podcast = data && data.props && data.props.pageProps && data.props.pageProps.podcast || {};
    const episodes = (Array.isArray(podcast.episodes) ? podcast.episodes : []).map(ep => ({
      eid: ep.eid,
      title: ep.title,
      pubDate: ep.pubDate,
      hasShownotes: Boolean(String(ep.shownotes || ep.description || '').trim()),
      enclosureUrl: (ep.enclosure && ep.enclosure.url) || (ep.media && ep.media.source && ep.media.source.url) || '',
      episodeUrl: `https://www.xiaoyuzhoufm.com/episode/${ep.eid}`,
    }));
    return {
      status: 200,
      podcastTitle: podcast.title || '',
      declaredEpisodeCount: Number(podcast.episodeCount) || 0,
      episodes,
    };
  } catch (error) {
    return { status: 'error', error: String(error && error.message || error), episodes: [] };
  }
}

async function browserPlayAudio(audioUrl, baseUrl, session = 'rss32-smoke') {
  const execAb = args => execFileSync('agent-browser', ['--session', session, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  execAb(['open', baseUrl]);
  execAb(['wait', '#source-discovery-open']);
  execAb(['eval', `(() => {
    window.__smokeAudio = { done: false };
    const a = document.createElement('audio');
    a.muted = true;
    a.controls = true;
    a.preload = 'metadata';
    a.src = ${JSON.stringify(audioUrl)};
    a.addEventListener('error', () => {
      window.__smokeAudio = { done: true, ok: false, errorCode: a.error ? a.error.code : 'error' };
    });
    const btn = document.createElement('button');
    btn.id = 'smoke-play-btn';
    btn.type = 'button';
    btn.textContent = 'Play Smoke';
    btn.style.cssText = 'position:fixed;top:12px;left:12px;z-index:99999;padding:8px 16px;';
    btn.onclick = () => {
      a.play().then(() => {
        window.__smokeAudio = {
          done: true,
          ok: !a.paused,
          readyState: a.readyState,
          duration: a.duration,
          currentSrc: a.currentSrc,
        };
      }).catch(err => {
        window.__smokeAudio = { done: true, ok: false, error: String(err && err.message || err) };
      });
    };
    document.body.appendChild(a);
    document.body.appendChild(btn);
  })()`]);
  execAb(['click', '#smoke-play-btn']);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const raw = execAb(['eval', 'window.__smokeAudio?.done ? window.__smokeAudio : null']);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed) return parsed;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return { done: false, ok: false, error: 'playback-timeout' };
}

async function main() {
  const projectDir = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rss32-live-smoke-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      NAMOO_READER_DATA_DIR: dataDir,
      STARTUP_REFRESH_DELAY_MS: '-1',
      FRESHNESS_SWEEP_INTERVAL_MS: '-1',
      SOURCE_CATALOG_REFRESH_INTERVAL_MS: '-1',
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'test-password-123',
      ADMIN_NAME: 'Smoke Admin',
      COOKIE_SECURE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const useBrowser = hasAgentBrowser();

  try {
    const readyDeadline = Date.now() + 10_000;
    while (Date.now() < readyDeadline) {
      try {
        if ((await fetch(`${baseUrl}/api/sources`)).ok) break;
      } catch { /* wait */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123', displayName: 'Smoke Admin' }),
    });
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }),
    });
    const adminCookie = String(loginRes.headers.get('set-cookie') || '').split(';')[0];

    const report = [];
    for (const show of SHOWS) {
      let rssProbe = { status: null, tengineError: '', location: '' };
      try {
        const res = await fetch(show.rssUrl, { method: 'GET', redirect: 'manual' });
        rssProbe = {
          status: res.status,
          tengineError: res.headers.get('x-tengine-error') || '',
          location: res.headers.get('location') || '',
        };
      } catch (error) {
        rssProbe = { status: 'error', error: String(error && error.message || error) };
      }

      const actRes = await fetch(`${baseUrl}/api/admin/source-catalog/${encodeURIComponent(show.key)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: '{}',
      });
      const actBody = await actRes.json().catch(() => ({}));
      const sourcesAfter = await (await fetch(`${baseUrl}/api/sources`, { headers: { Cookie: adminCookie } })).json();
      const slug = show.rssUrl.split('/').pop();
      const activatedInStore = (sourcesAfter.sources || []).some(item => String(item.feedUrl || '').includes(slug));

      const pageSample = fetchPublicShowSample(show.pid);
      const newest = pageSample.episodes[0] || null;
      const oldestVisible = pageSample.episodes[pageSample.episodes.length - 1] || null;
      const checkAudio = async ep => {
        if (!ep || !ep.enclosureUrl) return { ok: false, error: 'missing enclosure' };
        if (useBrowser) return browserPlayAudio(ep.enclosureUrl, baseUrl);
        const head = await fetch(ep.enclosureUrl, { method: 'HEAD' });
        return { ok: head.ok, status: head.status, contentType: head.headers.get('content-type') || '' };
      };

      report.push({
        show: show.name,
        key: show.key,
        rssUrl: show.rssUrl,
        rssProbe,
        serverActivationStatus: actRes.status,
        serverActivationError: actBody.error || '',
        activatedInStore,
        rssPassed: actRes.ok && activatedInStore,
        publicPageDeclaredCount: pageSample.declaredEpisodeCount || 0,
        newestSample: newest ? {
          eid: newest.eid,
          title: newest.title,
          hasShownotes: newest.hasShownotes,
          enclosureUrl: newest.enclosureUrl,
          playback: await checkAudio(newest),
        } : null,
        oldestVisibleSample: oldestVisible ? {
          eid: oldestVisible.eid,
          title: oldestVisible.title,
          hasShownotes: oldestVisible.hasShownotes,
          enclosureUrl: oldestVisible.enclosureUrl,
          playback: await checkAudio(oldestVisible),
        } : null,
      });
    }
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), useBrowser, report }, null, 2));
  } finally {
    if (useBrowser) {
      try { execFileSync('agent-browser', ['--session', 'rss32-smoke', 'close', '--all'], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
