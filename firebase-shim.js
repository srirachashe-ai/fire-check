// เชื่อมหน้าเว็บกับ Firebase (Firestore + Anonymous Auth) แทนระบบเก็บข้อมูลของ Claude
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { initializeFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot, query, where, orderBy, limit, writeBatch } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const ready = window.__fbResolve;
async function start() {
  const conf = window.FIREBASE_CONFIG;
  if (!conf || !conf.apiKey || String(conf.apiKey).includes('ใส่')) throw new Error('missing config');
  const app = initializeApp(conf);
  const auth = getAuth(app);
  const cred = await signInAnonymously(auth);
  const fs = initializeFirestore(app, { ignoreUndefinedProperties: true });

  const mapErr = e => ({ code: e && e.code === 'permission-denied' ? 'invalid_argument' : e && e.code === 'resource-exhausted' ? 'quota_exceeded' : 'unavailable', message: String(e && e.message || e) });
  const fail = e => { throw mapErr(e); };
  const sDoc = s => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: s.metadata });
  const sQ = s => ({ docs: s.docs.map(sDoc), size: s.size, empty: s.empty });
  const Q = q => ({
    where: (f, o, v) => Q(query(q, where(f, o, v))),
    orderBy: (f, d) => Q(query(q, orderBy(f, d || 'asc'))),
    limit: n => Q(query(q, limit(n))),
    get: () => getDocs(q).then(sQ, fail),
    onSnapshot: (n, er) => onSnapshot(q, s => n(sQ(s)), e => er && er(mapErr(e)))
  });
  const D = p => {
    const r = doc(fs, p);
    return {
      id: r.id, path: p,
      get: () => getDoc(r).then(sDoc, fail),
      set: d => setDoc(r, d).catch(fail),
      update: d => updateDoc(r, d).catch(fail),
      delete: () => deleteDoc(r).catch(fail),
      onSnapshot: (n, er) => onSnapshot(r, s => n(sDoc(s)), e => er && er(mapErr(e))),
      collection: sp => C(p + '/' + sp)
    };
  };
  const C = p => {
    const c = collection(fs, p);
    return Object.assign(Q(c), {
      path: p,
      doc: id => D(id ? p + '/' + id : doc(c).path),
      add: d => addDoc(c, d).then(r => D(r.path), fail)
    });
  };
  const db = { doc: D, collection: C };

  // นำเข้าข้อมูลตั้งต้น (ถัง + รายชื่อพนักงาน) ครั้งแรกที่ฐานข้อมูลยังว่าง
  const cfgSnap = await getDoc(doc(fs, 'cfg/main'));
  if (!cfgSnap.exists()) {
    const seed = await fetch('./seed.json', { cache: 'no-store' }).then(r => r.json());
    const b = writeBatch(fs);
    seed.tanks.forEach(t => b.set(doc(fs, 'tanks/' + t.id), t.d));
    b.set(doc(fs, 'cfg/main'), seed.cfg);
    await b.commit();
  }
  const setupMode = !cfgSnap.exists() || !(cfgSnap.data() || {}).admPw;

  // รูปภาพเก็บใน Firestore (คอลเลกชัน blobs) ย่อให้เล็กก่อนบันทึก
  const cache = new Map(), loading = new Set();
  const PH = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#d5d9d2"/></svg>');
  function blobUrl(id) {
    if (cache.has(id)) return cache.get(id);
    if (!loading.has(id)) {
      loading.add(id);
      getDoc(doc(fs, 'blobs/' + id)).then(s => { cache.set(id, s.exists() ? s.data().d : PH); window.dispatchEvent(new Event('claude-blob')); }).catch(() => loading.delete(id));
    }
    return PH;
  }
  const toDataUrl = b => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(b); });
  async function shrink(blob) {
    if (blob.size < 300000) return blob;
    try {
      const bmp = await createImageBitmap(blob), sc = Math.min(1, 1100 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * sc); cv.height = Math.round(bmp.height * sc);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      return await new Promise(r => cv.toBlob(x => r(x || blob), 'image/jpeg', .72));
    } catch (e) { return blob; }
  }
  const assets = {
    async upload(blob) {
      const small = await shrink(blob);
      if (small.size > 700000) throw { code: 'too_large', message: 'too large' };
      const d = await toDataUrl(small);
      const ref = await addDoc(collection(fs, 'blobs'), { d, at: new Date().toISOString(), by: cred.user.uid }).catch(fail);
      cache.set(ref.id, d);
      return { id: ref.id, url: d, sizeBytes: small.size, contentType: small.type };
    },
    async list() { return { assets: [], usage: {} }; },
    async delete(id) { await deleteDoc(doc(fs, 'blobs/' + id)); return { deleted: true }; }
  };
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return { status: 'saved' };
    }
  };
  const uid = cred.user.uid;
  const user = {
    async me() { return { id: uid, name: '', isOwner: setupMode, canEdit: true, email: null, avatarUrl: '', color: '#888' }; },
    async id() { return uid; },
    async isOwner() { return setupMode; },
    async canEdit() { return true; },
    async can() { return null; },
    async profiles(ids) { return Object.fromEntries([].concat(ids).map(i => [i, { id: i, name: '', avatarUrl: '', color: '#888', email: null, isMe: i === uid, guest: false }])); },
    async search() { return []; }
  };
  window.claude.blobUrl = blobUrl;
  return { db, user, assets, downloads };
}
start().then(ready, e => { console.error('Firebase:', e); ready({}); });
