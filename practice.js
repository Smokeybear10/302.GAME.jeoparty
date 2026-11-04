'use strict';

const PRACTICE_STORAGE_KEY = 'jeopardy_practice_v1';
const practiceElements = {
  topics: document.querySelector('#topic-options'),
  reviewOnly: document.querySelector('#review-only'),
  question: document.querySelector('#question-area'),
  studied: document.querySelector('#studied-count'),
  review: document.querySelector('#review-count'),
  saveNote: document.querySelector('#save-note'),
  status: document.querySelector('#practice-status'),
};
let savedPractice = null;
let storageAvailable = true;
let storedPractice = null;
try {
  storedPractice = localStorage.getItem(PRACTICE_STORAGE_KEY);
} catch {
  storageAvailable = false;
}
if (storedPractice) {
  try {
    savedPractice = JSON.parse(storedPractice);
  } catch {
    savedPractice = null;
  }
}
let practiceProgress = PracticeState.normalizeProgress(savedPractice, PRACTICE_QUESTIONS);
let practiceQuestion = null;
let practiceRevealed = false;
let seenPracticeIds = [];

function practiceEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function savePractice() {
  try {
    localStorage.setItem(PRACTICE_STORAGE_KEY, JSON.stringify(practiceProgress));
    storageAvailable = true;
  } catch {
    storageAvailable = false;
  }
  renderPracticeProgress();
}

function renderPracticeProgress() {
  const records = Object.values(practiceProgress.records);
  practiceElements.studied.textContent = records.filter((record) => record.attempts > 0).length;
  practiceElements.review.textContent = records.filter((record) => record.needsReview).length;
  practiceElements.saveNote.textContent = storageAvailable
    ? 'Progress saves in this browser.'
    : 'Browser storage is unavailable. Your progress will last only for this visit.';
  practiceElements.saveNote.classList.toggle('is-warning', !storageAvailable);
}

function syncPracticeOptions() {
  practiceElements.topics.querySelectorAll('input').forEach((input) => {
    input.checked = practiceProgress.selectedTopics.includes(input.value);
  });
  practiceElements.reviewOnly.checked = practiceProgress.reviewOnly;
  const selectedCount = practiceProgress.selectedTopics.length;
  document.querySelector('#topic-selection-count').textContent = selectedCount === PRACTICE_TOPICS.length
    ? `All ${selectedCount}` : `${selectedCount} selected`;
}

function focusPracticeHeading(selector) {
  const heading = practiceElements.question.querySelector(selector);
  heading?.focus({ preventScroll: true });
  heading?.scrollIntoView({ block: 'start' });
}

function renderPracticeQuestion({ focus = false } = {}) {
  if (!practiceQuestion) {
    const noTopics = practiceProgress.selectedTopics.length === 0;
    const hasOtherReviews = Object.values(practiceProgress.records).some((record) => record.needsReview);
    const title = noTopics ? 'Choose a topic to keep going.'
      : hasOtherReviews ? 'No reviews in these topics.' : 'You’re caught up.';
    const description = noTopics ? 'Check any topics, or include them all for a mix.'
      : hasOtherReviews ? 'Include all topics to see the other questions you saved.'
        : 'Questions you mark “Review again” will appear here. Keep practicing to find something new.';
    practiceElements.question.innerHTML = `<div class="empty-state">
      <h2 tabindex="-1">${title}</h2><p>${description}</p>
      <button class="button button-primary" type="button" data-practice-action="${noTopics || hasOtherReviews ? 'all-topics' : 'mixed'}">${noTopics || hasOtherReviews ? 'Include all topics' : 'Back to practice'}</button>
    </div>`;
  } else {
    const question = practiceQuestion;
    const topic = PRACTICE_TOPICS.find((item) => item.id === question.topic);
    practiceElements.question.innerHTML = `
      <p class="question-meta">
        <span>${practiceEscape(topic.label)}${practiceProgress.reviewOnly ? ' · Review' : ''}</span>
        <strong class="question-points">${question.points.toLocaleString()} points</strong>
      </p>
      <h2 id="practice-question-title" tabindex="-1">${practiceEscape(question.question)}</h2>
      <details class="question-hint"><summary>Hint</summary><p>${practiceEscape(question.hint)}</p></details>
      <div class="question-actions" id="reveal-actions">
        <button class="button button-primary" type="button" data-practice-action="reveal">Show answer</button>
        <button class="text-button" type="button" data-practice-action="skip">Skip</button>
      </div>
      <section class="answer-section" id="practice-answer" aria-labelledby="practice-answer-title" hidden>
        <p class="answer-label">Answer</p>
        <h3 id="practice-answer-title" tabindex="-1">${practiceEscape(question.answer)}</h3>
        <p class="answer-explanation">${practiceEscape(question.explanation)}</p>
        ${question.source?.url?.startsWith('https://') ? `<a class="answer-source" href="${practiceEscape(question.source.url)}" target="_blank" rel="noopener noreferrer">${practiceEscape(question.source.label)} ↗</a>` : ''}
        <p class="answer-rating">How did you do?</p>
        <div class="question-actions">
          <button class="button button-primary" type="button" data-practice-action="known">Got it</button>
          <button class="button" type="button" data-practice-action="review">Review again</button>
        </div>
      </section>`;
  }
  if (focus) focusPracticeHeading('h2');
}

