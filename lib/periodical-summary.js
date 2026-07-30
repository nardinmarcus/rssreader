const { computeCanonicalHash } = require('./content-hashes');

const SUMMARY_VERSION = 'constrained-summary-v1';
const THEME_DEFINITIONS = Object.freeze({
  research_models: '研究与模型',
  products_tools: '产品与工具',
  engineering_open_source: '工程与开源',
  industry_business: '产业与商业',
  community_practice: '社区与实践',
  creation_methods: '创作与方法',
});
const THEME_KEYS = Object.freeze(Object.keys(THEME_DEFINITIONS));
const CHINESE_WORD_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });
const NON_NUMERIC_CHINESE_LEXEMES = new Set([
  '一方面',
  '一般',
  '一致',
  '一旦',
  '十分',
  '陆续',
  '陸續',
]);
const PERIODICAL_SUMMARY_JSON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'events', 'themes'],
  properties: {
    overview: { type: 'string', minLength: 1, maxLength: 600 },
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'themeKey', 'title', 'summary', 'evidenceIds'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 240 },
          themeKey: { type: 'string', enum: THEME_KEYS },
          title: { type: 'string', minLength: 1, maxLength: 160 },
          summary: { type: 'string', minLength: 1, maxLength: 600 },
          evidenceIds: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 240 },
          },
        },
      },
    },
    themes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['themeKey', 'trendNote'],
        properties: {
          themeKey: { type: 'string', enum: THEME_KEYS },
          trendNote: { type: 'string', minLength: 1, maxLength: 320 },
        },
      },
    },
  },
});

