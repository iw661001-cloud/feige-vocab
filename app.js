const appEl = document.getElementById("app");
const progressText = document.getElementById("progressText");
const scoreText = document.getElementById("scoreText");
const posScoreText = document.getElementById("posScoreText");

const SESSION_LENGTH = 15;

const POS_NAMES = {
  "名": "名詞", "動": "動詞", "形": "形容詞", "副": "副詞",
  "介": "介系詞", "代": "代名詞", "連": "連接詞", "助": "助動詞", "片": "片語",
  "感": "感嘆詞", "句": "句子",
};

const SEMESTERS = {
  "上": { label: "上學期", file: "data/vocab-上學期.json" },
  "下": { label: "下學期", file: "data/vocab-下學期.json" },
};

// 詞性點選題只用這幾個核心詞性當選項；片語沒有單一詞性，不出詞性題（見 buildBlankPlan 呼叫端的判斷）
const POS_QUIZ_OPTIONS = ["名", "動", "形", "副", "介", "代", "連", "助", "感"];

function posLabel(pos) {
  if (!pos) return "";
  return pos.split(":").map((p) => POS_NAMES[p] || p).join("/");
}

let allEntries = [];
let sessionQueue = [];
let sessionPos = 0;
let correctCount = 0;
let wrongCount = 0;
let posCorrectCount = 0;
let posWrongCount = 0;
let currentEntry = null;
let currentInputs = []; // flat ordered list of <input> elements for the current question
let currentPosRequired = false; // 這一題要不要先答詞性才能拼字
let currentPosAnswered = false;
let currentPosCorrect = null; // true/false=已作答的詞性對錯，null=這題沒有考詞性
let sessionResults = []; // 本場次每題結果，session結束時同步雲端用

// ---- 使用者姓名（同步練習成果到雲端，讓家長儀表板能區分是誰練習的） ----
const NAME_KEY = "feige-vocab-name";
let currentName = localStorage.getItem(NAME_KEY) || null;

// ---- 學期（上學期／下學期各自獨立題庫與成績統計） ----
const SEMESTER_KEY = "feige-vocab-semester";
let currentSemester = localStorage.getItem(SEMESTER_KEY) || null;

