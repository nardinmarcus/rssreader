(function exposePeriodicals(root, factory) {
  const periodicals = factory();
  if (typeof module === 'object' && module.exports) module.exports = periodicals;
  if (root) {
    root.NamooPeriodicals = periodicals;
    periodicals.mountPeriodicals(root);
  }
}(typeof window === 'undefined' ? null : window, () => {
  const CADENCES = new Set(['daily', 'weekly', 'monthly']);
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
        if (issues.length === 0) view.renderEmpty();
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
      renderIndex() {
        list.replaceChildren();
      },
      renderEmpty() {
        empty.textContent = '精选期刊正在准备第一期';
        empty.classList.remove('hidden');
      },
      renderError() {
        empty.textContent = '精选期刊暂时不可用';
        empty.classList.remove('hidden');
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