function boundedText(value, limit) {
  return Array.from(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
}

function createSummaryEvidencePackage(issue) {
  return {
    schemaVersion: SUMMARY_VERSION,
    issue: {
      id: issue.issue.id,
      cadence: issue.issue.cadence,
      periodKey: issue.issue.periodKey,
    },
    events: issue.events.map(event => ({
      id: event.id,
      selectionReason: boundedText(event.whySelected, 320),
      evidence: issue.evidence
        .filter(item => item.eventId === event.id)
        .sort((left, right) => left.displayOrder - right.displayOrder)
        .map(item => ({
          id: item.entryId,
          sourceLabels: (Array.isArray(item.sourceLabels) ? item.sourceLabels : [])
            .slice(0, 12)
            .map(label => boundedText(label, 80)),
          title: boundedText(item.entryTitle, 240),
          titleZh: item.entryTitleZh ? boundedText(item.entryTitleZh, 240) : null,
          excerpt: boundedText(item.summaryExcerpt, 280),
          publishedAt: new Date(item.effectivePublishedAt).toISOString(),
        })),
    })),
  };
}

function computePeriodicalContentHash({ issue, themes, events, evidence }) {
  const {
    contentHash,
    inputHash,
    lastBuiltAt,
    selectionContext,
    sourceInputHash,
    ...semanticIssue
  } = issue;
  return computeCanonicalHash({
    issue: semanticIssue,
    themes,
    events,
    evidence,
    inputs: [],
  });
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, path, errors) {
  if (!isRecord(value)) {
    errors.push(`${path}: expected an object`);
    return false;
  }
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) errors.push(`${path}.${key}: unknown field`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key}: missing field`);
  }
  return true;
}

function numericTokens(value) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[−﹣‒–—]/gu, '-')
    .replace(/[⁄∕]/gu, '/')
    .replace(/٫/gu, '.')
    .replace(/٬/gu, ',');
  const decimal = '(?:\\p{Nd}+(?:[,_]\\p{Nd}+)*(?:\\.\\p{Nd}+)?|\\.\\p{Nd}+)';
  const arabicPattern = new RegExp(`(?:[$€£¥₹₽₩]\\s*)?[+\\-±~≈<>≤≥]?\\s*${decimal}(?:\\s*\\/\\s*${decimal})?(?:[eE][+\\-]?\\p{Nd}+)?(?:\\s*(?:%|‰|‱))?(?:\\s*(?:-|~|≈|:)\\s*[+\\-]?${decimal}(?:[eE][+\\-]?\\p{Nd}+)?(?:\\s*(?:%|‰|‱))?)*`, 'gu');
  const lowerDigits = '零〇○一二两兩俩倆三四五六七八九';
  const lowerUnits = '十百千万萬亿億兆';
  const financialDigits = '壹贰貳叁參肆伍陆陸柒捌玖';
  const financialUnits = '拾佰仟萬万億亿兆';
  const shorthandNumbers = '廿卅卌';
  const chineseDigits = `${lowerDigits}${financialDigits}`;
  const chineseNumberCharacters = `${chineseDigits}${lowerUnits}${financialUnits}${shorthandNumbers}`;
  const approximateDigits = '几幾';
  const approximateMarkers = `余多来${approximateDigits}`;
  const measureWords = '(?:个|個|项|項|条|條|次|倍|年|月|日|天|周|週|季度|小时|小時|分钟|分鐘|秒|人|名|位|家|款|件|例|种|種|组|組|份|期|页|頁|章|节|節|元|美元|%)';
  const financialNumber = `(?:(?=[${financialDigits}${financialUnits}]*[${financialUnits}])[${financialDigits}][${financialDigits}${financialUnits}]+|[${financialDigits}]{2,}(?=${measureWords}|(?!\\p{Script=Han})))`;
  const structuredNumber = `(?:[${lowerDigits}][${lowerDigits}${lowerUnits}]+|十[${lowerDigits}${lowerUnits}]+|${financialNumber}|拾[${financialDigits}${financialUnits}]+|[${shorthandNumbers}])`;
  const rawNumber = `[${chineseNumberCharacters}]+(?:[点點][${chineseDigits}]+)?`;
  const compoundNumber = `${rawNumber}(?:(?:分之|至|到|比|[-~≈:])${rawNumber})+`;
  const approximateNumber = `(?:[数數][${chineseNumberCharacters}]+(?:[${approximateMarkers}])?|[${approximateDigits}][${chineseNumberCharacters}]+(?:[${approximateMarkers}])?|[${chineseNumberCharacters}]+[${approximateMarkers}])`;
  const contextualNumber = `(?:第${rawNumber}|(?:${rawNumber}(?:余|多|来)?|半)(?=${measureWords})|(?<!\\p{Script=Han})[${chineseNumberCharacters}半](?!\\p{Script=Han}))`;
  const chineseNumber = `(?:${compoundNumber}|${approximateNumber}|[${chineseDigits}]+[点點][${chineseDigits}]+|[${chineseNumberCharacters}]+成(?:[${chineseDigits}]|半)?|${structuredNumber}|${contextualNumber})`;
  const chinesePattern = new RegExp(`(?:[$€£¥₹₽₩]\\s*)?[+\\-±~≈<>≤≥负負正]?\\s*${chineseNumber}`, 'gu');
  const singleChineseNumber = new RegExp(`^[${chineseNumberCharacters}${approximateDigits}半]$`, 'u');
  const chineseNumberCharacterSet = new Set(Array.from(`${chineseNumberCharacters}${approximateDigits}半`));
  const approximateCharacterSet = new Set(Array.from(approximateMarkers));
  const wordSegments = [...CHINESE_WORD_SEGMENTER.segment(normalized)].filter(part => part.isWordLike);
  const uncoveredChineseTokens = wordSegments.flatMap((part, index) => {
    if (NON_NUMERIC_CHINESE_LEXEMES.has(part.segment)) return [];
    if (singleChineseNumber.test(part.segment)) {
      const next = wordSegments[index + 1];
      const joinsRepeatedLexeme = next
        && part.index + part.segment.length === next.index
        && next.segment.startsWith(part.segment);
      return joinsRepeatedLexeme ? [] : [part.segment];
    }
    const characters = Array.from(part.segment);
    let prefixLength = 0;
    while (chineseNumberCharacterSet.has(characters[prefixLength])) prefixLength += 1;
    while (approximateCharacterSet.has(characters[prefixLength])) prefixLength += 1;
    const hasHanSuffix = prefixLength > 0
      && prefixLength < characters.length
      && /\p{Script=Han}/u.test(characters[prefixLength]);
    return hasHanSuffix ? [characters.slice(0, prefixLength).join('')] : [];
  });
  const matches = [
    ...(normalized.match(arabicPattern) || []),
    ...(normalized.match(chinesePattern) || []),
    ...uncoveredChineseTokens,
  ];
  return matches.map(token => token.replace(/\s+/gu, '').toLowerCase());
}

function containsUrl(value) {
  const text = String(value || '').normalize('NFKC');
  const idnaText = text.replace(/[。．｡]/gu, '.');
  return /\[[^\]]+\]\([^)]+\)/u.test(text)
    || /\b[a-z][a-z0-9+.-]*:(?:\/\/)?[^\s]+/iu.test(text)
    || /(?:^|[^\p{L}\p{N}_-])\/\/[^\s]+/u.test(text)
    || /(?:^|[^\p{L}\p{N}_-])(?=[^\s/:?#]*[a-z0-9])(?:www\.)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}[\p{L}\p{N}])?\.)+(?:\p{L}{1,63}|xn--[a-z0-9-]{2,59})(?=$|[\s/]|\p{P}|\p{S})/iu.test(idnaText)
    || /(?:^|[^\p{L}\p{N}_-])(?:www\.)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}[\p{L}\p{N}])?\.)+(?:\p{L}{1,63}|xn--[a-z0-9-]{2,59})(?=$|[\s/]|\p{P}|\p{S})/iu.test(text)
    || /(?:^|[^\p{L}\p{N}_-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}[\p{L}\p{N}])?[。｡])+(?:\p{L}{1,63}|xn--[a-z0-9-]{2,59})(?=[/:?#])/iu.test(text)
    || /(?:^|[^\d])(?:\d{1,3}\.){3}\d{1,3}(?=$|[\s/]|\p{P}|\p{S})/u.test(text)
    || /\[[0-9a-f:]{2,}\](?::\d+)?(?:[/?#][^\s]*)?/iu.test(text);
}

function supportedNumbers(evidencePackage, eventIds, structuralCounts = []) {
  const supported = new Set();
  const scopedEvents = eventIds === undefined
    ? evidencePackage.events
    : evidencePackage.events.filter(event => eventIds.has(event.id));
  const evidenceText = [
    evidencePackage.issue.periodKey,
    ...scopedEvents.flatMap(event => [
      event.selectionReason,
      ...event.evidence.flatMap(item => [
        item.title,
        item.titleZh,
        item.excerpt,
        item.publishedAt,
      ]),
    ]),
  ];
  for (const value of evidenceText) {
    for (const token of numericTokens(value)) supported.add(token);
  }
  for (const count of structuralCounts) {
    supported.add(String(count));
  }
  return supported;
}

function sentenceCount(value) {
  return String(value || '')
    .split(/[。！？!?]+|(?<!\d)\.(?!\d)/u)
    .map(part => part.trim())
    .filter(Boolean)
    .length;
}

function validateGeneratedText(value, path, {
  maxLength,
  minSentences,
  maxSentences,
  numbers,
}, errors) {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${path}: expected non-empty text`);
    return;
  }
  if (value !== value.trim()) errors.push(`${path}: surrounding whitespace is not allowed`);
  if (Array.from(value).length > maxLength) errors.push(`${path}: exceeds ${maxLength} characters`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) errors.push(`${path}: control characters are not allowed`);
  if (containsUrl(value)) {
    errors.push(`${path}: URLs are not allowed`);
  }
  for (const token of numericTokens(value)) {
    if (!numbers.has(token)) errors.push(`${path}: unsupported number`);
  }
  if (minSentences !== undefined) {
    const count = sentenceCount(value);
    if (count < minSentences || count > maxSentences) {
      errors.push(`${path}: expected ${minSentences}-${maxSentences} sentences`);
    }
  }
}

