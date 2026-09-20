(function exposeWorkspaceNavigation(root, factory) {
  const navigation = factory();
  if (typeof module === 'object' && module.exports) module.exports = navigation;
  if (root) root.NamooWorkspaceNavigation = navigation;
}(typeof window === 'undefined' ? null : window, () => {
  // Content and per-view reading positions stay with their existing owners.
  // A visit is a capability: only its current owner may publish async results.
  function createWorkspaceNavigation(root, {
    canEnterDashboard = () => true,
    requestLogin = () => {},
    onViewChange = () => {},
    hasEntry = () => false,
    readRoute = () => ({}),
    prepareRestore = () => {},
    openReading = () => true,
    openDashboard = () => true,
    openContributor = () => true,
    openPeriodicals = (target, owner) => root.NamooPeriodicals.open(target, owner),
  } = {}) {
    let active = 'reading';
    let visit = 0;
    const element = selector => root.document.querySelector(selector);
    const toggle = (selector, name, enabled) => {
      const node = element(selector);
      if (!node) return;
      if (node.classList.toggle) node.classList.toggle(name, enabled);
      else node.classList[enabled ? 'add' : 'remove'](name);
    };

    function ownership() {
      const identity = visit;
      const isCurrent = () => identity === visit;
      return {
        isCurrent,
        push(state, url) {
          if (!isCurrent()) return false;
          root.history.pushState(state, '', url);
          return true;
        },
        replace(state, url) {
          if (!isCurrent()) return false;
          root.history.replaceState({ ...root.history.state, ...state }, '', url);
          return true;
        },
      };
    }

    function enter(view, restoring) {
      if (!['reading', 'periodicals', 'dashboard', 'contributor'].includes(view)) {
        throw new Error('Unknown Workspace View');
      }
      if (view === 'dashboard' && !canEnterDashboard()) {
        requestLogin();
        return null;
      }
      if (active === 'periodicals') {
        // popstate already points at the destination entry. Never write the
        // outgoing snapshot there; scroll events keep its own entry up to date.
        if (!restoring) root.NamooPeriodicals?.capture?.();
        root.NamooPeriodicals?.invalidate?.();
      }
      visit += 1;
      active = view;
      const personal = view === 'dashboard' || view === 'contributor';
      toggle('#app', 'workspace-page-open', personal);
      toggle('#app', 'periodicals-mode', view === 'periodicals');
      toggle('#app', 'periodical-detail-open', false);
      toggle('#my-dashboard-page', 'hidden', view !== 'dashboard');
      toggle('#contributor-page', 'hidden', view !== 'contributor');
      toggle('#periodicals-nav', 'hidden', view !== 'periodicals');
      toggle('#periodicals-reader', 'hidden', view !== 'periodicals');
      toggle('#periodicals-back', 'hidden', true);
      const trigger = element('#periodicals-open');
      if (view === 'periodicals') trigger?.setAttribute('aria-current', 'page');
      else trigger?.removeAttribute('aria-current');
      toggle('#reader', 'hidden', view !== 'reading' || !hasEntry());
      toggle('#reader-empty', 'hidden', view !== 'reading' || hasEntry());
      toggle('#app', 'reading', view === 'reading' && hasEntry());
      if (personal && element('#reader-pane')) element('#reader-pane').scrollTop = 0;
      onViewChange(view);
      return ownership();
    }

    function navigate(target, restoring = false) {
      const owner = enter(target.view, restoring);
      if (!owner) return Promise.resolve(false);
      if (restoring) prepareRestore(target);
      // These are the four shipped views, not a registration/router framework.
      if (target.view === 'periodicals') return openPeriodicals(target, owner);
      if (target.view === 'dashboard') return openDashboard(target, owner);
      if (target.view === 'contributor') return openContributor(target, owner);
      return openReading(target, owner);
    }

    const navigation = {
      go: target => navigate(typeof target === 'string' ? { view: target } : target),
      restore({ url, state, ...options }) {
        const pathname = new URL(String(url), 'https://reader.invalid').pathname;
        const route = readRoute(url);
        const view = /^\/periodicals(?:\/|$)/.test(pathname) ? 'periodicals'
          : /^\/(?:me|dashboard|admin)\/?$/.test(pathname) ? 'dashboard'
            : route.contributorId ? 'contributor' : 'reading';
        return navigate({ ...route, ...options, view, pathname, historyState: state, push: false, restoring: true }, true);
      },
      current: ownership,
    };
    root.addEventListener?.('popstate', event => navigation.restore({
      url: `${root.location.pathname}${root.location.search || ''}${root.location.hash || ''}`,
      state: event.state,
    }));
    root.document.addEventListener?.('click', event => {
      if (active !== 'periodicals') return;
      const target = event.target?.closest?.('#brand-home, [data-sidebar-category], [data-view], #feed-groups button');
      if (target) navigation.go({ view: 'reading' });
    });
    return navigation;
  }
  return { createWorkspaceNavigation };
}));
