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
let sessionResults = []; // 本場次每題結果，session結束時同步雲端用

// ---- 使用者姓名（同步練習成果到雲端，讓家長儀表板能區分是誰練習的） ----
const NAME_KEY = "feige-vocab-name";
let currentName = localStorage.getItem(NAME_KEY) || null;

function sanitizeId(text) {
  return text.replace(/[\/#?.]/g, "-");
}

function entryKey(entry) {
  return sanitizeId(`${entry.version}__${entry.lesson}__${entry.quizWord}`);
}

function initNameUI() {
  const nameModal = document.getElementById("nameModal");
  const nameInput = document.getElementById("nameInput");

  document.getElementById("switchNameBtn").addEventListener("click", () => {
    nameInput.value = currentName || "";
    nameModal.style.display = "flex";
  });
  document.getElementById("nameConfirmBtn").addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) return;
    currentName = name;
    localStorage.setItem(NAME_KEY, name);
    db.collection("feige_students").doc(sanitizeId(name)).set({
      name,
      lastActiveAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    nameModal.style.display = "none";
    updateNameDisplay();
  });

  db.collection("feige_students").get().then((snap) => {
    const datalist = document.getElementById("nameOptions");
    snap.forEach((doc) => {
      const opt = document.createElement("option");
      opt.value = doc.data().name || doc.id;
      datalist.appendChild(opt);
    });
  });

  if (!currentName) {
    nameModal.style.display = "flex";
  } else {
    updateNameDisplay();
  }
}

function updateNameDisplay() {
  document.getElementById("nameDisplay").textContent = currentName ? `使用者：${currentName}` : "";
}

function init() {
  initNameUI();
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
  sessionResults = [];
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

// 頭尾字母提示不能讓整個字都露出來（等於沒考），所以依字母數調整：
// 1個字母：整個當輸入格（不顯示）
// 2個字母：只顯示第一個字母，第二個字母也要輸入
// 3個字母以上：頭尾都顯示，中間逐字母輸入
function wordToLetters(text, revealEnds) {
  const chars = text.split("");
  const alphaIdx = [];
  chars.forEach((c, i) => { if (/[a-zA-Z]/.test(c)) alphaIdx.push(i); });
  const first = alphaIdx[0];
  const last = alphaIdx[alphaIdx.length - 1];
  const alphaCount = alphaIdx.length;
  return chars.map((c, i) => {
    if (!/[a-zA-Z]/.test(c)) return { char: c, input: false };
    if (!revealEnds) return { char: c.toLowerCase(), input: true };
    if (alphaCount <= 1) return { char: c.toLowerCase(), input: true };
    if (alphaCount === 2) {
      if (i === first) return { char: c, input: false };
      return { char: c.toLowerCase(), input: true };
    }
    if (i === first || i === last) return { char: c, input: false };
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

// 頭尾字母提示的目的是限縮同義字/片語範圍（不只是方便拼字），
// 所以 clean／phrase／dual 都統一套用「每個字頭尾顯示、中間逐字母輸入」的規則。
function buildBlankPlan(entry) {
  const word = entry.quizWord;
  if (entry.type === "dual") {
    const slashIdx = word.indexOf("/");
    const left = word.slice(0, slashIdx);
    const right = word.slice(slashIdx + 1);
    return [
      ...buildPhraseSegments(left, true),
      { kind: "slash" },
      ...buildPhraseSegments(right, true),
    ];
  }
  return buildPhraseSegments(word, true);
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
  sessionResults.push({ entry: currentEntry, correct });
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

// 場次結束時同步這場的成績與每個字的對錯次數到雲端，讓家長儀表板看得到
function syncSessionToCloud() {
  if (!currentName) return;
  const today = new Date().toISOString().slice(0, 10);
  const studentRef = db.collection("feige_students").doc(sanitizeId(currentName));

  studentRef.set({
    name: currentName,
    lastActiveAt: firebase.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  studentRef.collection("sessions").add({
    date: today,
    correctCount,
    wrongCount,
    completedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });

  sessionResults.forEach(({ entry, correct }) => {
    const wordRef = studentRef.collection("words").doc(entryKey(entry));
    wordRef.set({
      word: entry.quizWord,
      version: entry.version,
      lesson: entry.lesson,
      chinese: entry.chinese,
      attempts: firebase.firestore.FieldValue.increment(1),
      correctCount: firebase.firestore.FieldValue.increment(correct ? 1 : 0),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

function renderResult() {
  syncSessionToCloud();

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