function validateSummaryOutput(output, evidencePackage) {
  const errors = [];
  const overviewNumbers = supportedNumbers(
    evidencePackage,
    undefined,
    [evidencePackage.events.length],
  );
  if (!exactKeys(output, ['overview', 'events', 'themes'], 'root', errors)) return errors;
  validateGeneratedText(output.overview, 'overview', {
    maxLength: 600,
    minSentences: 2,
    maxSentences: 3,
    numbers: overviewNumbers,
  }, errors);

  const expectedEventIds = evidencePackage.events.map(event => event.id);
  const expectedEventSet = new Set(expectedEventIds);
  const evidenceEventMap = new Map(evidencePackage.events.map(event => [event.id, event]));
  const seenEventIds = new Set();
  const usedThemeKeys = new Set();
  const themeEventIds = new Map();
  if (!Array.isArray(output.events)) {
    errors.push('events: expected an array');
  } else {
    if (output.events.length !== expectedEventIds.length) {
      errors.push(`events: expected ${expectedEventIds.length} events`);
    }
    output.events.forEach((event, index) => {
      const path = `events[${index}]`;
      if (!exactKeys(event, ['id', 'themeKey', 'title', 'summary', 'evidenceIds'], path, errors)) return;
      if (typeof event.id !== 'string' || !expectedEventSet.has(event.id)) {
        errors.push(`${path}.id: unknown Event ID`);
      } else {
        if (seenEventIds.has(event.id)) errors.push(`${path}.id: duplicate Event ID`);
        seenEventIds.add(event.id);
        if (event.id !== expectedEventIds[index]) errors.push(`${path}.id: Event order changed`);
      }
      if (!THEME_KEYS.includes(event.themeKey)) {
        errors.push(`${path}.themeKey: unsupported theme`);
      } else {
        usedThemeKeys.add(event.themeKey);
        if (!themeEventIds.has(event.themeKey)) themeEventIds.set(event.themeKey, new Set());
        if (expectedEventSet.has(event.id)) themeEventIds.get(event.themeKey).add(event.id);
      }
      const eventNumbers = supportedNumbers(evidencePackage, new Set([event.id]));
      validateGeneratedText(event.title, `${path}.title`, {
        maxLength: 160,
        numbers: eventNumbers,
      }, errors);
      validateGeneratedText(event.summary, `${path}.summary`, {
        maxLength: 600,
        minSentences: 1,
        maxSentences: 3,
        numbers: eventNumbers,
      }, errors);

      if (!Array.isArray(event.evidenceIds)) {
        errors.push(`${path}.evidenceIds: expected an array`);
        return;
      }
      const evidenceEvent = evidenceEventMap.get(event.id);
      const allowed = new Set((evidenceEvent && evidenceEvent.evidence || [])
        .map(item => item.id));
      const seenEvidenceIds = new Set();
      for (const evidenceId of event.evidenceIds) {
        if (typeof evidenceId !== 'string' || !allowed.has(evidenceId)) {
          errors.push(`${path}.evidenceIds: unknown evidence ID`);
        }
        if (seenEvidenceIds.has(evidenceId)) errors.push(`${path}.evidenceIds: duplicate evidence ID`);
        seenEvidenceIds.add(evidenceId);
      }
      for (const evidenceId of allowed) {
        if (!seenEvidenceIds.has(evidenceId)) errors.push(`${path}.evidenceIds: missing evidence ID`);
      }
    });
  }
  for (const eventId of expectedEventIds) {
    if (!seenEventIds.has(eventId)) errors.push(`events.${eventId}: missing Event ID`);
  }

  const seenThemeKeys = new Set();
  if (!Array.isArray(output.themes)) {
    errors.push('themes: expected an array');
  } else {
    output.themes.forEach((theme, index) => {
      const path = `themes[${index}]`;
      if (!exactKeys(theme, ['themeKey', 'trendNote'], path, errors)) return;
      if (!THEME_KEYS.includes(theme.themeKey)) errors.push(`${path}.themeKey: unsupported theme`);
      if (seenThemeKeys.has(theme.themeKey)) errors.push(`${path}.themeKey: duplicate theme`);
      seenThemeKeys.add(theme.themeKey);
      const themeNumbers = supportedNumbers(
        evidencePackage,
        themeEventIds.get(theme.themeKey) || new Set(),
        [(themeEventIds.get(theme.themeKey) || new Set()).size],
      );
      validateGeneratedText(theme.trendNote, `${path}.trendNote`, {
        maxLength: 320,
        minSentences: 1,
        maxSentences: 2,
        numbers: themeNumbers,
      }, errors);
    });
  }
  for (const themeKey of usedThemeKeys) {
    if (!seenThemeKeys.has(themeKey)) errors.push(`themes.${themeKey}: missing theme`);
  }
  for (const themeKey of seenThemeKeys) {
    if (!usedThemeKeys.has(themeKey)) errors.push(`themes.${themeKey}: theme has no Event`);
  }
  return [...new Set(errors)].slice(0, 24);
}

