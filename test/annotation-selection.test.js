const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectDir = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(projectDir, 'public', 'styles.css'), 'utf8');

function extractFunction(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected ${name}() in public/app.js`);
  const bodyStart = app.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < app.length; index += 1) {
    if (app[index] === '{') depth += 1;
    if (app[index] === '}') depth -= 1;
    if (depth === 0) return app.slice(start, index + 1);
  }
  throw new Error(`could not extract ${name}()`);
}

function createPopoverContext({ highlightSupported }) {
  const classes = new Set(['hidden']);
  const registry = new Map();
  const selectedRange = { id: 'selected-range' };
  let focusCalls = 0;
  class FakeHighlight {
    constructor(...ranges) {
      this.ranges = ranges;
    }
  }
  const popover = {
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
    },
    style: {},
  };
  const input = {
    value: 'stale text',
    focus() {
      focusCalls += 1;
    },
  };
  const quote = { textContent: '' };
  const elements = {
    '#annotation-popover': popover,
    '#annotation-popover-input': input,
    '#annotation-popover-quote': quote,
  };
  const context = {
    ANNOTATION_DRAFT_HIGHLIGHT_NAME: 'annotation-draft',
    ANNOTATION_SURFACE_LABELS: { original: '原文' },
    state: { annotationDraft: null },
    window: {
      CSS: highlightSupported ? { highlights: registry } : {},
      Highlight: highlightSupported ? FakeHighlight : undefined,
      innerWidth: 1280,
      innerHeight: 900,
    },
    $: selector => elements[selector],
    setTimeout: callback => callback(),
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction('clearAnnotationDraftHighlight'),
    extractFunction('showAnnotationDraftHighlight'),
    extractFunction('hideAnnotationPopover'),
    extractFunction('showAnnotationPopover'),
  ].join('\n'), context);

  return {
    classes,
    context,
    get focusCalls() { return focusCalls; },
    input,
    quote,
    registry,
    selectedRange,
  };
}

test('annotation popover keeps a focus-independent highlight until it closes', () => {
  const fixture = createPopoverContext({ highlightSupported: true });
  const selection = {
    surface: 'original',
    quote: 'selected text',
    selectedText: 'selected text',
    prefix: 'before',
    suffix: 'after',
    assetId: 'asset-1',
    contentHash: 'hash-1',
    rect: { left: 120, bottom: 180 },
    range: fixture.selectedRange,
  };

  fixture.context.showAnnotationPopover(selection);

  const highlight = fixture.registry.get('annotation-draft');
  assert.ok(highlight, 'expected the selected range to remain painted');
  assert.equal(highlight.ranges[0], fixture.selectedRange);
  assert.equal(fixture.focusCalls, 1, 'supported browsers should keep the existing autofocus');
  assert.equal(fixture.classes.has('hidden'), false);
  assert.equal(fixture.quote.textContent, '原文：selected text');

  fixture.context.hideAnnotationPopover();

  assert.equal(fixture.registry.has('annotation-draft'), false);
  assert.equal(fixture.context.state.annotationDraft, null);
  assert.equal(fixture.classes.has('hidden'), true);
});

test('annotation popover preserves the native selection when custom highlights are unavailable', () => {
  const fixture = createPopoverContext({ highlightSupported: false });

  fixture.context.showAnnotationPopover({
    surface: 'original',
    quote: 'fallback text',
    selectedText: 'fallback text',
    prefix: '',
    suffix: '',
    assetId: '',
    contentHash: '',
    rect: { left: 20, bottom: 40 },
    range: fixture.selectedRange,
  });

  assert.equal(fixture.focusCalls, 0, 'autofocus would clear the only visible native selection');
  assert.equal(fixture.classes.has('hidden'), false);
});

test('selection context clones the live range and the draft highlight has visible styling', () => {
  const selectionContext = extractFunction('selectionAnnotationContext');
  assert.match(selectionContext, /range:\s*range\.cloneRange\(\)/);
  assert.match(styles, /::highlight\(annotation-draft\)\s*\{[^}]*background-color:/s);
});
