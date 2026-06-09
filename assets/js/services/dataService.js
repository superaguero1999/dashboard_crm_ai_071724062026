const DataService = (() => {
  let _namespace = 'spm1'; // 'spm1' | 'spm2'
  let _viewsCache = null;

  function setNamespace(ns) {
    if (_namespace !== ns) { _namespace = ns; _viewsCache = null; }
  }

  function _nc() {
    return _namespace === 'spm2' ? APP_CONFIG.nocodb2 : APP_CONFIG.nocodb;
  }

  function _viewsLsKey()   { return _namespace === 'spm2' ? 'crm2_pivot_views'  : 'crm_pivot_views'; }
  function _slicersLsKey() { return _namespace === 'spm2' ? 'crm2_slicers'      : 'crm_slicers'; }

  function isConfigured() {
    const { baseUrl, token, tableId } = _nc();
    return !!(baseUrl && token && tableId && tableId.length > 4);
  }

  function isConfigStoreReady() {
    const id = _nc().configTableId;
    return isConfigured() && !!(id && id.length > 4);
  }

  function headers() {
    return { 'Content-Type': 'application/json', 'xc-token': _nc().token };
  }

  function apiUrl(path = '') {
    return `${_nc().baseUrl}/api/v2/tables/${_nc().tableId}/records${path}`;
  }

  function configApiUrl(path = '') {
    return `${_nc().baseUrl}/api/v2/tables/${_nc().configTableId}/records${path}`;
  }

  async function _configGetRow(key) {
    const where = encodeURIComponent(`(key,eq,${key})`);
    const res = await fetch(configApiUrl(`?where=${where}&limit=1`), { headers: headers() });
    if (!res.ok) throw new Error(`Config GET failed: ${res.status}`);
    const data = await res.json();
    return (data.list || [])[0] || null;
  }

  async function _configGet(key) {
    try {
      const row = await _configGetRow(key);
      return row ? JSON.parse(row.value) : null;
    } catch (e) {
      console.warn('[ConfigGet]', e.message);
      return null;
    }
  }

  async function _configSet(key, value) {
    const json = JSON.stringify(value);
    try {
      const existing = await _configGetRow(key);
      if (existing) {
        const res = await fetch(configApiUrl(), {
          method: 'PATCH', headers: headers(),
          body: JSON.stringify([{ Id: existing.Id, value: json }]),
        });
        if (!res.ok) throw new Error(`PATCH failed: ${res.status} — ${await res.text()}`);
      } else {
        const res = await fetch(configApiUrl(), {
          method: 'POST', headers: headers(),
          body: JSON.stringify({ Title: key, key, value: json }),
        });
        if (!res.ok) throw new Error(`POST failed: ${res.status} — ${await res.text()}`);
      }
    } catch (e) {
      console.error('[ConfigSet]', e.message);
      throw e;
    }
  }

  // ── Storage helpers (namespace-aware) ────────────────────────────────────
  function _storageGetAll()           { return _namespace === 'spm2' ? StorageService.getAll2()          : StorageService.getAll(); }
  function _storageCount()            { return _namespace === 'spm2' ? StorageService.count2()           : StorageService.count(); }
  function _storagePutMany(r)         { return _namespace === 'spm2' ? StorageService.putMany2(r)        : StorageService.putMany(r); }
  function _storageClearAndPutMany(r) { return _namespace === 'spm2' ? StorageService.clearAndPutMany2(r): StorageService.clearAndPutMany(r); }

  // ── Fetch all records ────────────────────────────────────────────────────
  async function fetchAll() {
    if (!isConfigured()) {
      // Migrate legacy localStorage → IndexedDB (SPM1 only)
      if (_namespace === 'spm1') {
        const n = await _storageCount();
        if (n === 0) {
          const legacy = JSON.parse(localStorage.getItem('crm_data') || '[]');
          if (legacy.length > 0) {
            let i = 0;
            const withKeys = legacy.map(r => {
              const k = ExcelService.buildRowKey(r);
              return { ...r, _key: k || `_nk_${i++}` };
            });
            await _storagePutMany(withKeys);
            localStorage.removeItem('crm_data');
          }
        }
      }
      const records = await _storageGetAll();
      return records.map(({ _key, ...rest }) => rest);
    }

    try {
      let offset = 0;
      const limit = 1000;
      const all = [];
      let totalRows = null;
      while (true) {
        const res = await fetch(apiUrl(`?limit=${limit}&offset=${offset}`), { headers: headers() });
        if (!res.ok) throw new Error(`NocoDB fetch error: ${res.status}`);
        const data = await res.json();
        const rows = data.list || [];
        all.push(...rows);
        if (totalRows === null && data.pageInfo?.totalRows != null) {
          totalRows = data.pageInfo.totalRows;
        }
        // Dừng khi đã lấy đủ tổng số records theo pageInfo, hoặc trang trả về ít hơn limit
        if (totalRows !== null ? all.length >= totalRows : rows.length < limit) break;
        offset += limit;
      }
      // Cache vào IndexedDB (clear trước để tránh giữ lại record cũ đã xóa khỏi NocoDB)
      if (all.length > 0) {
        let nkIdx = 0;
        const withKeys = all.map(r => {
          const k = ExcelService.buildRowKey(r);
          return { ...r, _key: k || `_nk_${nkIdx++}` };
        });
        _storageClearAndPutMany(withKeys).catch(() => {});
      }
      return all;
    } catch (e) {
      console.warn('[DataService] NocoDB không khả dụng, dùng cache IndexedDB:', e.message);
      const records = await _storageGetAll();
      return records.map(({ _key, ...rest }) => rest);
    }
  }

  async function _bulkInsert(records) {
    const res = await fetch(apiUrl(), { method: 'POST', headers: headers(), body: JSON.stringify(records) });
    if (!res.ok) throw new Error(`Bulk insert error: ${res.status} — ${await res.text()}`);
    return res.json();
  }

  async function _bulkUpdate(records) {
    const AUTO_FIELDS = new Set(['CreatedAt', 'UpdatedAt']);
    const cleaned = records.map(r => {
      const obj = {};
      for (const [k, v] of Object.entries(r)) {
        if (!AUTO_FIELDS.has(k) && !k.startsWith('_nc_')) obj[k] = v;
      }
      return obj;
    });
    const res = await fetch(apiUrl(), { method: 'PATCH', headers: headers(), body: JSON.stringify(cleaned) });
    if (!res.ok) throw new Error(`Bulk update error: ${res.status} — ${await res.text()}`);
    return res.json();
  }

  async function batchUpsert(records, { batchSize = 100, onProgress } = {}) {
    if (!isConfigured()) {
      let done = 0, nkIdx = 0;
      for (let i = 0; i < records.length; i += batchSize) {
        const chunk = records.slice(i, i + batchSize);
        const withKeys = chunk.map(r => {
          const k = ExcelService.buildRowKey(r);
          return { ...r, _key: k || `_nk_${nkIdx++}` };
        });
        await _storagePutMany(withKeys);
        done += chunk.length;
        if (onProgress) onProgress(done, records.length);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return;
    }

    const toInsert = records.filter(r => !r.Id);
    const toUpdate = records.filter(r =>  r.Id);
    let done = 0;
    const total = records.length;

    for (let i = 0; i < toInsert.length; i += batchSize) {
      await _bulkInsert(toInsert.slice(i, i + batchSize));
      done += Math.min(batchSize, toInsert.length - i);
      if (onProgress) onProgress(done, total);
    }
    for (let i = 0; i < toUpdate.length; i += batchSize) {
      await _bulkUpdate(toUpdate.slice(i, i + batchSize));
      done += Math.min(batchSize, toUpdate.length - i);
      if (onProgress) onProgress(done, total);
    }
  }

  // ── Slicers sync ─────────────────────────────────────────────────────────
  async function syncSlicers() {
    if (!isConfigStoreReady()) return;
    const lsKey = _slicersLsKey();
    try {
      const remote = await _configGet(lsKey);
      if (remote && Array.isArray(remote) && remote.length > 0) {
        localStorage.setItem(lsKey, JSON.stringify(remote));
      } else {
        const local = JSON.parse(localStorage.getItem(lsKey) || '[]');
        if (local.length > 0) await _configSet(lsKey, local);
      }
    } catch (e) {
      console.error('[SyncSlicers]', e.message);
    }
  }

  async function pushSlicersToCloud() {
    if (!isConfigStoreReady()) throw new Error('NocoDB config table chưa được cấu hình');
    const slicers = JSON.parse(localStorage.getItem(_slicersLsKey()) || '[]');
    await _configSet(_slicersLsKey(), slicers);
    return slicers.length;
  }

  async function saveSlicerData(list) {
    if (!isConfigStoreReady()) return;
    await _configSet(_slicersLsKey(), list);
  }

  // ── Views ────────────────────────────────────────────────────────────────
  async function syncViews() {
    const lsKey = _viewsLsKey();
    if (!isConfigStoreReady()) {
      _viewsCache = JSON.parse(localStorage.getItem(lsKey) || '{}');
      return;
    }
    try {
      const remote = await _configGet(lsKey);
      if (remote && Object.keys(remote).length > 0) {
        _viewsCache = remote;
        localStorage.setItem(lsKey, JSON.stringify(_viewsCache));
      } else {
        _viewsCache = JSON.parse(localStorage.getItem(lsKey) || '{}');
        if (Object.keys(_viewsCache).length > 0) await _configSet(lsKey, _viewsCache);
      }
    } catch (e) {
      console.error('[SyncViews]', e.message);
      _viewsCache = JSON.parse(localStorage.getItem(lsKey) || '{}');
    }
  }

  async function pushViewsToCloud() {
    if (!isConfigStoreReady()) throw new Error('NocoDB config table chưa được cấu hình');
    const views = loadPivotViews();
    await _configSet(_viewsLsKey(), views);
    return Object.keys(views).length;
  }

  function loadPivotViews() {
    if (_viewsCache === null) {
      _viewsCache = JSON.parse(localStorage.getItem(_viewsLsKey()) || '{}');
    }
    return _viewsCache;
  }

  async function savePivotView(name, config) {
    const views = loadPivotViews();
    views[name] = config;
    _viewsCache = views;
    localStorage.setItem(_viewsLsKey(), JSON.stringify(views));
    if (isConfigStoreReady()) await _configSet(_viewsLsKey(), views);
  }

  async function deletePivotView(name) {
    const views = loadPivotViews();
    delete views[name];
    _viewsCache = views;
    localStorage.setItem(_viewsLsKey(), JSON.stringify(views));
    if (isConfigStoreReady()) await _configSet(_viewsLsKey(), views);
  }

  return { setNamespace, fetchAll, batchUpsert,
           syncViews, pushViewsToCloud, savePivotView, loadPivotViews, deletePivotView,
           syncSlicers, pushSlicersToCloud, saveSlicerData,
           isConfigured, isConfigStoreReady };
})();