function applyGeneratedSummary(issue, output, response) {
  const outputEvents = new Map(output.events.map(event => [event.id, event]));
  const outputThemes = new Map((Array.isArray(output.themes) ? output.themes : [])
    .map(theme => [theme.themeKey, theme]));
  const themes = [];
  const themeMap = new Map();
  const events = issue.events.map(event => {
    const expression = outputEvents.get(event.id);
    if (!themeMap.has(expression.themeKey)) {
      const theme = {
        id: `${issue.issue.id}:theme:${expression.themeKey}`,
        themeKey: expression.themeKey,
        title: THEME_DEFINITIONS[expression.themeKey],
        trendNote: outputThemes.get(expression.themeKey).trendNote,
        displayOrder: themes.length,
      };
      themes.push(theme);
      themeMap.set(expression.themeKey, theme);
    }
    return {
      ...event,
      themeId: themeMap.get(expression.themeKey).id,
      title: expression.title,
      summary: expression.summary,
      summaryEvidenceIds: [...expression.evidenceIds],
    };
  });
  const generated = {
    ...issue,
    issue: {
      ...issue.issue,
      overview: output.overview,
      summaryVersion: SUMMARY_VERSION,
      summaryStatus: 'generated',
      provider: boundedText(response && response.provider, 80) || null,
      model: boundedText(response && response.model, 160) || null,
      contentHash: '',
    },
    themes,
    events,
  };
  generated.issue.contentHash = computePeriodicalContentHash(generated);
  return generated;
}

