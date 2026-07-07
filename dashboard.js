const dashEl = document.getElementById("dashboard");

function loadDashboard() {
  dashEl.innerHTML = `<p class="empty-msg">載入中...</p>`;
  db.collection("feige_students").get().then((snap) => {
    const students = [];
    snap.forEach((d) => students.push({ id: d.id, ...d.data() }));
    return Promise.all(students.map(buildStudentSummary));
  }).then(renderDashboard);
}

function buildStudentSummary(student) {
  const ref = db.collection("feige_students").doc(student.id);
  return Promise.all([
    ref.collection("sessions").get(),
    ref.collection("words").get(),
  ]).then(([sessionsSnap, wordsSnap]) => {
    const dates = new Set();
    let totalSessions = 0;
    let lastActive = null;
    let totalCorrect = 0;
    let totalWrong = 0;
    sessionsSnap.forEach((doc) => {
      const data = doc.data();
      if (data.date) dates.add(data.date);
      totalSessions++;
      totalCorrect += data.correctCount || 0;
      totalWrong += data.wrongCount || 0;
      if (!lastActive || data.date > lastActive) lastActive = data.date;
    });

    let masteredCount = 0; // 累計答對次數 > 累計答錯次數的字，粗略視為已掌握
    wordsSnap.forEach((doc) => {
      const w = doc.data();
      if ((w.correctCount || 0) > 0 && (w.correctCount || 0) >= (w.attempts || 0) - (w.correctCount || 0)) {
        masteredCount++;
      }
    });

    return {
      name: student.name || student.id,
      practiceDays: dates.size,
      totalSessions,
      lastActive,
      totalCorrect,
      totalWrong,
      wordsSeen: wordsSnap.size,
      masteredCount,
    };
  });
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
      <div class="student-stats">
        練習天數：<strong>${s.practiceDays}</strong> 天　總場次：<strong>${s.totalSessions}</strong> 次<br>
        最近一次練習：${s.lastActive || "尚無紀錄"}<br>
        累計答對 <strong>${s.totalCorrect}</strong> 題・答錯 <strong>${s.totalWrong}</strong> 題<br>
        已練習過 <strong>${s.wordsSeen}</strong> 個不同單字/片語，其中約 <strong>${s.masteredCount}</strong> 個答對次數較多（掌握度較高）
      </div>
    </div>
  `).join("");
}

loadDashboard();
