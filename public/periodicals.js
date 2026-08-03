(function exposePeriodicals(root, factory) {
  const periodicals = factory();
  if (typeof module === 'object' && module.exports) module.exports = periodicals;
  if (root) {
    root.NamooPeriodicals = periodicals;
    const mounted = periodicals.mountPeriodicals(root);
    if (mounted && typeof mounted.leave === 'function') periodicals.leave = mounted.leave;
  }
}(typeof window === 'undefined' ? null : window, () => {
  const CADENCES = new Set(['daily', 'weekly', 'monthly']);
  const CADENCE_LABELS = { daily: '日报', weekly: '周报', monthly: '月报' };
  const EDITORIAL_PRIORITY_LABELS = { high: '高', normal: '普通', low: '低' };
  const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
  const STATUS_LABELS = { open: '更新中', finalizing: '正在定稿', frozen: '已冻结' };
  const CADENCE_EMPTY_LABELS = {
    daily: '精选期刊正在准备第一期',
    weekly: '暂无精选周报',
    monthly: '暂无精选月报',
  };

  function issueStatusLabel(issue = {}) {
    if (issue.status === 'finalizing') return STATUS_LABELS.finalizing;
    if (issue.updateDelayed) return '更新延迟';
    if (issue.updateState === 'queued' || issue.updateState === 'running') return '收集中';
    if (issue.status === 'frozen') return STATUS_LABELS.frozen;
    if (issue.status === 'open' && Number(issue.eventCount) === 0 && issue.lastSuccessfulAt) {
      return '低于门槛';
    }
    return STATUS_LABELS[issue.status] || issue.status;
  }

  function issueStateMessage(issue = {}, eventCount = 0) {
    if (issue.status === 'finalizing') return '正在定稿';
    if (issue.updateState === 'queued' || issue.updateState === 'running') return '正在收集本期内容';
    if (issue.status === 'frozen' && eventCount === 0) return '本期无入选事件 · 已冻结';
    if (issue.status === 'open' && eventCount === 0 && !issue.updateDelayed) {
      return '本期尚未达到入选门槛';
    }
    return '';
  }

  function shanghaiDateTime(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp)) return '';
    const date = new Date(timestamp + SHANGHAI_OFFSET_MS);
    return [
      [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
      ].join('-'),
      [
        String(date.getUTCHours()).padStart(2, '0'),
        String(date.getUTCMinutes()).padStart(2, '0'),
      ].join(':'),
    ].join(' ');
  }

  function shanghaiDate(value) {
    if (value === null || value === undefined || value === '') return '';
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp)) return '';
    const date = new Date(timestamp + SHANGHAI_OFFSET_MS);
    return [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    ].join('-');
  }

  function coverageLabel(issue = {}) {
    const periodStartAt = Number(issue.periodStartAt);
    const coverageStartedAt = issue.coverageStartedAt === null
      || issue.coverageStartedAt === undefined
      || issue.coverageStartedAt === ''
      ? periodStartAt
      : Number(issue.coverageStartedAt);
    if (!Number.isFinite(coverageStartedAt)) return '';
    const periodEndAt = Number(issue.periodEndAt);
    const inclusiveEndAt = Number.isFinite(periodEndAt) && periodEndAt > coverageStartedAt
      ? periodEndAt - 1
      : coverageStartedAt;
    const start = shanghaiDate(coverageStartedAt);
    const end = shanghaiDate(inclusiveEndAt);
    return start && end && start !== end ? `${start} 至 ${end}` : start;
  }

  function evidenceMeta(item) {
    const priority = EDITORIAL_PRIORITY_LABELS[item.editorialPriority] || '普通';
    const publishedAt = shanghaiDateTime(item.effectivePublishedAt);
    return publishedAt ? `${priority}优先级 · ${publishedAt}` : `${priority}优先级`;
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
    const cadenceMatch = path.match(/^\/periodicals\/([^/]+)\/?$/);
    if (cadenceMatch) {
      const cadence = String(cadenceMatch[1] || '').toLowerCase();
      return CADENCES.has(cadence) ? { cadence, periodKey: '' } : { invalid: true };
    }
    const match = path.match(/^\/periodicals\/([^/]+)\/([^/]+)\/?$/);
    if (!match) return path.startsWith('/periodicals') ? { invalid: true } : null;
    const cadence = String(match[1] || '').toLowerCase();
    const periodKey = String(match[2] || '');
    if (!CADENCES.has(cadence) || !validPeriodKey(cadence, periodKey)) return { invalid: true };
    return { cadence, periodKey };
  }

  function createPeriodicalsController({ request, view }) {
    let requestSequence = 0;
    let current = null;
    let loadingMore = false;

    function renderCurrentIndex() {
      view.renderIndex(current.cadence, current.issues, {
        lastCursor: current.lastCursor,
        nextCursor: current.nextCursor,
        selectedPeriodKey: current.periodKey,
      });
    }

    function restoreViewScroll(restore) {
      if (!restore || typeof view.restoreScroll !== 'function') return;
      view.restoreScroll({
        listScroll: Number(restore.listScroll) || 0,
        documentScroll: Number(restore.documentScroll) || 0,
      });
    }

    async function joinEvidenceAvailability(detail, cadence, periodKey) {
      const evidence = Array.isArray(detail && detail.evidence) ? detail.evidence : [];
      if (evidence.length === 0
        || evidence.every(item => typeof item.entryAvailable === 'boolean')) {
        return detail;
      }
      const projection = await request(
        `/api/periodicals/${cadence}/${periodKey}/evidence-availability`,
        { cache: 'no-store' },
      );
      const availability = new Map((Array.isArray(projection && projection.evidence)
        ? projection.evidence
        : []).map(item => [
        JSON.stringify([item.eventId, item.entryId]),
        item.entryAvailable === true,
      ]));
      return {
        ...detail,
        evidence: evidence.map(item => ({
          ...item,
          entryAvailable: availability.get(JSON.stringify([item.eventId, item.entryId])) === true,
        })),
      };
    }

    async function open(pathname, { restore = null, indexOnly = false } = {}) {
      const route = parsePeriodicalPath(pathname);
      if (!route || route.invalid) return false;
      const sequence = ++requestSequence;
      view.enter(route.cadence);
      current = {
        cadence: route.cadence,
        issues: [],
        lastCursor: null,
        nextCursor: null,
        periodKey: route.periodKey || '',
        sequence,
      };

      let index;
      try {
        index = await request(
          `/api/periodicals?cadence=${route.cadence}&limit=30`,
          { cache: 'no-store' },
        );
      } catch (error) {
        if (sequence !== requestSequence) return false;
        const renderError = view.renderIndexError || view.renderError;
        if (typeof renderError === 'function') renderError(error);
        restoreViewScroll(restore);
        return true;
      }
      if (sequence !== requestSequence) return false;
      const issues = Array.isArray(index && index.issues) ? index.issues : [];
      const restoredPeriodKey = restore
        && restore.cadence === route.cadence
        && validPeriodKey(route.cadence, restore.periodKey)
        ? restore.periodKey
        : '';
      current = {
        cadence: route.cadence,
        issues,
        lastCursor: null,
        nextCursor: index && index.nextCursor || null,
        periodKey: route.periodKey || restoredPeriodKey || (issues[0] && issues[0].periodKey) || '',
        sequence,
      };
      renderCurrentIndex();
      const targetCursor = restore && restore.lastCursor || null;
      const restoredCursors = new Set();
      while (targetCursor && current.nextCursor && !restoredCursors.has(current.nextCursor)) {
        const cursor = current.nextCursor;
        restoredCursors.add(cursor);
        if (!await loadMore()) break;
        if (cursor === targetCursor) break;
      }
      if (current.issues.length === 0) {
        view.renderEmpty(route.cadence);
        restoreViewScroll(restore);
        return true;
      }
      if (indexOnly && !route.periodKey) {
        restoreViewScroll(restore);
        return true;
      }
      const periodKey = current.periodKey;
      try {
        const storedDetail = await request(
          `/api/periodicals/${route.cadence}/${periodKey}`,
          { cache: 'no-cache' },
        );
        const detail = await joinEvidenceAvailability(storedDetail, route.cadence, periodKey);
        if (sequence !== requestSequence) return false;
        view.renderIssue(detail);
        restoreViewScroll(restore);
        return true;
      } catch (error) {
        if (sequence !== requestSequence) return false;
        const renderError = view.renderDocumentError || view.renderError;
        if (typeof renderError === 'function') renderError(error);
        restoreViewScroll(restore);
        return true;
      }
    }

    async function loadMore() {
      if (!current || !current.nextCursor || loadingMore) return false;
      const cursor = current.nextCursor;
      const sequence = current.sequence;
      loadingMore = true;
      try {
        const page = await request(
          `/api/periodicals?cadence=${current.cadence}&limit=30&cursor=${encodeURIComponent(cursor)}`,
          { cache: 'no-store' },
        );
        if (!current || sequence !== requestSequence || current.sequence !== sequence) return false;
        current.issues = current.issues.concat(Array.isArray(page && page.issues) ? page.issues : []);
        current.lastCursor = cursor;
        current.nextCursor = page && page.nextCursor || null;
        renderCurrentIndex();
        return true;
      } catch (error) {
        if (sequence === requestSequence) {
          const renderError = view.renderIndexError || view.renderError;
          if (typeof renderError === 'function') renderError(error);
        }
        return false;
      } finally {
        loadingMore = false;
      }
    }

    function getState() {
      if (!current) return null;
      return {
        cadence: current.cadence,
        periodKey: current.periodKey,
        lastCursor: current.lastCursor,
        nextCursor: current.nextCursor,
      };
    }

    return { getState, loadMore, open };
  }

  function mountPeriodicals(root) {
    const document = root && root.document;
    if (!document || document.body.dataset.periodicalsMode !== 'on') return false;

    const app = document.querySelector('#app');
    const trigger = document.querySelector('#periodicals-open');
    const nav = document.querySelector('#periodicals-nav');
    const readerPane = document.querySelector('#reader-pane');
    const reader = document.querySelector('#periodicals-reader');
    const empty = document.querySelector('#periodicals-empty');
    const periodicalDocument = document.querySelector('#periodicals-document');
    const list = document.querySelector('#periodicals-list');
    const back = document.querySelector('#periodicals-back');
    const tabs = [...document.querySelectorAll('#periodicals-tabs [role="tab"]')];
    if (!app || !trigger || !nav || !readerPane || !reader || !empty
      || !periodicalDocument || !list || !back) {
      return false;
    }
    const mobileMedia = root.matchMedia && root.matchMedia('(max-width: 860px)');
    let mobileLayout = Boolean(mobileMedia && mobileMedia.matches);
    const selectedPeriodKeys = new Map();

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
      if (/^(?:weekly|monthly)-rollup-v1$/.test(String(score.version || ''))) {
        const maximum = score.maxDailyScore || {};
        const topThree = score.meanTop3DailyScores || {};
        const occurrence = score.occurrenceDays || {};
        const breadth = score.sourceBreadth || {};
        return [
          ['最高日报分', maximum.points, `最高 ${displayScore(maximum.value)}`],
          ['Top-3 均值', topThree.points, `均值 ${displayScore(topThree.value)}`],
          ['出现天数', occurrence.points, `${Number(occurrence.daysPresent) || 0}/${Number(occurrence.periodDays) || 7} 天`],
          ['来源广度', breadth.points, `${Number(breadth.distinctSources) || 0} 个来源`],
        ];
      }
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
      const sourceLabels = (Array.isArray(item.sourceLabels) ? item.sourceLabels : [])
        .map(value => String(value || '').trim())
        .filter(Boolean);
      const sourceName = item.sourceName || '未知来源';
      const source = element(
        'span',
        'periodical-evidence-source',
        sourceLabels.length > 0 ? `${sourceName} · ${sourceLabels.join('、')}` : sourceName,
      );
      const title = item.entryTitleZh || item.entryTitle || '无标题';
      const entryId = String(item.entryId || '').trim();
      const entryAvailable = Boolean(item.entryAvailable && entryId);
      const entry = entryAvailable
        ? element('a', 'periodical-evidence-link', title)
        : element('span', 'periodical-evidence-link', title);
      if (entryAvailable) {
        entry.href = `/articles/${encodeURIComponent(entryId)}`;
        entry.addEventListener('click', () => replaceHistoryState());
      }
      evidence.append(
        source,
        entry,
        element('span', 'periodical-evidence-meta', evidenceMeta(item)),
      );
      if (!entryAvailable) {
        evidence.append(element(
          'span',
          'periodical-evidence-unavailable',
          '原文已不可用 · 冻结快照',
        ));
        if (item.summaryExcerpt) {
          evidence.append(element(
            'p',
            'periodical-evidence-snapshot',
            item.summaryExcerpt,
          ));
        }
      }
      const href = String(item.entryLink || '');
      if (/^https:\/\//i.test(href)) {
        const external = element('a', 'periodical-evidence-external', '原始链接');
        external.href = href;
        external.target = '_blank';
        external.rel = 'noopener noreferrer';
        evidence.append(external);
      }
      if (item.timestampFallback) {
        evidence.append(element('span', 'periodical-evidence-fallback', '发布时间异常，已回退至收录时间'));
      }
      return evidence;
    }

    function leave() {
      app.classList.remove('periodicals-mode');
      app.classList.remove('periodical-detail-open');
      trigger.removeAttribute('aria-current');
      nav.classList.add('hidden');
      reader.classList.add('hidden');
      back.classList.add('hidden');
    }

    let controller = null;

    function replaceHistoryState(pathname = root.location.pathname, scroll = null) {
      if (!controller || !root.history || typeof root.history.replaceState !== 'function') return;
      const state = controller.getState();
      if (!state) return;
      const previous = root.history.state && typeof root.history.state === 'object'
        ? root.history.state
        : {};
      root.history.replaceState({
        ...previous,
        periodicals: {
          ...(previous.periodicals || {}),
          ...state,
          listScroll: Number((scroll && scroll.listScroll) ?? list.scrollTop) || 0,
          documentScroll: Number((scroll && scroll.documentScroll) ?? readerPane.scrollTop) || 0,
        },
      }, '', pathname);
    }

    function recordHistoryScroll(element, field) {
      const scrollTop = Number(element && element.scrollTop) || 0;
      const clientHeight = Number(element && element.clientHeight) || 0;
      const scrollHeight = Number(element && element.scrollHeight) || 0;
      if (scrollTop === 0 && scrollHeight <= clientHeight) return;
      const previous = root.history && root.history.state
        && root.history.state.periodicals || {};
      replaceHistoryState(root.location.pathname, {
        listScroll: field === 'listScroll' ? scrollTop : previous.listScroll,
        documentScroll: field === 'documentScroll' ? scrollTop : previous.documentScroll,
      });
    }

    const view = {
      enter(cadence) {
        app.classList.add('periodicals-mode');
        app.classList.remove('periodical-detail-open');
        trigger.setAttribute('aria-current', 'page');
        nav.classList.remove('hidden');
        reader.classList.remove('hidden');
        empty.classList.add('hidden');
        periodicalDocument.classList.add('hidden');
        back.classList.add('hidden');
        list.replaceChildren();
        let selectedTab = null;
        tabs.forEach(tab => {
          const selected = tab.dataset.periodicalCadence === cadence;
          if (selected) selectedTab = tab;
          tab.setAttribute('aria-selected', String(selected));
          tab.setAttribute('tabindex', selected ? '0' : '-1');
        });
        if (selectedTab && selectedTab.id) list.setAttribute('aria-labelledby', selectedTab.id);
        document.title = '精选期刊 · Namoo Reader';
      },
      renderIndex(cadence, issues, meta = {}) {
        const items = issues.map(issue => {
          const link = element('a', 'periodicals-list-item');
          const pathname = `/periodicals/${cadence}/${issue.periodKey}`;
          link.href = pathname;
          if (issue.periodKey === meta.selectedPeriodKey) link.setAttribute('aria-current', 'page');
          link.addEventListener('click', event => {
            event.preventDefault();
            return openPath(pathname, {
              push: true,
              returnPath: `/periodicals/${cadence}`,
            });
          });
          const status = issueStatusLabel(issue);
          link.append(
            element('strong', '', `${issue.periodKey} · 第 ${issue.volumeNo || 1} 卷`),
            element('span', '', `${issue.eventCount || 0} 个事件 · ${status}`),
          );
          const lastSuccessfulAt = shanghaiDateTime(issue.lastSuccessfulAt);
          if (lastSuccessfulAt) link.append(element('span', '', `最后成功 ${lastSuccessfulAt}`));
          return link;
        });
        if (meta.nextCursor) {
          const loadMore = element('button', 'periodicals-load-more', '加载更多');
          loadMore.type = 'button';
          loadMore.addEventListener('click', async () => {
            loadMore.disabled = true;
            await controller.loadMore();
            replaceHistoryState();
          });
          items.push(loadMore);
        }
        list.replaceChildren(...items);
      },
      renderEmpty(cadence = 'daily') {
        empty.textContent = CADENCE_EMPTY_LABELS[cadence] || CADENCE_EMPTY_LABELS.daily;
        empty.classList.remove('hidden');
      },
      renderIndexError(error) {
        empty.textContent = error && error.offline
          ? '需要连接网络'
          : '期刊索引暂时不可用';
        periodicalDocument.classList.add('hidden');
        empty.classList.remove('hidden');
      },
      renderDocumentError(error) {
        if (mobileLayout) {
          app.classList.add('periodical-detail-open');
          back.classList.remove('hidden');
        }
        empty.textContent = error && error.offline
          ? '需要连接网络'
          : (error && error.status === 404
            ? '未找到这期精选期刊'
            : '期刊正文暂时不可用');
        periodicalDocument.classList.add('hidden');
        empty.classList.remove('hidden');
      },
      renderIssue(payload) {
        if (mobileLayout) {
          app.classList.add('periodical-detail-open');
          back.classList.remove('hidden');
        }
        const issue = payload && payload.issue || {};
        const themes = Array.isArray(payload && payload.themes) ? payload.themes : [];
        const events = Array.isArray(payload && payload.events) ? payload.events : [];
        const evidence = Array.isArray(payload && payload.evidence) ? payload.evidence : [];
        const coverage = coverageLabel(issue);
        const header = element('header', 'periodical-document-header');
        header.append(
          element('p', 'periodical-document-meta', [
            CADENCE_LABELS[issue.cadence] || issue.cadence,
            `第 ${issue.volumeNo || 1} 卷`,
            issue.periodKey,
            STATUS_LABELS[issue.status] || issue.status,
            coverage ? `覆盖 ${coverage}` : '',
          ].filter(Boolean).join(' · ')),
          element('h1', '', `精选${CADENCE_LABELS[issue.cadence] || '期刊'}`),
          element('p', 'periodical-overview', issue.overview || '本期暂无概览。'),
        );
        const stateMessage = issueStateMessage(issue, events.length);
        if (stateMessage) {
          header.append(element('p', 'periodical-issue-state', stateMessage));
        }
        if (issue.summaryStatus === 'fallback') {
          header.append(element('p', 'periodical-summary-fallback', '本期使用规则摘要'));
        }
        if (issue.updateDelayed) {
          const lastSuccessfulAt = shanghaiDateTime(issue.lastSuccessfulAt);
          header.append(element(
            'p',
            'periodical-update-delay',
            lastSuccessfulAt
              ? `本期更新延迟 · 最后成功更新 ${lastSuccessfulAt}`
              : '本期更新延迟',
          ));
        }

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
            const rollupScore = /^(?:weekly|monthly)-rollup-v1$/.test(String(
              event.score && event.score.version || '',
            ));
            const sourceCount = Number(rollupScore
              ? event.score && event.score.sourceBreadth && event.score.sourceBreadth.distinctSources
              : event.score && event.score.confirmation
                && event.score.confirmation.independentSourceCount) || 0;
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
                `${sourceCount} 个${rollupScore ? '' : '独立'}来源 · ${eventEvidence.length} 条证据`,
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
      restoreScroll({ listScroll = 0, documentScroll = 0 } = {}) {
        list.scrollTop = Math.max(0, Number(listScroll) || 0);
        readerPane.scrollTop = Math.max(0, Number(documentScroll) || 0);
      },
    };
    const request = async (url, options = {}) => {
      if (root.navigator && root.navigator.onLine === false) {
        const error = new Error('需要连接网络');
        error.offline = true;
        throw error;
      }
      const response = await root.fetch(url, {
        cache: options.cache || 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        const error = new Error('periodical request failed');
        error.status = response.status;
        throw error;
      }
      return response.json();
    };
    controller = createPeriodicalsController({ request, view });

    async function openPath(pathname, {
      push = false,
      restore = null,
      returnPath = '',
    } = {}) {
      const route = parsePeriodicalPath(pathname);
      if (!route || route.invalid) return false;
      if (push) {
        replaceHistoryState();
        if (!root.history || typeof root.history.pushState !== 'function') {
          root.location.assign(pathname);
          return false;
        }
        root.history.pushState({
          periodicals: {
            cadence: route.cadence,
            periodKey: route.periodKey,
            lastCursor: null,
            nextCursor: null,
            listScroll: 0,
            documentScroll: 0,
            ...(returnPath ? { returnPath } : {}),
          },
        }, '', pathname);
      }
      const opened = await controller.open(pathname, { restore, indexOnly: mobileLayout });
      if (opened) {
        const state = controller.getState();
        if (state && state.periodKey) selectedPeriodKeys.set(state.cadence, state.periodKey);
        const canonicalPath = !route.periodKey
          ? (mobileLayout || !state || !state.periodKey
            ? `/periodicals/${route.cadence}`
            : `/periodicals/${route.cadence}/${state.periodKey}`)
          : pathname;
        replaceHistoryState(canonicalPath);
      }
      return opened;
    }

    function navigateCadence(cadence) {
      const selectedPeriodKey = selectedPeriodKeys.get(cadence);
      const pathname = !mobileLayout && selectedPeriodKey
        ? `/periodicals/${cadence}/${selectedPeriodKey}`
        : `/periodicals/${cadence}`;
      return openPath(pathname, { push: true });
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', event => {
        event.preventDefault();
        tab.focus();
        return navigateCadence(tab.dataset.periodicalCadence);
      });
      tab.addEventListener('keydown', event => {
        let nextIndex = index;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          nextIndex = (index + 1) % tabs.length;
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          nextIndex = (index - 1 + tabs.length) % tabs.length;
        } else if (event.key === 'Home') {
          nextIndex = 0;
        } else if (event.key === 'End') {
          nextIndex = tabs.length - 1;
        } else {
          return undefined;
        }
        event.preventDefault();
        const nextTab = tabs[nextIndex];
        nextTab.focus();
        return navigateCadence(nextTab.dataset.periodicalCadence);
      });
    });

    back.addEventListener('click', event => {
      event.preventDefault();
      const savedState = root.history && root.history.state && root.history.state.periodicals;
      if (savedState && savedState.returnPath
        && root.history && typeof root.history.back === 'function') {
        root.history.back();
        return true;
      }
      const state = controller.getState();
      return navigateCadence(state && state.cadence || 'daily');
    });

    list.addEventListener('scroll', () => recordHistoryScroll(list, 'listScroll'));
    readerPane.addEventListener('scroll', () => recordHistoryScroll(readerPane, 'documentScroll'));
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('popstate', event => {
        const nextRoute = parsePeriodicalPath(root.location.pathname);
        if (!nextRoute || nextRoute.invalid) {
          leave();
          return false;
        }
        const nextRestore = event && event.state && event.state.periodicals;
        return openPath(root.location.pathname, { restore: nextRestore || null });
      });
    }
    if (mobileMedia && typeof mobileMedia.addEventListener === 'function') {
      mobileMedia.addEventListener('change', event => {
        const nextMobileLayout = Boolean(event && event.matches);
        if (nextMobileLayout === mobileLayout) return undefined;
        mobileLayout = nextMobileLayout;
        const nextRestore = root.history && root.history.state
          && root.history.state.periodicals;
        return openPath(root.location.pathname, { restore: nextRestore || null }).then(opened => {
          if (opened && nextRestore) {
            replaceHistoryState(root.location.pathname, nextRestore);
          }
          return opened;
        });
      });
    }

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

    const route = parsePeriodicalPath(root.location.pathname);
    const saved = root.history && root.history.state && root.history.state.periodicals;
    const restore = route && !route.invalid && saved && saved.cadence === route.cadence
      ? saved
      : null;
    const ready = openPath(root.location.pathname, { restore });

    return {
      leave,
      ready,
    };
  }

  return {
    createPeriodicalsController,
    mountPeriodicals,
    parsePeriodicalPath,
  };
}));