function sanitizeId(text) {
  return text.replace(/[\/#?.]/g, "-");
}

function entryKey(entry) {
  return sanitizeId(`${currentSemester}__${entry.version}__${entry.lesson}__${entry.quizWord}`);
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
    ensureSemesterThenStart();
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

function initSemesterUI() {
  const semesterModal = document.getElementById("semesterModal");

  document.getElementById("switchSemesterBtn").addEventListener("click", () => {
    semesterModal.style.display = "flex";
  });
  document.getElementById("semesterUpBtn").addEventListener("click", () => selectSemester("上"));
  document.getElementById("semesterDownBtn").addEventListener("click", () => selectSemester("下"));
}

function selectSemester(semester) {
  currentSemester = semester;
  localStorage.setItem(SEMESTER_KEY, semester);
  document.getElementById("semesterModal").style.display = "none";
  updateSemesterDisplay();
  loadVocabAndStart();
}

function updateSemesterDisplay() {
  const el = document.getElementById("semesterDisplay");
  el.textContent = currentSemester ? SEMESTERS[currentSemester].label : "";
}

// 姓名確認後才問學期：同一個人可能上下學期都要複習，姓名優先讓儀表板認得人
function ensureSemesterThenStart() {
  if (currentSemester) {
    updateSemesterDisplay();
    loadVocabAndStart();
  } else {
    document.getElementById("semesterModal").style.display = "flex";
  }
}

function loadVocabAndStart() {
  fetch(SEMESTERS[currentSemester].file)
    .then((res) => res.json())
    .then((data) => {
      allEntries = data;
      startSession();
    });
}

function init() {
  initNameUI();
  initSemesterUI();
  if (currentName) {
    ensureSemesterThenStart();
  }
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
  posCorrectCount = 0;
  posWrongCount = 0;
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

// 字首字尾一律要輸入，不再直接顯示在格子裡；「提醒」改成顯示在格子上方的提示列，
// 目的一樣是限縮同義字/片語範圍，但使用者反映原本頭尾直接顯示等於沒有完整拼過整個字。
// 1個字母：不提示（提示等於直接公布答案）
// 2個字母：只提示第一個字母
// 3個字母以上：頭尾都提示
function wordToLetters(text, revealEnds) {
  const chars = text.split("");
  const alphaIdx = [];
  chars.forEach((c, i) => { if (/[a-zA-Z]/.test(c)) alphaIdx.push(i); });
  const first = alphaIdx[0];
  const last = alphaIdx[alphaIdx.length - 1];
  const alphaCount = alphaIdx.length;
  return chars.map((c, i) => {
    if (!/[a-zA-Z]/.test(c)) return { char: c, input: false, hint: false };
    const lower = c.toLowerCase();
    if (!revealEnds || alphaCount <= 1) return { char: lower, input: true, hint: false };
    if (alphaCount === 2) return { char: lower, input: true, hint: i === first };
    return { char: lower, input: true, hint: i === first || i === last };
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
  scoreText.textContent = `拼字 對${correctCount}・錯${wrongCount}`;
  posScoreText.textContent = `詞性 對${posCorrectCount}・錯${posWrongCount}`;

  currentEntry = sessionQueue[sessionPos];
  const segments = buildBlankPlan(currentEntry);
  currentInputs = [];

  // 片語沒有單一詞性，不出詞性題；其餘只要有標詞性就先考詞性，答對/答錯才能繼續拼字
  currentPosRequired = currentEntry.type !== "phrase" && !!currentEntry.pos;
  currentPosAnswered = !currentPosRequired;
  currentPosCorrect = null;

  // 詞性要考的題目不能在徽章先爆雷答案，只有不考詞性的題目（片語、無標詞性）才照樣顯示
  const metaBadges = [
    `<span class="meta-badge">${SEMESTERS[currentSemester].label}</span>`,
    `<span class="meta-badge">${currentEntry.version}</span>`,
    `<span class="meta-badge">第${currentEntry.lesson}課</span>`,
    (!currentPosRequired && currentEntry.pos) ? `<span class="meta-badge">${posLabel(currentEntry.pos)}</span>` : "",
  ].join("");

  const posRowHtml = currentPosRequired
    ? `<div class="pos-row" id="posRow">${POS_QUIZ_OPTIONS.map((p) =>
        `<button class="pos-btn" data-pos="${p}">${POS_NAMES[p]}</button>`
      ).join("")}</div>`
    : "";

  const blankHtml = segments.map((seg) => {
    if (seg.kind === "space") return `<div class="segment-col"><div class="hint-row"></div><span class="space-gap"></span></div>`;
    if (seg.kind === "ellipsis") return `<div class="segment-col"><div class="hint-row"></div><span class="ellipsis-static">...</span></div>`;
    if (seg.kind === "slash") return `<div class="segment-col"><div class="hint-row"></div><span class="dual-slash">/</span></div>`;
    // word：提示列與輸入格上下對齊，同一個字母的提示字元要對到同一格
    const hintCells = seg.letters.map((letter) =>
      `<span class="hint-cell">${letter.hint ? letter.char : ""}</span>`
    ).join("");
    const cells = seg.letters.map((letter) => {
      if (!letter.input) {
        return `<div class="letter-box static">${letter.char}</div>`;
      }
      return `<input class="letter-box" maxlength="1" data-answer="${letter.char}" autocomplete="off" autocapitalize="off" spellcheck="false">`;
    }).join("");
    return `<div class="segment-col"><div class="hint-row">${hintCells}</div><div class="blank-group">${cells}</div></div>`;
  }).join("");

  appEl.innerHTML = `
    <div class="quiz-card">
      <div class="meta-row">${metaBadges}</div>
      <div class="chinese-meaning">${currentEntry.chinese}</div>
      ${posRowHtml}
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

  if (currentPosRequired) {
    // 先答詞性，答完才能拼字：拼字格先鎖住，避免同時作答混在一起計分
    currentInputs.forEach((input) => { input.disabled = true; });
    appEl.querySelectorAll(".pos-btn").forEach((btn) => {
      btn.addEventListener("click", () => onPosChoice(btn));
    });
  } else if (currentInputs.length > 0) {
    currentInputs[0].focus();
  }

  document.getElementById("skipBtn").addEventListener("click", skipQuestion);
}

function onPosChoice(btn) {
  if (currentPosAnswered) return; // 已經答過鎖住了，不能再改
  const chosen = btn.dataset.pos;
  const validPos = currentEntry.pos.split(":");
  const isCorrect = validPos.includes(chosen);

  currentPosAnswered = true;
  appEl.querySelectorAll(".pos-btn").forEach((b) => {
    b.disabled = true;
    if (validPos.includes(b.dataset.pos)) b.classList.add("correct");
    else if (b === btn) b.classList.add("wrong");
  });

  currentPosCorrect = isCorrect;
  if (isCorrect) posCorrectCount++;
  else posWrongCount++;
  posScoreText.textContent = `詞性 對${posCorrectCount}・錯${posWrongCount}`;

  currentInputs.forEach((input) => { input.disabled = false; });
  if (currentInputs.length > 0) currentInputs[0].focus();
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
  sessionResults.push({ entry: currentEntry, correct, posCorrect: currentPosCorrect });
  if (correct) {
    correctCount++;
    const phrase = CELEBRATE_PHRASES[Math.floor(Math.random() * CELEBRATE_PHRASES.length)];
    document.getElementById("feedbackBanner").innerHTML = `<span class="celebrate">🎉 ${phrase}</span>`;
  } else {
    wrongCount++;
  }
  scoreText.textContent = `拼字 對${correctCount}・錯${wrongCount}`;
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
  // 詞性還沒作答就跳過，也算詞性答錯，並公布正確詞性
  if (currentPosRequired && !currentPosAnswered) {
    currentPosAnswered = true;
    currentPosCorrect = false;
    posWrongCount++;
    posScoreText.textContent = `詞性 對${posCorrectCount}・錯${posWrongCount}`;
    const validPos = currentEntry.pos.split(":");
    appEl.querySelectorAll(".pos-btn").forEach((b) => {
      b.disabled = true;
      if (validPos.includes(b.dataset.pos)) b.classList.add("correct");
    });
  }
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
    semester: currentSemester,
    correctCount,
    wrongCount,
    posCorrectCount,
    posWrongCount,
    completedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });

  sessionResults.forEach(({ entry, correct, posCorrect }) => {
    const wordRef = studentRef.collection("words").doc(entryKey(entry));
    const update = {
      word: entry.quizWord,
      semester: currentSemester,
      version: entry.version,
      lesson: entry.lesson,
      chinese: entry.chinese,
      attempts: firebase.firestore.FieldValue.increment(1),
      correctCount: firebase.firestore.FieldValue.increment(correct ? 1 : 0),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (posCorrect !== null) {
      update.posAttempts = firebase.firestore.FieldValue.increment(1);
      update.posCorrectCount = firebase.firestore.FieldValue.increment(posCorrect ? 1 : 0);
    }
    wordRef.set(update, { merge: true });
  });
}

function renderResult() {
  syncSessionToCloud();

  const posSummary = (posCorrectCount + posWrongCount > 0)
    ? `<div class="score pos-score">詞性 對 ${posCorrectCount} 題・錯 ${posWrongCount} 題</div>`
    : "";

  appEl.innerHTML = `
    <div class="quiz-result">
      <div>練習完成！</div>
      <div class="score">拼字 對 ${correctCount} 題・錯 ${wrongCount} 題</div>
      ${posSummary}
      <button class="nav-btn" id="retryBtn">再練習一次</button>
    </div>
  `;
  progressText.textContent = "";
  scoreText.textContent = "";
  document.getElementById("retryBtn").addEventListener("click", startSession);
}

init();
