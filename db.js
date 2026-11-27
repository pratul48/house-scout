/* House database: every house you search is stored on this phone in IndexedDB (the browser's built-in database).
 * One record per house, keyed by its location. Records are updated as each section of the report finishes.
 */
(function (root) {
  'use strict';
  const NAME = 'house-scout', VERSION = 1, STORE = 'houses';
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'key' });
          s.createIndex('lastSeen', 'lastSeen');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode), s = t.objectStore(STORE);
      let out; const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
    });
  };

  const get = key => tx('readonly', s => s.get(key));
  const all = () => tx('readonly', s => s.getAll()).then(l => (l || []).sort((a, b) => b.lastSeen - a.lastSeen));
  const put = rec => tx('readwrite', s => s.put(rec));
  const del = key => tx('readwrite', s => s.delete(key));
  const clear = () => tx('readwrite', s => s.clear());

  // Deep-ish merge: nested objects (facing, roof, daycare…) are replaced, top-level fields merged.
  // Updates run one at a time. Several sections finish at nearly the same moment, and two
  // read-then-write updates running together would otherwise overwrite each other's changes.
  let chain = Promise.resolve();
  function update(key, patch) {
    const job = chain.then(async () => {
      const cur = (await get(key)) || { key, firstSeen: Date.now(), timesSearched: 0, visits: [], starred: false };
      const rec = { ...cur, ...patch, key, lastSeen: patch.lastSeen || cur.lastSeen || Date.now() };
      await put(rec);
      return rec;
    });
    chain = job.catch(() => {});
    return job;
  }

  // One-time move of the old "Saved" list (localStorage) into the database.
  async function migrate() {
    let old; try { old = JSON.parse(localStorage.getItem('hs_saved') || '[]'); } catch { old = []; }
    if (!old.length || localStorage.getItem('hs_migrated')) return;
    for (const s of old) {
      const { key, ...rest } = s;
      await update(key, { ...rest, starred: true, lastSeen: s.savedAt || Date.now(), notes: { price: s.price, roof: s.roof, hoa: s.hoa, built: s.built, hvac: s.hvac, wh: s.wh, notes: s.notes },
        facing: s.dir ? { bearing: s.bearing, dir: s.dir, avoid: s.avoid, source: s.facingSource } : null });
    }
    localStorage.setItem('hs_migrated', '1');
  }

  async function importAll(list) {
    let n = 0;
    for (const r of list) if (r && r.key && typeof r.lat === 'number') { const cur = await get(r.key); if (!cur || (r.lastSeen || 0) >= (cur.lastSeen || 0)) { await put(r); n++; } }
    return n;
  }

  // Ask the browser not to clear this data when the phone is low on space.
  const persist = () => (navigator.storage && navigator.storage.persist ? navigator.storage.persist().catch(() => false) : Promise.resolve(false));

  root.HouseDB = { open, get, all, put, del, clear, update, migrate, importAll, persist };
})(typeof window !== 'undefined' ? window : globalThis);
