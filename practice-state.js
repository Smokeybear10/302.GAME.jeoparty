'use strict';

const PracticeState = (() => {
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isSafeId = (value) => typeof value === 'string' && value.length > 0
    && !['__proto__', 'constructor', 'prototype'].includes(value);
  const isQuestion = (question) => isObject(question) && isSafeId(question.id) && isSafeId(question.topic);
  const integer = (value) => Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;

  function normalizeProgress(value, questions) {
    const bank = Array.isArray(questions) ? questions.filter(isQuestion) : [];
    const topics = [...new Set(bank.map((question) => question.topic))];
    const questionIds = new Set(bank.map((question) => question.id));
    const saved = isObject(value) ? value : {};
    let selectedTopics = topics;

    if (Array.isArray(saved.selectedTopics)) {
      const selected = topics.filter((topic) => saved.selectedTopics.includes(topic));
      if (saved.selectedTopics.length === 0 || selected.length > 0) selectedTopics = selected;
    }

    const records = {};
    if (isObject(saved.records)) {
      for (const [id, record] of Object.entries(saved.records)) {
        if (!questionIds.has(id) || !isObject(record)
          || !Number.isFinite(record.attempts) || !Number.isFinite(record.correct)
          || !Number.isFinite(record.lastReviewed) || typeof record.needsReview !== 'boolean') continue;

        const attempts = integer(record.attempts);
        if (attempts === 0) continue;
        records[id] = {
          attempts,
          correct: Math.min(attempts, integer(record.correct)),
          needsReview: record.needsReview,
          lastReviewed: integer(record.lastReviewed),
        };
      }
    }

    return { version: 1, selectedTopics, reviewOnly: saved.reviewOnly === true, records };
  }

  function recordResult(progress, id, correct, now = Date.now()) {
    if (!isSafeId(id) || typeof correct !== 'boolean') return progress;

    const previous = Object.hasOwn(progress.records, id) ? progress.records[id] : { attempts: 0, correct: 0 };
    return {
      ...progress,
      records: {
        ...progress.records,
        [id]: {
          attempts: integer(previous.attempts + 1),
          correct: integer(previous.correct + Number(correct)),
          needsReview: !correct,
          lastReviewed: integer(now),
        },
      },
    };
  }

  function selectNextQuestion(questions, progress, { seenIds = [], currentId = null, random = Math.random } = {}) {
    const normalized = normalizeProgress(progress, questions);
    const selectedTopics = new Set(normalized.selectedTopics);
    const seen = new Set(seenIds);
    const eligible = (Array.isArray(questions) ? questions : []).filter((question) => isQuestion(question)
      && selectedTopics.has(question.topic)
      && (!normalized.reviewOnly || normalized.records[question.id]?.needsReview));
    if (eligible.length === 0) return null;

    const alternatives = eligible.filter((question) => question.id !== currentId);
    const available = alternatives.length > 0 ? alternatives : eligible;
    const unseen = available.filter((question) => !seen.has(question.id));
    const candidates = unseen.length > 0 ? unseen : available;
    const unanswered = candidates.filter((question) => !Object.hasOwn(normalized.records, question.id));
    const pool = unanswered.length > 0 ? unanswered : candidates;
    const index = Math.max(0, Math.min(pool.length - 1, Math.floor(random() * pool.length)));
    return pool[index] ?? pool[0];
  }

  return { normalizeProgress, recordResult, selectNextQuestion };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PracticeState;