function providerFailureCode(error) {
  if (error && error.code === 'ERR_AI_UNCONFIGURED') return 'ai_unconfigured';
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'provider_timeout';
  }
  const statusCode = Number(error && error.statusCode);
  if (statusCode === 429) return 'provider_rate_limited';
  if (statusCode >= 500) return 'provider_unavailable';
  return 'provider_error';
}

function logFallback(logger, issue, code, attempt) {
  if (typeof logger !== 'function') return;
  logger({
    event: 'periodical_summary_fallback',
    issueId: issue.issue.id,
    code,
    attempt,
  });
}

async function summarizePeriodicalIssue(issue, { aiAdapter, beforeAttempt, logger } = {}) {
  if (issue && issue.issue && issue.issue.status === 'frozen') return issue;
  if (!issue || !Array.isArray(issue.events) || issue.events.length === 0) return issue;
  if (typeof aiAdapter !== 'function') return issue;
  const evidencePackage = createSummaryEvidencePackage(issue);
  let validationErrors = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (typeof beforeAttempt === 'function') await beforeAttempt(attempt + 1);
    let response;
    try {
      response = await aiAdapter({
        schema: PERIODICAL_SUMMARY_JSON_SCHEMA,
        evidencePackage,
        validationErrors,
      });
    } catch (error) {
      logFallback(logger, issue, providerFailureCode(error), attempt + 1);
      return issue;
    }
    let output;
    try {
      output = JSON.parse(String(response && response.content || ''));
    } catch {
      validationErrors = ['root: expected valid JSON'];
      continue;
    }
    validationErrors = validateSummaryOutput(output, evidencePackage);
    if (validationErrors.length) continue;
    return applyGeneratedSummary(issue, output, response);
  }
  logFallback(logger, issue, 'invalid_model_output', 2);
  return issue;
}

module.exports = {
  PERIODICAL_SUMMARY_JSON_SCHEMA,
  SUMMARY_VERSION,
  computePeriodicalContentHash,
  summarizePeriodicalIssue,
};
