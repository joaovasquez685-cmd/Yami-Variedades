// firebase-sync.js — conecta la tienda con Firebase (productos y catálogos en Firestore, login con Auth).
// Se carga DESPUÉS del script principal del index.html:
//   <script type="module" src="firebase-sync.js"></script>
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore, collection, getDocs, doc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyA1qSCv1T0Z3gjJ6BFDWGXOr-SIKnPNAx0",
  authDomain: "yami-variedades.firebaseapp.com",
  projectId: "yami-variedades",
  storageBucket: "yami-variedades.firebasestorage.app",
  messagingSenderId: "222752961052",
  appId: "1:222752961052:web:a547346c0610f54023a5d9"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const clone = v => JSON.parse(JSON.stringify(v));
const cache = { products: [], catalogs: [] };
const SYNCED = ['products', 'catalogs'];

// --- Reemplaza el almacenamiento de productos y catálogos (lo demás sigue igual) ---
const origGet = DB.get.bind(DB);
const origSet = DB.set.bind(DB);

DB.get = key => SYNCED.includes(key) ? clone(cache[key]) : origGet(key);

DB.set = (key, value) => {
  if (!SYNCED.includes(key)) return origSet(key, value);
  if (!auth.currentUser) {
    showNotification('Tu sesión de administradora venció. Vuelve a entrar.', 'error');
    return false;
  }
  saveCollection(key, value);
  return true;
};

function saveCollection(key, arr) {
  const items = clone(arr).map(x => key === 'catalogs' ? { ...x, file: x.file || catalogFileName(x) } : x);
  const prev = new Map(cache[key].map(x => [String(x.id), JSON.stringify(x)]));
  const ops = [];
  items.forEach(x => {
    if (prev.get(String(x.id)) !== JSON.stringify(x)) ops.push(setDoc(doc(db, key, String(x.id)), x));
    prev.delete(String(x.id));
  });
  prev.forEach((_, id) => ops.push(deleteDoc(doc(db, key, id))));
  cache[key] = items;
  Promise.all(ops).catch(err => {
    console.error(err);
    showNotification('No se pudo guardar en Firebase. Revisa las reglas o tu conexión.', 'error');
  });
}

async function loadAll() {
  for (const key of SYNCED) {
    const snap = await getDocs(collection(db, key));
    cache[key] = snap.docs.map(d => d.data()).sort((a, b) => a.id - b.id);
  }
}

function rerender() {
  try {
    syncCartWithProducts();
    renderFeaturedProducts();
    updateCartUI();
    if (document.getElementById('public-shop').classList.contains('active')) renderPublicProducts();
    if (document.getElementById('public-catalog').classList.contains('active')) renderPublicCatalog();
  } catch (e) { console.error(e); }
}

// --- Login real con Firebase (ya no usa la contraseña escrita en el código) ---
const userInput = document.getElementById('loginUser');
userInput.placeholder = 'Correo';
userInput.type = 'email';

window.doLogin = async function () {
  const email = userInput.value.trim();
  const pass = document.getElementById('loginPass').value;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    showNotification('Correo o contraseña incorrectos', 'error');
    return;
  }
  closeLoginModal();
  document.getElementById('publicView').style.display = 'none';
  document.getElementById('adminView').style.display = 'block';
  await migrateIfEmpty();
  updateDashboard();
  showNotification('Bienvenida al panel de administración', 'success');
};

window.doLogout = async function () {
  try { await signOut(auth); } catch (e) { /* sin acción */ }
  document.getElementById('adminView').style.display = 'none';
  document.getElementById('publicView').style.display = 'block';
  rerender();
  showNotification('Sesión cerrada', 'info');
};

// Primera vez: si Firebase está vacío, ofrece subir lo que ya tienes en este navegador
async function migrateIfEmpty() {
  if (cache.products.length || cache.catalogs.length) return;
  let lp = [], lc = [];
  try {
    lp = JSON.parse(localStorage.getItem('yami_products') || '[]');
    lc = JSON.parse(localStorage.getItem('yami_catalogs') || '[]');
  } catch (e) { /* sin datos locales */ }
  if (!lp.length && !lc.length) return;
  if (!confirm(`Firebase está vacío. ¿Subir los ${lp.length} productos y ${lc.length} catálogos que tienes en este navegador?`)) return;
  saveCollection('products', lp);
  saveCollection('catalogs', lc);
  showNotification('Productos y catálogos subidos a Firebase', 'success');
}

// --- Catálogos PDF: se suben solos a Cloudinary ---
const CLOUD_NAME = 'wbyobblr';
const CLOUD_PRESET = 'catálogos';
const MAX_PDF_MB_CLOUD = 10; // límite del plan gratis de Cloudinary

window.saveCatalog = async function () {
  const name = document.getElementById('catalogName').value.trim();
  const desc = document.getElementById('catalogDesc').value.trim();
  const file = currentCatalogFile;
  if (!name || !file) { showNotification('Completa el nombre y sube un PDF', 'error'); return; }
  if (file.size > MAX_PDF_MB_CLOUD * 1048576) {
    showNotification(`El PDF pesa más de ${MAX_PDF_MB_CLOUD} MB. Comprímelo e inténtalo de nuevo.`, 'error');
    return;
  }
  if (!auth.currentUser) { showNotification('Tu sesión venció. Vuelve a entrar.', 'error'); return; }
  showNotification('Subiendo PDF, espera un momento...', 'info');
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', CLOUD_PRESET);
    const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`, { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok || !j.secure_url) throw new Error((j.error && j.error.message) || 'respuesta inválida');
    const cats = DB.get('catalogs');
    const id = cats.length ? Math.max(...cats.map(c => c.id)) + 1 : 1;
    cats.push({ id, name, desc, size: file.size, date: new Date().toISOString(), file: j.secure_url });
    DB.set('catalogs', cats);
    closeCatalogModal();
    renderAdminCatalog();
    showNotification('Catálogo subido correctamente', 'success');
  } catch (err) {
    console.error(err);
    showNotification('No se pudo subir el PDF: ' + err.message, 'error');
  }
};

// El botón Publicar ya no hace falta: todo es automático
window.openPublishModal = function () {
  document.getElementById('publishContent').innerHTML = `
    <div style="background:#e0ffe0; border-radius:12px; padding:15px;">
      <p style="font-weight:600;">✅ Todo es automático</p>
      <p style="font-size:0.9rem; margin-top:6px;">Productos, fotos y catálogos PDF se guardan solos. Tus clientes los ven al recargar la tienda. No tienes que subir nada a GitHub.</p>
    </div>`;
  document.getElementById('publishModal').classList.add('active');
};

// --- Arranque ---
loadAll().then(rerender).catch(err => {
  console.error(err);
  showNotification('No se pudo conectar con Firebase', 'error');
});
