const StorageService = (() => {
  const DB_NAME = 'crm_dashboard_db';
  const DB_VERSION = 2;
  const STORE_RECORDS = 'records';
  const STORE_SALEOUT = 'saleout';
  let _db = null;

  function _open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_RECORDS)) {
          db.createObjectStore(STORE_RECORDS, { keyPath: '_key' });
        }
        if (!db.objectStoreNames.contains(STORE_SALEOUT)) {
          db.createObjectStore(STORE_SALEOUT, { keyPath: '_key' });
        }
      };
    });
  }

  async function _getAll(storeName) {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function _putMany(storeName, records) {
    if (!records.length) return;
    const db = await _open();
    const CHUNK = 500;
    for (let i = 0; i < records.length; i += CHUNK) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        records.slice(i, i + CHUNK).forEach(r => store.put(r));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }
  }

  async function getAll() { return _getAll(STORE_RECORDS); }
  async function putMany(records) { return _putMany(STORE_RECORDS, records); }

  async function count() {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE_RECORDS, 'readonly').objectStore(STORE_RECORDS).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getSaleOutAll() { return _getAll(STORE_SALEOUT); }
  async function putSaleOutMany(records) { return _putMany(STORE_SALEOUT, records); }

  return { getAll, putMany, count, getSaleOutAll, putSaleOutMany };
})();
