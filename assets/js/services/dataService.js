const DataService = (() => {
  function isConfigured() {
    const { baseUrl, token, tableId } = APP_CONFIG.nocodb;
    return baseUrl && !baseUrl.includes('your-nocodb') &&
           token && !token.includes('your_noco') &&
           tableId && !tableId.includes('your_table');
  }

  function isConfigStoreReady() {
    const id = APP_CONFIG.nocodb.configTableId;
    return isConfigured() && id && id.length > 0 && !id.includes('your_config');
  }

  function configApiUrl(path = '') {
    return `${APP_CONFIG.nocodb.baseUrl}/api/v2/tables/${APP_CONFIG.nocodb.configTableId}/records${path}`;
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
        // Title: NocoDB default field — cần gửi kèm để tránh lỗi required
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

  function headers() {
    return {
      'Content-Type': 'application/json',
      'xc-token': APP_CONFIG.nocodb.token,
    };
  }

  // NocoDB API v2: /api/v2/tables/{tableId}/records
  function apiUrl(path = '') {
    return `${APP_CONFIG.nocodb.baseUrl}/api/v2/tables/${APP_CONFIG.nocodb.tableId}/records${path}`;
  }

  // Lấy toàn bộ records
  async function fetchAll() {
    if (!isConfigured()) {
      // Tự động migrate từ localStorage cũ sang IndexedDB nếu cần
      const n = await StorageService.count();
      if (n === 0) {
        const legacy = JSON.parse(localStorage.getItem('crm_data') || '[]');
        if (legacy.length > 0) {
          let i = 0;
          const withKeys = legacy.map(r => {
            const k = ExcelService.buildRowKey(r);
            return { ...r, _key: k || `_nk_${i++}` };
          });
          await StorageService.putMany(withKeys);
          localStorage.removeItem('crm_data');
        }
      }
      const records = await StorageService.getAll();
      return records.map(({ _key, ...rest }) => rest);
    }

    // NocoDB path — tự động phân trang
    let offset = 0;
    const limit = 1000;
    const all = [];
    while (true) {
      const res = await fetch(apiUrl(`?limit=${limit}&offset=${offset}`), { headers: headers() });
      if (!res.ok) throw new Error(`NocoDB fetch error: ${res.status}`);
      const data = await res.json();
      const rows = data.list || [];
      all.push(...rows);
      if (rows.length < limit) break;
      offset += limit;
    }
    return all;
  }

  // Bulk insert (POST array) — NocoDB v2 hỗ trợ gửi mảng
  async function _bulkInsert(records) {
    const res = await fetch(apiUrl(), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(records),
    });
    if (!res.ok) throw new Error(`Bulk insert error: ${res.status} — ${await res.text()}`);
    return res.json();
  }

  // Bulk update (PATCH array) — mỗi record cần có trường Id
  async function _bulkUpdate(records) {
    const res = await fetch(apiUrl(), {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(records),
    });
    if (!res.ok) throw new Error(`Bulk update error: ${res.status} — ${await res.text()}`);
    return res.json();
  }

  // Batch upsert: IndexedDB khi chưa cấu hình, NocoDB bulk API khi đã cấu hình
  async function batchUpsert(records, { batchSize = 100, onProgress } = {}) {
    if (!isConfigured()) {
      let done = 0;
      let nkIdx = 0;
      for (let i = 0; i < records.length; i += batchSize) {
        const chunk = records.slice(i, i + batchSize);
        const withKeys = chunk.map(r => {
          const k = ExcelService.buildRowKey(r);
          return { ...r, _key: k || `_nk_${nkIdx++}` };
        });
        await StorageService.putMany(withKeys);
        done += chunk.length;
        if (onProgress) onProgress(done, records.length);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return;
    }

    // NocoDB path — dùng bulk API (nhanh hơn nhiều)
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

  // ── Slicers — đồng bộ NocoDB khi sẵn sàng, fallback localStorage ────────────

  async function syncSlicers() {
    if (!isConfigStoreReady()) return;
    try {
      const remote = await _configGet('crm_slicers');
      if (remote && Array.isArray(remote) && remote.length > 0) {
        localStorage.setItem('crm_slicers', JSON.stringify(remote));
        console.log('[SyncSlicers] Pulled', remote.length, 'slicers from NocoDB');
      } else {
        const local = JSON.parse(localStorage.getItem('crm_slicers') || '[]');
        if (local.length > 0) {
          await _configSet('crm_slicers', local);
          console.log('[SyncSlicers] Pushed', local.length, 'slicers to NocoDB');
        }
      }
    } catch (e) {
      console.error('[SyncSlicers] Failed:', e.message);
    }
  }

  async function pushSlicersToCloud() {
    if (!isConfigStoreReady()) throw new Error('NocoDB config table chưa được cấu hình');
    const slicers = JSON.parse(localStorage.getItem('crm_slicers') || '[]');
    await _configSet('crm_slicers', slicers);
    console.log('[PushSlicers] Pushed', slicers.length, 'slicers');
    return slicers.length;
  }

  // Gọi từ SlicerService sau mỗi lần thay đổi (fire-and-forget)
  async function saveSlicerData(list) {
    if (!isConfigStoreReady()) return;
    await _configSet('crm_slicers', list);
  }

  // ── Views — đồng bộ NocoDB khi sẵn sàng, fallback localStorage ─────────────
  let _viewsCache = null;

  // Gọi 1 lần khi load trang: kéo views từ NocoDB về (hoặc đẩy local lên nếu chưa có remote)
  async function syncViews() {
    if (!isConfigStoreReady()) {
      _viewsCache = JSON.parse(localStorage.getItem('crm_pivot_views') || '{}');
      return;
    }
    try {
      const remote = await _configGet('crm_pivot_views');
      if (remote && Object.keys(remote).length > 0) {
        // Có dữ liệu trên NocoDB → kéo về
        _viewsCache = remote;
        localStorage.setItem('crm_pivot_views', JSON.stringify(_viewsCache));
        console.log('[SyncViews] Pulled', Object.keys(_viewsCache).length, 'views from NocoDB');
      } else {
        // NocoDB trống → đẩy local lên
        _viewsCache = JSON.parse(localStorage.getItem('crm_pivot_views') || '{}');
        if (Object.keys(_viewsCache).length > 0) {
          await _configSet('crm_pivot_views', _viewsCache);
          console.log('[SyncViews] Pushed', Object.keys(_viewsCache).length, 'views to NocoDB');
        }
      }
    } catch (e) {
      console.error('[SyncViews] Failed:', e.message);
      _viewsCache = JSON.parse(localStorage.getItem('crm_pivot_views') || '{}');
    }
  }

  // Push thủ công toàn bộ views hiện tại lên NocoDB (dùng cho nút "Đồng bộ")
  async function pushViewsToCloud() {
    if (!isConfigStoreReady()) throw new Error('NocoDB config table chưa được cấu hình');
    const views = loadPivotViews();
    await _configSet('crm_pivot_views', views);
    console.log('[PushViews] Pushed', Object.keys(views).length, 'views');
    return Object.keys(views).length;
  }

  function loadPivotViews() {
    if (_viewsCache === null) {
      _viewsCache = JSON.parse(localStorage.getItem('crm_pivot_views') || '{}');
    }
    return _viewsCache;
  }

  async function savePivotView(name, config) {
    const views = loadPivotViews();
    views[name] = config;
    _viewsCache = views;
    localStorage.setItem('crm_pivot_views', JSON.stringify(views));
    if (isConfigStoreReady()) await _configSet('crm_pivot_views', views);
  }

  async function deletePivotView(name) {
    const views = loadPivotViews();
    delete views[name];
    _viewsCache = views;
    localStorage.setItem('crm_pivot_views', JSON.stringify(views));
    if (isConfigStoreReady()) await _configSet('crm_pivot_views', views);
  }

  return { fetchAll, batchUpsert, syncViews, pushViewsToCloud, savePivotView, loadPivotViews, deletePivotView, syncSlicers, pushSlicersToCloud, saveSlicerData, isConfigured, isConfigStoreReady };
})();
