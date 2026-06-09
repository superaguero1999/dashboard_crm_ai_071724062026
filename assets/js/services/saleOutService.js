const SaleOutService = (() => {
  let _namespace = 'spm1';

  function setNamespace(ns) { _namespace = ns; }

  function _nc() {
    return _namespace === 'spm2' ? APP_CONFIG.nocodb2 : APP_CONFIG.nocodb;
  }

  function isSaleOutConfigured() {
    const { baseUrl, token, saleoutTableId } = _nc();
    return !!(baseUrl && token && saleoutTableId && saleoutTableId.length > 4);
  }

  function apiUrl(path = '') {
    return `${_nc().baseUrl}/api/v2/tables/${_nc().saleoutTableId}/records${path}`;
  }

  function headers() {
    return { 'Content-Type': 'application/json', 'xc-token': _nc().token };
  }

  function _storageGetAll()           { return _namespace === 'spm2' ? StorageService.getSaleOut2All()          : StorageService.getSaleOutAll(); }
  function _storagePutMany(r)         { return _namespace === 'spm2' ? StorageService.putSaleOut2Many(r)         : StorageService.putSaleOutMany(r); }
  function _storageClearAndPutMany(r) { return _namespace === 'spm2' ? StorageService.clearAndPutSaleOut2Many(r) : StorageService.clearAndPutSaleOutMany(r); }

  async function fetchAll() {
    if (!isSaleOutConfigured()) {
      const rows = await _storageGetAll();
      return rows.map(({ _key, ...rest }) => rest);
    }
    try {
      let offset = 0;
      const limit = 1000;
      const all = [];
      let totalRows = null;
      while (true) {
        const res = await fetch(apiUrl(`?limit=${limit}&offset=${offset}`), { headers: headers() });
        if (!res.ok) throw new Error(`SaleOut fetch error: ${res.status}`);
        const data = await res.json();
        const rows = data.list || [];
        all.push(...rows);
        if (totalRows === null && data.pageInfo?.totalRows != null) {
          totalRows = data.pageInfo.totalRows;
        }
        if (totalRows !== null ? all.length >= totalRows : rows.length < limit) break;
        offset += limit;
      }
      // Cache vào IndexedDB (clear trước để tránh giữ lại record cũ đã xóa khỏi NocoDB)
      if (all.length > 0) {
        const withKeys = all.map(r => ({ ...r, _key: `${r.short_name}|${r.month}` }));
        _storageClearAndPutMany(withKeys).catch(() => {});
      }
      return all;
    } catch (e) {
      console.warn('[SaleOutService] NocoDB không khả dụng, dùng cache IndexedDB:', e.message);
      const rows = await _storageGetAll();
      return rows.map(({ _key, ...rest }) => rest);
    }
  }

  function _dedupKey(r) { return `${r.short_name}|${r.month}`; }

  async function batchUpsert(records, { batchSize = 100, onProgress } = {}) {
    if (!isSaleOutConfigured()) {
      let done = 0;
      for (let i = 0; i < records.length; i += batchSize) {
        const chunk = records.slice(i, i + batchSize).map(r => ({ ...r, _key: _dedupKey(r) }));
        await _storagePutMany(chunk);
        done += chunk.length;
        if (onProgress) onProgress(done, records.length);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return;
    }

    const existing = await fetchAll();
    const existingMap = new Map(existing.map(r => [_dedupKey(r), r.Id]));
    const toInsert = [], toUpdate = [];
    for (const r of records) {
      const existId = existingMap.get(_dedupKey(r));
      if (existId) toUpdate.push({ ...r, Id: existId });
      else toInsert.push(r);
    }

    let done = 0;
    const total = records.length;

    for (let i = 0; i < toInsert.length; i += batchSize) {
      const res = await fetch(apiUrl(), { method: 'POST', headers: headers(), body: JSON.stringify(toInsert.slice(i, i + batchSize)) });
      if (!res.ok) throw new Error(`SaleOut insert error: ${res.status} — ${await res.text()}`);
      done += Math.min(batchSize, toInsert.length - i);
      if (onProgress) onProgress(done, total);
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    for (let i = 0; i < toUpdate.length; i += batchSize) {
      const res = await fetch(apiUrl(), { method: 'PATCH', headers: headers(), body: JSON.stringify(toUpdate.slice(i, i + batchSize)) });
      if (!res.ok) throw new Error(`SaleOut update error: ${res.status} — ${await res.text()}`);
      done += Math.min(batchSize, toUpdate.length - i);
      if (onProgress) onProgress(done, total);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return { setNamespace, isSaleOutConfigured, fetchAll, batchUpsert };
})();
