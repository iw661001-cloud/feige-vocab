const dashEl = document.getElementById("dashboard");

function loadDashboard() {
  dashEl.innerHTML = `<p class="empty-msg">載入中...</p>`;
  db.collection("feige_students").get().then((snap) => {
    const students = [];
    snap.forEach((d) => students.push({ id: d.id, ...d.data() }));
    return Promise.all(students.map(buildStudentSummary));
  }).then(renderDashboard);
}

const SEMESTER_LABELS = { "上": "上學期", "下": "下學期" };

// 舊資料（這次上下學期功能上線前）沒有 semester 欄位，當時只有下學期一個題庫，
// 一律歸為下學期，避免舊成績在儀表板上憑空消失。
function normalizeSemester(semester) {
  return semester === "上" ? "上" : "下";
}

function emptySemesterSummary() {
  return {
    practiceDays: 0,
    totalSessions: 0,
    lastActive: null,
    totalCorrect: 0,
    totalWrong: 0,
    wordsSeen: 0,
    masteredCount: 0,
  };
}

function buildStudentSummary(student) {
  const ref = db.collection("feige_students").doc(student.id);
  return Promise.all([
    ref.collection("sessions").get(),
    ref.collection("words").get(),
  ]).then(([sessionsSnap, wordsSnap]) => {
    const bySemester = { "上": emptySemesterSummary(), "下": emptySemesterSummary() };
    const datesBySemester = { "上": new Set(), "下": new Set() };

    sessionsSnap.forEach((doc) => {
      const data = doc.data();
      const sem = normalizeSemester(data.semester);
      const summary = bySemester[sem];
      if (data.date) datesBySemester[sem].add(data.date);
      summary.totalSessions++;
      summary.totalCorrect += data.correctCount || 0;
      summary.totalWrong += data.wrongCount || 0;
      if (!summary.lastActive || data.date > summary.lastActive) summary.lastActive = data.date;
    });

    wordsSnap.forEach((doc) => {
      const w = doc.data();
      const sem = normalizeSemester(w.semester);
      const summary = bySemester[sem];
      summary.wordsSeen++;
      // 累計答對次數 > 累計答錯次數的字，粗略視為已掌握
      if ((w.correctCount || 0) > 0 && (w.correctCount || 0) >= (w.attempts || 0) - (w.correctCount || 0)) {
        summary.masteredCount++;
      }
    });

    bySemester["上"].practiceDays = datesBySemester["上"].size;
    bySemester["下"].practiceDays = datesBySemester["下"].size;

    return {
      name: student.name || student.id,
      bySemester,
      lastActive: [bySemester["上"].lastActive, bySemester["下"].lastActive].filter(Boolean).sort().pop() || null,
    };
  });
}

function renderSemesterBlock(label, s) {
  if (s.totalSessions === 0) {
    return `
      <div class="semester-block">
        <div class="semester-title">${label}</div>
        <div class="empty-msg-inline">尚無練習紀錄</div>
      </div>
    `;
  }
  return `
    <div class="semester-block">
      <div class="semester-title">${label}</div>
      <div class="student-stats">
        練習天數：<strong>${s.practiceDays}</strong> 天　總場次：<strong>${s.totalSessions}</strong> 次<br>
        最近一次練習：${s.lastActive || "尚無紀錄"}<br>
        累計答對 <strong>${s.totalCorrect}</strong> 題・答錯 <strong>${s.totalWrong}</strong> 題<br>
        已練習過 <strong>${s.wordsSeen}</strong> 個不同單字/片語，其中約 <strong>${s.masteredCount}</strong> 個答對次數較多（掌握度較高）
      </div>
    </div>
  `;
}

function renderDashboard(summaries) {
  if (summaries.length === 0) {
    dashEl.innerHTML = `<p class="empty-msg">目前還沒有人開始練習，等有人選擇姓名並完成第一次測驗後，這裡就會出現資料。</p>`;
    return;
  }
  summaries.sort((a, b) => (b.lastActive || "").localeCompare(a.lastActive || ""));

  dashEl.innerHTML = summaries.map((s) => `
    <div class="student-card">
      <div class="student-name">${s.name}</div>
      ${renderSemesterBlock("上學期", s.bySemester["上"])}
      ${renderSemesterBlock("下學期", s.bySemester["下"])}
    </div>
  `).join("");
}

loadDashboard();
