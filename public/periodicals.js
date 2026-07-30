(function exposePeriodicals(root, factory) {
  const periodicals = factory();
  if (typeof module === 'object' && module.exports) module.exports = periodicals;
  if (root) {
    root.NamooPeriodicals = periodicals;
    periodicals.mountPeriodicals(root);
  }
}(typeof window === 'undefined' ? null : window, () => {
  const CADENCES = new Set(['daily', 'weekly', 'monthly']);
  const CADENCE_LABELS = { daily: '日报', weekly: '周报', monthly: '月报' };
  const EDITORIAL_PRIORITY_LABELS = { high: '高', normal: '普通', low: '低' };
  const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
  const STATUS_LABELS = { open: '更新中', finalizing: '正在定稿', frozen: '已冻结' };

  function evidenceMeta(item) {
    const priority = EDITORIAL_PRIORITY_LABELS[item.editorialPriority] || '普通';
    const timestamp = Number(item.effectivePublishedAt);
    if (!Number.isFinite(timestamp)) return `${priority}优先级`;
    const date = new Date(timestamp + SHANGHAI_OFFSET_MS);
    const day = [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    ].join('-');
    const time = [
      String(date.getUTCHours()).padStart(2, '0'),
      String(date.getUTCMinutes()).padStart(2, '0'),
    ].join(':');
    return `${priority}优先级 · ${day} ${time}`;
  }
  function validPeriodKey(cadence, value) {
    const key = String(value || '');
    if (cadence === 'monthly') return /^\d{4}-(0[1-9]|1[0-2])$/.test(key);
    if (cadence === 'weekly') {
      const weekMatch = key.match(/^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/);
      if (!weekMatch) return false;
      const year = Number(weekMatch[1]);
      const week = Number(weekMatch[2]);
      const januaryFirst = new Date(Date.UTC(year, 0, 1)).getUTCDay();
      const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      return week <= 52 || januaryFirst === 4 || (januaryFirst === 3 && leapYear);
    }
    const match = key.match(/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }

  function parsePeriodicalPath(pathname) {
    const path = String(pathname || '');
    if (/^\/periodicals\/?$/.test(path)) return { cadence: 'daily', periodKey: '' };
    const match = path.match(/^\/periodicals\/([^/]+)\/([^/]+)\/?$/);
    if (!match) return path.startsWith('/periodicals') ? { invalid: true } : null;
    const cadence = String(match[1] || '').toLowerCase();
    const periodKey = String(match[2] || '');
    if (!CADENCES.has(cadence) || !validPeriodKey(cadence, periodKey)) return { invalid: true };
    return { cadence, periodKey };
  }

  function createPeriodicalsController({ request, view }) {
    let requestSequence = 0;

    async function open(pathname) {
      const route = parsePeriodicalPath(pathname);
      if (!route || route.invalid) return false;
      const sequence = ++requestSequence;
      view.enter(route.cadence);

      try {
        const index = await request(`/api/periodicals?cadence=${route.cadence}&limit=30`);
        if (sequence !== requestSequence) return false;
        const issues = Array.isArray(index && index.issues) ? index.issues : [];
        view.renderIndex(route.cadence, issues);
        if (issues.length === 0) {
          view.renderEmpty();
          return true;
        }
        const periodKey = route.periodKey || issues[0].periodKey;
        const detail = await request(`/api/periodicals/${route.cadence}/${periodKey}`);
        if (sequence !== requestSequence) return false;
        view.renderIssue(detail);
        return true;
      } catch (error) {
        if (sequence !== requestSequence) return false;
        view.renderError();
        return true;
      }
    }

    return { open };
  }

  function mountPeriodicals(root) {
    const document = root && root.document;
    if (!document || document.body.dataset.periodicalsMode !== 'on') return false;

    const app = document.querySelector('#app');
    const trigger = document.querySelector('#periodicals-open');
    const nav = document.querySelector('#periodicals-nav');
    const reader = document.querySelector('#periodicals-reader');
    const empty = document.querySelector('#periodicals-empty');
    const periodicalDocument = document.querySelector('#periodicals-document');
    const list = document.querySelector('#periodicals-list');
    const tabs = [...document.querySelectorAll('#periodicals-tabs [role="tab"]')];
    if (!app || !trigger || !nav || !reader || !empty || !periodicalDocument || !list) return false;

    function element(tagName, className, text) {
      const node = document.createElement(tagName);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text);
      return node;
    }

    function displayScore(value) {
      const score = Number(value);
      if (!Number.isFinite(score)) return '0 分';
      return `${score.toFixed(1).replace(/\.0$/, '')} 分`;
    }

    function scoreComponents(score = {}) {
      const sourceQuality = score.sourceQuality || {};
      const confirmation = score.confirmation || {};
      const persistence = score.persistence || {};
      const trend = score.trend || {};
      const freshness = score.freshness || {};
      const behavior = score.behavior || {};
      return [
        ['来源质量', sourceQuality.points, `${EDITORIAL_PRIORITY_LABELS[sourceQuality.priority] || '普通'}优先级`],
        ['独立确认', confirmation.points, `${Number(confirmation.independentSourceCount) || 0} 个独立来源`],
        ['近期持续', persistence.points, `过去 7 个冻结日报 ${Number(persistence.daysPresent) || 0} 天`],
        ['趋势增量', trend.points, `单日峰值 ${Number(trend.baselineSourceCount) || 0}，增加 ${Number(trend.sourceIncrease) || 0}`],
        ['时间衰减', freshness.points, `${Number(freshness.ageHours) || 0} 小时`],
        ['行为信号', behavior.points, behavior.enabled ? '已启用' : '已关闭'],
      ];
    }

    function renderScoreDetails(event) {
      const details = element('details', 'periodical-score-details');
      const version = String(event.score && event.score.version || '').trim();
      details.append(element(
        'summary',
        'periodical-details-summary',
        version ? `评分分量 · ${version}` : '评分分量',
      ));
      const list = element('ul', 'periodical-score-components');
      for (const [label, points, input] of scoreComponents(event.score)) {
        const row = element('li', 'periodical-score-component');
        row.append(
          element('strong', '', label),
          element('span', '', displayScore(points)),
          element('small', '', input),
        );
        list.append(row);
      }
      details.append(list);
      return details;
    }

    function renderEvidence(item) {
      const evidence = element('li', 'periodical-evidence');
      const source = element('span', 'periodical-evidence-source', item.sourceName || '未知来源');
      const title = item.entryTitleZh || item.entryTitle || '无标题';
      const href = String(item.entryLink || '');
      const entry = /^https?:\/\//i.test(href)
        ? element('a', 'periodical-evidence-link', title)
        : element('span', 'periodical-evidence-link', title);
      if (entry.tagName === 'A') {
        entry.href = href;
        entry.target = '_blank';
        entry.rel = 'noopener noreferrer';
      }
      evidence.append(
        source,
        entry,
        element('span', 'periodical-evidence-meta', evidenceMeta(item)),
      );
      if (item.timestampFallback) {
        evidence.append(element('span', 'periodical-evidence-fallback', '发布时间异常，已回退至收录时间'));
      }
      return evidence;
    }

    function leave() {
      app.classList.remove('periodicals-mode');
      trigger.removeAttribute('aria-current');
      nav.classList.add('hidden');
      reader.classList.add('hidden');
    }

    const view = {
      enter(cadence) {
        app.classList.add('periodicals-mode');
        trigger.setAttribute('aria-current', 'page');
        nav.classList.remove('hidden');
        reader.classList.remove('hidden');
        empty.classList.add('hidden');
        periodicalDocument.classList.add('hidden');
        list.replaceChildren();
        tabs.forEach(tab => {
          const selected = tab.dataset.periodicalCadence === cadence;
          tab.setAttribute('aria-selected', String(selected));
          tab.setAttribute('tabindex', selected ? '0' : '-1');
        });
        document.title = '精选期刊 · Namoo Reader';
      },
      renderIndex(cadence, issues) {
        const items = issues.map(issue => {
          const link = element('a', 'periodicals-list-item');
          link.href = `/periodicals/${cadence}/${issue.periodKey}`;
          link.append(
            element('strong', '', issue.periodKey),
            element('span', '', `${issue.eventCount || 0} 个事件 · ${STATUS_LABELS[issue.status] || issue.status}`),
          );
          return link;
        });
        list.replaceChildren(...items);
      },
      renderEmpty() {
        empty.textContent = '精选期刊正在准备第一期';
        empty.classList.remove('hidden');
      },
      renderError() {
        empty.textContent = '精选期刊暂时不可用';
        empty.classList.remove('hidden');
      },
      renderIssue(payload) {
        const issue = payload && payload.issue || {};
        const themes = Array.isArray(payload && payload.themes) ? payload.themes : [];
        const events = Array.isArray(payload && payload.events) ? payload.events : [];
        const evidence = Array.isArray(payload && payload.evidence) ? payload.evidence : [];
        const header = element('header', 'periodical-document-header');
        header.append(
          element('p', 'periodical-document-meta', [
            CADENCE_LABELS[issue.cadence] || issue.cadence,
            `第 ${issue.volumeNo || 1} 卷`,
            issue.periodKey,
            STATUS_LABELS[issue.status] || issue.status,
          ].filter(Boolean).join(' · ')),
          element('h1', '', `精选${CADENCE_LABELS[issue.cadence] || '期刊'}`),
          element('p', 'periodical-overview', issue.overview || '本期暂无概览。'),
        );

        const directory = element('nav', 'periodical-directory');
        directory.setAttribute('aria-label', '本期目录');
        directory.append(element('strong', '', '目录'));
        const directoryLinks = element('div', 'periodical-directory-links');
        for (const theme of themes) {
          const link = element('a', '', theme.title);
          link.href = `#${theme.id}`;
          directoryLinks.append(link);
        }
        directory.append(directoryLinks);

        const sections = themes.map(theme => {
          const section = element('section', 'periodical-theme');
          section.id = theme.id;
          section.append(
            element('h2', '', theme.title),
            element('p', 'periodical-theme-note', theme.trendNote),
          );
          for (const event of events.filter(item => item.themeId === theme.id)) {
            const card = element('article', 'periodical-event');
            const heading = element('div', 'periodical-event-heading');
            heading.append(
              element('h3', '', event.title),
              element('strong', 'periodical-score', displayScore(event.importanceScore)),
            );
            const eventEvidence = evidence.filter(value => value.eventId === event.id);
            const independentSourceCount = Number(
              event.score && event.score.confirmation
                && event.score.confirmation.independentSourceCount,
            ) || 0;
            const evidenceDetails = element('details', 'periodical-evidence-details');
            evidenceDetails.append(element(
              'summary',
              'periodical-details-summary',
              `查看 ${eventEvidence.length} 条证据`,
            ));
            const evidenceList = element('ul', 'periodical-evidence-list');
            for (const item of eventEvidence) {
              evidenceList.append(renderEvidence(item));
            }
            evidenceDetails.append(evidenceList);
            card.append(
              heading,
              element(
                'p',
                'periodical-event-source-count',
                `${independentSourceCount} 个独立来源 · ${eventEvidence.length} 条证据`,
              ),
              element('p', 'periodical-event-summary', event.summary),
              element('p', 'periodical-event-why', event.whySelected),
              renderScoreDetails(event),
              evidenceDetails,
            );
            section.append(card);
          }
          return section;
        });

        periodicalDocument.replaceChildren(header, directory, ...sections);
        empty.classList.add('hidden');
        periodicalDocument.classList.remove('hidden');
        document.title = `${issue.periodKey || '精选期刊'} · Namoo Reader`;
      },
    };
    const request = async url => {
      const response = await root.fetch(url, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        const error = new Error('periodical request failed');
        error.status = response.status;
        throw error;
      }
      return response.json();
    };
    const controller = createPeriodicalsController({ request, view });

    trigger.classList.remove('hidden');
    trigger.addEventListener('click', event => {
      event.preventDefault();
      root.location.assign('/periodicals');
    });
    document.addEventListener('click', event => {
      if (!app.classList.contains('periodicals-mode')) return;
      const target = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('#brand-home, [data-sidebar-category], [data-view], #feed-groups button')
        : null;
      if (target) leave();
    });

    return {
      leave,
      ready: controller.open(root.location.pathname),
    };
  }

  return {
    createPeriodicalsController,
    mountPeriodicals,
    parsePeriodicalPath,
  };
}));
