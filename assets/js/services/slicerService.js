const SlicerService = (() => {
  let _lsKey = 'crm_slicers';

  function setNamespace(ns) {
    _lsKey = ns === 'spm2' ? 'crm2_slicers' : 'crm_slicers';
  }

  function _load() { return JSON.parse(localStorage.getItem(_lsKey) || '[]'); }
  function _save(list) { localStorage.setItem(_lsKey, JSON.stringify(list)); }

  function getAll() { return _load(); }

  function add(field) {
    const slicers = _load();
    if (slicers.some(s => s.field === field)) return;
    slicers.push({ id: 'sl_' + field + '_' + Date.now(), field, selectedValues: [], linkedCharts: 'all' });
    _save(slicers);
  }

  function remove(id) { _save(_load().filter(s => s.id !== id)); }

  function toggleValue(id, value) {
    const slicers = _load();
    const s = slicers.find(s => s.id === id);
    if (!s) return;
    const idx = s.selectedValues.indexOf(value);
    if (idx === -1) s.selectedValues.push(value);
    else s.selectedValues.splice(idx, 1);
    _save(slicers);
  }

  function clearValues(id) {
    const slicers = _load();
    const s = slicers.find(s => s.id === id);
    if (!s) return;
    s.selectedValues = [];
    _save(slicers);
  }

  function setLinkedCharts(id, charts) {
    const slicers = _load();
    const s = slicers.find(s => s.id === id);
    if (!s) return;
    s.linkedCharts = charts;
    _save(slicers);
  }

  function getFilteredData(data, chartName) {
    const active = _load().filter(s => {
      if (!s.selectedValues.length) return false;
      if (s.linkedCharts === 'all') return true;
      return Array.isArray(s.linkedCharts) && s.linkedCharts.includes(chartName);
    });
    if (!active.length) return data;
    return data.filter(row =>
      active.every(s => s.selectedValues.includes(String(row[s.field] ?? '')))
    );
  }

  function getUniqueValues(data, field) {
    const vals = new Set();
    data.forEach(row => {
      const v = row[field];
      if (v !== undefined && v !== null && v !== '') vals.add(String(v));
    });
    return [...vals].sort((a, b) => a.localeCompare(b, 'vi'));
  }

  return { setNamespace, getAll, add, remove, toggleValue, clearValues, setLinkedCharts, getFilteredData, getUniqueValues };
})();
