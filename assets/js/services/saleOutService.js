const SaleOutService = (() => {
  function isSaleOutConfigured() {
    const { baseUrl, token, saleoutTableId } = APP_CONFIG.nocodb;
    return !!(baseUrl && token && saleoutTableId && saleoutTableId.length > 4);
  }

  function apiUrl(path = '') {
    return `${APP_CONFIG.nocodb.baseUrl}/api/v2/tables/${APP_CONFIG.nocodb.saleoutTableId}/records${path}`;
  }

  function headers() {
    return { 'Content-Type': 'application/json', 'xc-token': APP_CONFIG.nocodb.token };
  }

  async function fetchAll() {
    if (!isSaleOutConfigured()) {
      const rows = await StorageService.getSaleOutAll();
      return rows.map(({ _key, ...rest }) => rest);
    }
    let offset = 0;
    const limit = 1000;
    const all = [];
    while (true) {
      const res = await fetch(apiUrl(`?limit=${limit}&offset=${offset}`), { headers: headers() });
      if (!res.ok) throw new Error(`SaleOut fetch error: ${res.status}`);
      const data = await res.json();
      const rows = data.list || [];
      all.push(...rows);
      if (rows.length < limit) break;
      offset += limit;
    }
    return all;
  }

  function _dedupKey(r) {
    return `${r.short_name}|${r.month}`;
  }

  async function batchUpsert(records, { batchSize = 100, onProgress } = {}) {
    if (!isSaleOutConfigured()) {
      let done = 0;
      for (let i = 0; i < records.length; i += batchSize) {
        const chunk = records.slice(i, i + batchSize).map(r => ({
          ...r, _key: _dedupKey(r),
        }));
        await StorageService.putSaleOutMany(chunk);
        done += chunk.length;
        if (onProgress) onProgress(done, records.length);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return;
    }

    // NocoDB: fetch existing to resolve insert vs update
    const existing = await fetchAll();
    const existingMap = new Map(existing.map(r => [_dedupKey(r), r.Id]));

    const toInsert = [];
    const toUpdate = [];
    for (const r of records) {
      const existId = existingMap.get(_dedupKey(r));
      if (existId) {
        toUpdate.push({ ...r, Id: existId });
      } else {
        toInsert.push(r);
      }
    }

    let done = 0;
    const total = records.length;

    for (let i = 0; i < toInsert.length; i += batchSize) {
      const res = await fetch(apiUrl(), {
        method: 'POST', headers: headers(),
        body: JSON.stringify(toInsert.slice(i, i + batchSize)),
      });
      if (!res.ok) throw new Error(`SaleOut insert error: ${res.status} — ${await res.text()}`);
      done += Math.min(batchSize, toInsert.length - i);
      if (onProgress) onProgress(done, total);
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    for (let i = 0; i < toUpdate.length; i += batchSize) {
      const res = await fetch(apiUrl(), {
        method: 'PATCH', headers: headers(),
        body: JSON.stringify(toUpdate.slice(i, i + batchSize)),
      });
      if (!res.ok) throw new Error(`SaleOut update error: ${res.status} — ${await res.text()}`);
      done += Math.min(batchSize, toUpdate.length - i);
      if (onProgress) onProgress(done, total);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return { isSaleOutConfigured, fetchAll, batchUpsert };
})();
