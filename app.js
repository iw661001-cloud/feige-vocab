const appEl = document.getElementById("app");
const progressText = document.getElementById("progressText");
const scoreText = document.getElementById("scoreText");

const SESSION_LENGTH = 15;

const POS_NAMES = {
  "名": "名詞", "動": "動詞", "形": "形容詞", "副": "副詞",
  "介": "介系詞", "代": "代名詞", "連": "連接詞", "助": "助動詞", "片": "片語",
};

function posLabel(pos) {
  if (!pos) return "";
  return pos.split(":").map((p) => POS_NAMES[p] || p).join("/");
}

let allEntries = [];
let sessionQueue = [];
let sessionPos = 0;
let correctCount = 0;
let wrongCount = 0;
let currentEntry = null;
let currentInputs = []; // flat ordered list of <input> elements for the current question

function init() {
  fetch("data/vocab.json")
    .then((res) => res.json())
    .then((data) => {
      allEntries = data;
      startSession();
    });
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startSession() {
  sessionQueue = shuffle(allEntries).slice(0, SESSION_LENGTH);
  sessionPos = 0;
  correctCount = 0;
  wrongCount = 0;
  renderQuestion();
}

// ================= 空格拆解邏輯 =================
// 三種詞條類型的填空規則：
// clean（單一乾淨單字）：第一個和最後一個字母顯示，中間逐字母輸入
// phrase（片語，多個字／含刪節號...）：每個字全部逐字母輸入，不顯示頭尾，保留空格與「...」原樣
// dual（word1/word2 並列，如 hold/held）：兩種形式都用 phrase 規則個別處理，中間用「/」隔開

function splitEllipsis(token) {
  const parts = token.split("...");
  const result = [];
  parts.forEach((p, i) => {
    if (p) result.push({ kind: "word", text: p });
    if (i < parts.length - 1) result.push({ kind: "ellipsis" });
  });
  return result;
}

function wordToLetters(text, revealEnds) {
  const chars = text.split("");
  const alphaIdx = [];
  chars.forEach((c, i) => { if (/[a-zA-Z]/.test(c)) alphaIdx.push(i); });
  const first = alphaIdx[0];
  const last = alphaIdx[alphaIdx.length - 1];
  return chars.map((c, i) => {
    if (!/[a-zA-Z]/.test(c)) return { char: c, input: false };
    if (revealEnds && (i === first || i === last)) return { char: c, input: false };
    return { char: c.toLowerCase(), input: true };
  });
}

function buildPhraseSegments(str, revealEnds) {
  const tokens = str.split(" ");
  const segments = [];
  tokens.forEach((token, ti) => {
    if (ti > 0) segments.push({ kind: "space" });
    splitEllipsis(token).forEach((part) => {
      if (part.kind === "ellipsis") segments.push({ kind: "ellipsis" });
      else segments.push({ kind: "word", letters: wordToLetters(part.text, revealEnds) });
    });
  });
  return segments;
}

function buildBlankPlan(entry) {
  const word = entry.quizWord;
  if (entry.type === "dual") {
    const slashIdx = word.indexOf("/");
    const left = word.slice(0, slashIdx);
    const right = word.slice(slashIdx + 1);
    return [
      ...buildPhraseSegments(left, false),
      { kind: "slash" },
      ...buildPhraseSegments(right, false),
    ];
  }
  if (entry.type === "phrase") return buildPhraseSegments(word, false);
  return buildPhraseSegments(word, true); // clean
}

// ================= 出題與畫面 =================

function renderQuestion() {
  if (sessionPos >= SESSION_LENGTH) {
    renderResult();
    return;
  }
  progressText.textContent = `第 ${sessionPos + 1} / ${SESSION_LENGTH} 題`;
  scoreText.textContent = `對 ${correctCount}・錯 ${wrongCount}`;

  currentEntry = sessionQueue[sessionPos];
  const segments = buildBlankPlan(currentEntry);
  currentInputs = [];

  const metaBadges = [
    `<span class="meta-badge">${currentEntry.version}</span>`,
    `<span class="meta-badge">第${currentEntry.lesson}課</span>`,
    currentEntry.pos ? `<span class="meta-badge">${posLabel(currentEntry.pos)}</span>` : "",
  ].join("");

  const blankHtml = segments.map((seg) => {
    if (seg.kind === "space") return `<span class="space-gap"></span>`;
    if (seg.kind === "ellipsis") return `<span class="ellipsis-static">...</span>`;
    if (seg.kind === "slash") return `<span class="dual-slash">/</span>`;
    // word
    const cells = seg.letters.map((letter) => {
      if (!letter.input) {
        return `<div class="letter-box static">${letter.char}</div>`;
      }
      return `<input class="letter-box" maxlength="1" data-answer="${letter.char}" autocomplete="off" autocapitalize="off" spellcheck="false">`;
    }).join("");
    return `<div class="blank-group">${cells}</div>`;
  }).join("");

  appEl.innerHTML = `
    <div class="quiz-card">
      <div class="meta-row">${metaBadges}</div>
      <div class="chinese-meaning">${currentEntry.chinese}</div>
      <div class="blank-row">${blankHtml}</div>
      <div class="feedback-banner" id="feedbackBanner"></div>
      <div class="nav-row">
        <button class="nav-btn secondary" id="skipBtn">跳過這題</button>
      </div>
    </div>
  `;

  currentInputs = [...appEl.querySelectorAll(".letter-box[data-answer]")];
  currentInputs.forEach((input, idx) => {
    input.addEventListener("input", () => onLetterInput(input, idx));
  });
  if (currentInputs.length > 0) currentInputs[0].focus();

  document.getElementById("skipBtn").addEventListener("click", skipQuestion);
}

function onLetterInput(input, idx) {
  const typed = input.value.slice(-1);
  input.value = typed;
  if (!typed) return;

  const answer = input.dataset.answer;
  if (typed.toLowerCase() === answer.toLowerCase()) {
    input.classList.remove("wrong");
    input.classList.add("correct");
    input.disabled = true;
    const next = currentInputs[idx + 1];
    if (next) {
      next.focus();
    } else {
      finishQuestion(true);
    }
  } else {
    input.classList.add("wrong");
    setTimeout(() => {
      input.classList.remove("wrong");
      input.value = "";
    }, 500);
  }
}

const CELEBRATE_PHRASES = ["太棒了！", "答對了！", "拼寫正確！", "完全正確！"];

function finishQuestion(correct) {
  if (correct) {
    correctCount++;
    const phrase = CELEBRATE_PHRASES[Math.floor(Math.random() * CELEBRATE_PHRASES.length)];
    document.getElementById("feedbackBanner").innerHTML = `<span class="celebrate">🎉 ${phrase}</span>`;
  } else {
    wrongCount++;
  }
  scoreText.textContent = `對 ${correctCount}・錯 ${wrongCount}`;
  setTimeout(() => {
    sessionPos++;
    renderQuestion();
  }, 1100);
}

function skipQuestion() {
  // 顯示正確答案幾秒讓學生看一眼，再進下一題，算答錯一次
  currentInputs.forEach((input) => {
    input.value = input.dataset.answer;
    input.disabled = true;
    input.classList.add("wrong");
  });
  finishQuestion(false);
}

function renderResult() {
  appEl.innerHTML = `
    <div class="quiz-result">
      <div>練習完成！</div>
      <div class="score">對 ${correctCount} 題・錯 ${wrongCount} 題</div>
      <button class="nav-btn" id="retryBtn">再練習一次</button>
    </div>
  `;
  progressText.textContent = "";
  scoreText.textContent = "";
  document.getElementById("retryBtn").addEventListener("click", startSession);
}

init();