function nextPracticeQuestion({ focus = false } = {}) {
  const currentId = practiceQuestion?.id;
  practiceQuestion = PracticeState.selectNextQuestion(PRACTICE_QUESTIONS, practiceProgress, {
    seenIds: seenPracticeIds, currentId,
  });
  practiceRevealed = false;
  if (practiceQuestion) {
    if (seenPracticeIds.includes(practiceQuestion.id)) seenPracticeIds = [];
    seenPracticeIds.push(practiceQuestion.id);
  }
  renderPracticeQuestion({ focus });
}

function changePracticeOptions({ selectedTopics = practiceProgress.selectedTopics, reviewOnly = practiceProgress.reviewOnly }, { focus = false } = {}) {
  practiceProgress = { ...practiceProgress, selectedTopics, reviewOnly };
  syncPracticeOptions();
  savePractice();
  nextPracticeQuestion({ focus });
}

practiceElements.topics.innerHTML = PRACTICE_TOPICS.map((topic) => `
  <label class="topic-option"><input type="checkbox" value="${topic.id}"><span>${practiceEscape(topic.label)}</span></label>
`).join('');
practiceElements.topics.addEventListener('change', () => {
  changePracticeOptions({ selectedTopics: [...practiceElements.topics.querySelectorAll('input:checked')].map((input) => input.value) });
});
practiceElements.reviewOnly.addEventListener('change', () => {
  changePracticeOptions({ reviewOnly: practiceElements.reviewOnly.checked });
});
document.querySelector('#select-all').addEventListener('click', () => {
  changePracticeOptions({ selectedTopics: PRACTICE_TOPICS.map((topic) => topic.id) });
});
document.querySelector('#select-none').addEventListener('click', () => {
  changePracticeOptions({ selectedTopics: [] });
});
practiceElements.question.addEventListener('click', (event) => {
  const target = event.target.closest('[data-practice-action]');
  if (!target) return;
  const action = target.dataset.practiceAction;
  if (action === 'all-topics') {
    changePracticeOptions({ selectedTopics: PRACTICE_TOPICS.map((topic) => topic.id) }, { focus: true });
    return;
  }
  if (action === 'mixed') {
    changePracticeOptions({ reviewOnly: false }, { focus: true });
    return;
  }
  if (!practiceQuestion) return;
  if (action === 'reveal') {
    practiceRevealed = true;
    practiceElements.question.querySelector('#reveal-actions').hidden = true;
    practiceElements.question.querySelector('#practice-answer').hidden = false;
    focusPracticeHeading('#practice-answer-title');
    practiceElements.status.textContent = `Answer: ${practiceQuestion.answer}. ${practiceQuestion.explanation}`;
  } else if (action === 'skip') {
    nextPracticeQuestion({ focus: true });
    practiceElements.status.textContent = 'Skipped. Progress unchanged.';
  } else if ((action === 'known' || action === 'review') && practiceRevealed) {
    practiceProgress = PracticeState.recordResult(practiceProgress, practiceQuestion.id, action === 'known');
    savePractice();
    practiceElements.status.textContent = action === 'known' ? 'Marked as learned. Next question.' : 'Saved to review. Next question.';
    nextPracticeQuestion({ focus: true });
  }
});

window.addEventListener('storage', (event) => {
  if (event.key !== PRACTICE_STORAGE_KEY) return;
  try {
    practiceProgress = PracticeState.normalizeProgress(JSON.parse(event.newValue || 'null'), PRACTICE_QUESTIONS);
  } catch {
    return;
  }
  syncPracticeOptions();
  renderPracticeProgress();
  if (!practiceQuestion || !practiceProgress.selectedTopics.includes(practiceQuestion.topic)
    || (practiceProgress.reviewOnly && !practiceProgress.records[practiceQuestion.id]?.needsReview)) {
    nextPracticeQuestion();
  }
});

syncPracticeOptions();
const practiceMobileLayout = window.matchMedia('(max-width: 760px)');
const practiceFilters = document.querySelector('#topic-filters');
practiceFilters.open = !practiceMobileLayout.matches;
practiceMobileLayout.addEventListener('change', (event) => {
  practiceFilters.open = !event.matches;
});
renderPracticeProgress();
nextPracticeQuestion();
