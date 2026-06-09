const StorageService = (() => {
  const DB_NAME = 'crm_dashboard_db';
  const DB_VERSION = 3;
  const STORE_RECORDS  = 'records';
  const STORE_SALEOUT  = 'saleout';
  const STORE_RECORDS2 = 'records2';
  const STORE_SALEOUT2 = 'saleout2';
  let _db = null;

  function _open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_RECORDS))  db.createObjectStore(STORE_RECORDS,  { keyPath: '_key' });
        if (!db.objectStoreNames.contains(STORE_SALEOUT))  db.createObjectStore(STORE_SALEOUT,  { keyPath: '_key' });
        if (!db.objectStoreNames.contains(STORE_RECORDS2)) db.createObjectStore(STORE_RECORDS2, { keyPath: '_key' });
        if (!db.objectStoreNames.contains(STORE_SALEOUT2)) db.createObjectStore(STORE_SALEOUT2, { keyPath: '_key' });
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

  // Xóa toàn bộ store trước khi ghi mới — tránh tích lũy record cũ đã xóa khỏi NocoDB
  async function _clearAndPutMany(storeName, records) {
    const db = await _open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    if (records.length > 0) await _putMany(storeName, records);
  }

  async function _count(storeName) {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Dataset 1
  async function getAll()                    { return _getAll(STORE_RECORDS); }
  async function putMany(records)            { return _putMany(STORE_RECORDS, records); }
  async function clearAndPutMany(records)    { return _clearAndPutMany(STORE_RECORDS, records); }
  async function count()                     { return _count(STORE_RECORDS); }
  async function getSaleOutAll()             { return _getAll(STORE_SALEOUT); }
  async function putSaleOutMany(r)           { return _putMany(STORE_SALEOUT, r); }
  async function clearAndPutSaleOutMany(r)   { return _clearAndPutMany(STORE_SALEOUT, r); }

  // Dataset 2
  async function getAll2()                   { return _getAll(STORE_RECORDS2); }
  async function putMany2(records)           { return _putMany(STORE_RECORDS2, records); }
  async function clearAndPutMany2(records)   { return _clearAndPutMany(STORE_RECORDS2, records); }
  async function count2()                    { return _count(STORE_RECORDS2); }
  async function getSaleOut2All()            { return _getAll(STORE_SALEOUT2); }
  async function putSaleOut2Many(r)          { return _putMany(STORE_SALEOUT2, r); }
  async function clearAndPutSaleOut2Many(r)  { return _clearAndPutMany(STORE_SALEOUT2, r); }

  return { getAll, putMany, clearAndPutMany, count, getSaleOutAll, putSaleOutMany, clearAndPutSaleOutMany,
           getAll2, putMany2, clearAndPutMany2, count2, getSaleOut2All, putSaleOut2Many, clearAndPutSaleOut2Many };
})();
