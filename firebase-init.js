// 沿用 cheryl-vocab 同一個 Firebase 專案（免費額度足夠兩個網站共用），
// 用不同的 Firestore 集合名稱（feige_students）區隔資料，不需要另外申請專案。
const firebaseConfig = {
  apiKey: "AIzaSyCuxJj5Rx9oRbwMWuoM2HMd_lYnu91T6qA",
  authDomain: "cheryl-vocab.firebaseapp.com",
  projectId: "cheryl-vocab",
  storageBucket: "cheryl-vocab.firebasestorage.app",
  messagingSenderId: "161394045130",
  appId: "1:161394045130:web:db0461c02f3f8ef298c433",
  measurementId: "G-EXJ7MP94PM"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
