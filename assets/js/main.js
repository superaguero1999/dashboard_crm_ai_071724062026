// ─── App State ─────────────────────────────────────────────────────────────
let _activeDataset  = 'spm1'; // 'spm1' | 'spm2'
let _activeSection  = 'saleout'; // 'saleout' | 'dashboard' | 'pivot' — dùng bởi ChatbotService
let _spm1Data = [], _spm1Saleout = [], _spm1Ecn = [];
let _spm2Data = [], _spm2Saleout = [], _spm2Ecn = [];
let _allData     = []; // alias → active dataset
let _saleoutData = []; // alias → active saleout
let _pivotResult = null;
let _isSpm2Loading = true; // SPM2 loads in background; true until done

// Đọc extra filters từ localStorage theo namespace (luôn fresh, không stale)
function _soFiltersFromLS(ns) {
  const key = ns === 'spm2' ? 'crm2_saleout_ef' : 'crm_saleout_ef';
  return JSON.parse(localStorage.getItem(key) || '[]');
}

// ── AppState — dùng bởi ChatbotService để đọc ngữ cảnh hiện tại ─────────────
window.AppState = {
  getSummary() {
    try {
      const filters  = SaleOutRenderer.getFilters?.() || {};
      const activeSubTab = SaleOutRenderer.getActiveSubTab?.() || '';
      const tableData = SaleOutRenderer.getCurrentData?.() || { byProduct: [], byProductByErrors: [], byProductBySale: [], byMonth: [], order: 'desc', topN: 20 };
      return {
        activeDataset:   _activeDataset,
        activeSection:   _activeSection,
        activeSubTab,
        selectedMonths:  filters.months      || [],
        selectedProducts: filters.shortNames || [],
        recordCount:     _allData?.length    || 0,
        saleoutMonths:   [...new Set((_saleoutData || []).map(r => r.month).filter(Boolean))].sort(),
        saleoutProducts: [...new Set((_saleoutData || []).map(r => r.short_name).filter(Boolean))].slice(0, 30),
        tableByProduct:       tableData.byProduct       || [],
        tableByProductErrors: tableData.byProductByErrors || [],
        tableByProductSale:   tableData.byProductBySale  || [],
        tableByMonth:         tableData.byMonth         || [],
        rawErrorCount:        tableData.rawErrorCount   ?? null,
        overallRate:          tableData.overallRate     ?? null,
        tableOrder:           tableData.order           || 'desc',
        tableTopN:            tableData.topN            || 20,
      };
    } catch (_) { return {}; }
  },

  getAllMonthsData() {
    try {
      return SaleOutRenderer.getUnfilteredByMonth?.() || [];
    } catch (_) { return []; }
  },

  getDashboardSummary() {
    try {
      const data     = _allData || [];
      const filtered = SlicerService.getFilteredData(data, '__ai__');
      const slicers  = SlicerService.getAll().filter(s => s.selectedValues.length > 0);
      const uniqueProducts = [...new Set(data.map(r => r.product_shortname).filter(Boolean))].slice(0, 50);
      const uniqueMonths   = [...new Set(data.map(r => r.month).filter(Boolean))].sort();

      // Aggregate error breakdowns from filtered records
      const byCategory  = {}, byAccessory = {}, byCause = {};
      for (const r of filtered) {
        if (r.category)      byCategory[r.category]   = (byCategory[r.category]   || 0) + 1;
        if (r.err_accessory) byAccessory[r.err_accessory] = (byAccessory[r.err_accessory] || 0) + 1;
        if (r.cause)         byCause[r.cause]         = (byCause[r.cause]         || 0) + 1;
      }
      const toRanked = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));

      return {
        totalCount:      data.length,
        filteredCount:   filtered.length,
        uniqueProducts,
        uniqueMonths,
        activeSlicers:   slicers.map(s => ({ field: s.field, values: s.selectedValues })),
        topByCategory:   toRanked(byCategory,  10),  // Nhóm lỗi
        topByAccessory:  toRanked(byAccessory, 10),  // Linh kiện lỗi
        topByCause:      toRanked(byCause,     10),  // Nguyên nhân lỗi
      };
    } catch (_) { return { totalCount: 0, filteredCount: 0, uniqueProducts: [], uniqueMonths: [], activeSlicers: [], topByCategory: [], topByAccessory: [], topByCause: [] }; }
  },
};

// ── Switch dataset context ──────────────────────────────────────────────────
function switchDataset(ds) {
  _activeDataset = ds;
  DataService.setNamespace(ds);
  SaleOutService.setNamespace(ds);
  SlicerService.setNamespace(ds);
  EcnService.setNamespace(ds);
  SaleOutRenderer.setNamespace(ds); // giữ namespace riêng để save đúng key
  _allData     = ds === 'spm2' ? _spm2Data    : _spm1Data;
  _saleoutData = ds === 'spm2' ? _spm2Saleout : _spm1Saleout;
  const ecn    = ds === 'spm2' ? _spm2Ecn     : _spm1Ecn;
  SaleOutRenderer.setEcnMap(EcnService.buildEcnMap(ecn));
}

// ── SPM2 tab loading badge ───────────────────────────────────────────────
function _setSpm2TabLoading(on) {
  const tab = document.getElementById('tab-spm2');
  if (!tab) return;
  tab.querySelectorAll('.tab-spin').forEach(e => e.remove());
  if (on) {
    const s = document.createElement('span');
    s.className = 'tab-spin inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin ml-1.5 align-middle';
    tab.appendChild(s);
  }
}

// ─── Load dữ liệu ─────────────────────────────────────────────────────────
async function loadData() {
  SaleOutRenderer.setLoading(true);
  const countEl = document.getElementById('data-count');
  if (countEl) countEl.innerHTML = `<span class="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin align-middle mr-1"></span>Đang tải...`;
  // Luôn load SPM1 (không ảnh hưởng namespace hiện tại)
  DataService.setNamespace('spm1');
  const loadingEl = document.getElementById('data-loading');
  if (loadingEl) loadingEl.style.display = '';
  try {
    _spm1Data = await DataService.fetchAll();
  } catch (_) {
    _spm1Data = [];
  }
  if (loadingEl) loadingEl.style.display = 'none';
  await DataService.syncViews();
  await DataService.syncSlicers();
  await DataService.syncSaleoutFilters(); // sync → ghi vào localStorage (không auto-push)
  // Restore namespace
  DataService.setNamespace(_activeDataset);
  _allData = _activeDataset === 'spm2' ? _spm2Data : _spm1Data;
  renderSavedViews();
  updateDataStats();
  refreshPivot();
  DashboardRenderer.setData(_allData);
  const dashSection = document.getElementById('dashboard-section');
  if (dashSection && dashSection.style.display !== 'none') DashboardRenderer.render();
  SaleOutRenderer.setExtraFilters(_soFiltersFromLS('spm1'));
  await loadSaleOutData();
  // Load ECN data SPM1
  EcnService.setNamespace('spm1');
  try { _spm1Ecn = await EcnService.fetchAll(); } catch (_) { _spm1Ecn = []; }
  SaleOutRenderer.setEcnMap(EcnService.buildEcnMap(_spm1Ecn));
  // Load SPM2 data in background (không block UI)
  _loadSpm2DataBackground();
}

async function _loadSpm2DataBackground() {
  _isSpm2Loading = true;
  _setSpm2TabLoading(true);
  DataService.setNamespace('spm2');
  SaleOutService.setNamespace('spm2');
  EcnService.setNamespace('spm2');
  try { _spm2Data    = await DataService.fetchAll();    } catch (_) { _spm2Data    = []; }
  try { _spm2Saleout = await SaleOutService.fetchAll(); } catch (_) { _spm2Saleout = []; }
  try { _spm2Ecn     = await EcnService.fetchAll();     } catch (_) { _spm2Ecn     = []; }
  // Sync views + slicers cho SPM2 (cần gọi trong khi namespace vẫn là spm2)
  await DataService.syncViews();
  await DataService.syncSlicers();
  await DataService.syncSaleoutFilters(); // sync → ghi vào localStorage (không auto-push)
  _isSpm2Loading = false;
  _setSpm2TabLoading(false);
  // Restore namespace
  DataService.setNamespace(_activeDataset);
  SaleOutService.setNamespace(_activeDataset);
  EcnService.setNamespace(_activeDataset);
  if (_activeDataset === 'spm2') {
    _allData = _spm2Data;
    _saleoutData = _spm2Saleout;
    SaleOutRenderer.setEcnMap(EcnService.buildEcnMap(_spm2Ecn));
    updateDataStats();
    SaleOutRenderer.setExtraFilters(_soFiltersFromLS('spm2'));
    SaleOutRenderer.setData(_saleoutData, _allData);
    const soSection = document.getElementById('saleout-section');
    if (soSection && soSection.style.display !== 'none') SaleOutRenderer.render();
    else SaleOutRenderer.renderSidebar();
  }
}

async function loadSaleOutData() {
  SaleOutRenderer.setLoading(true);
  SaleOutService.setNamespace('spm1');
  try {
    _spm1Saleout = await SaleOutService.fetchAll();
  } catch (_) {
    _spm1Saleout = [];
  }
  SaleOutService.setNamespace(_activeDataset);
  _saleoutData = _activeDataset === 'spm2' ? _spm2Saleout : _spm1Saleout;
  SaleOutRenderer.setData(_saleoutData, _allData);
  const soSection = document.getElementById('saleout-section');
  if (soSection && soSection.style.display !== 'none') SaleOutRenderer.render();
  else SaleOutRenderer.renderSidebar();
}

function updateDataStats() {
  const el = document.getElementById('data-count');
  if (el) el.textContent = `${_allData.length} records`;
}

// ─── Refresh pivot table + chart ────────────────────────────────────────────
function refreshPivot() {
  const config = PivotBuilder.getConfig();
  _pivotResult = PivotEngine.compute(_allData, config);
  TableRenderer.render(_pivotResult, 'pivot-table-container', _buildPivotTitle(config));
  ChartRenderer.setDrilldown(_allData, config);
  ChartRenderer.render(_pivotResult, 'chart-canvas');
  if (!AuthService.isEditor()) {
    PivotBuilder.renderViewerControls(_pivotResult);
  }
}

function _buildPivotTitle(config) {
  const fieldLabel = key => {
    const f = APP_CONFIG.fieldDefinitions.find(d => d.key === key);
    return f ? f.label : key;
  };
  const aggLabel = agg => {
    const a = APP_CONFIG.aggregations.find(d => d.key === agg);
    return a ? a.label.split(' ')[0] : agg.toUpperCase();
  };
  const rows = config.rows.map(fieldLabel);
  const cols = config.cols.map(fieldLabel);
  const vals = (config.values || []).map(v => `${fieldLabel(v.field)} (${aggLabel(v.agg)})`);
  const parts = [];
  if (rows.length) parts.push('Hàng: ' + rows.join(', '));
  if (cols.length) parts.push('Cột: ' + cols.join(', '));
  if (vals.length) parts.push('Giá trị: ' + vals.join(', '));
  return parts.join(' · ');
}

// ─── Saved views ────────────────────────────────────────────────────────────
function renderSavedViews() {
  const views = DataService.loadPivotViews();
  const select = document.getElementById('saved-views-select');
  if (!select) return;
  const names = Object.keys(views);
  select.innerHTML = `<option value="">— Chọn view đã lưu —</option>` +
    names.map(n => `<option value="${n}">${n}</option>`).join('');
}

function saveCurrentView() {
  const name = prompt('Đặt tên cho view này:');
  if (!name) return;
  DataService.savePivotView(name, PivotBuilder.getConfig());
  renderSavedViews();
  document.getElementById('saved-views-select').value = name;
}

// ─── Auth UI ────────────────────────────────────────────────────────────────
function setupAuth() {
  document.getElementById('btn-editor-login').addEventListener('click', () => {
    const pw = prompt('Nhập password Editor:');
    if (pw === null) return;
    if (AuthService.login(pw)) {
      AuthService.applyRoleUI();
      PivotBuilder.init(refreshPivot);
      refreshPivot();
    } else {
      alert('Sai password!');
    }
  });

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      AuthService.logout();
      AuthService.applyRoleUI();
      document.getElementById('tab-saleout').click();
      PivotBuilder.init(refreshPivot);
      refreshPivot();
    });
  }
}

// ─── Chart type selector ────────────────────────────────────────────────────
function setupChartTypeSelector() {
  document.querySelectorAll('[data-chart-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-chart-type]').forEach(b => b.classList.remove('bg-blue-600', 'text-white'));
      btn.classList.add('bg-blue-600', 'text-white');
      ChartRenderer.setType(btn.dataset.chartType);
      ChartRenderer.render(_pivotResult, 'chart-canvas');
    });
  });

  const sortSel = document.getElementById('chart-sort-select');
  if (sortSel) {
    sortSel.addEventListener('change', () => {
      ChartRenderer.setSort(sortSel.value);
      ChartRenderer.render(_pivotResult, 'chart-canvas');
    });
  }
}

// ─── Saved views controls ───────────────────────────────────────────────────
function setupSavedViewsControls() {
  const select = document.getElementById('saved-views-select');
  if (select) {
    select.addEventListener('change', () => {
      if (!select.value) return;
      const views = DataService.loadPivotViews();
      const cfg = views[select.value];
      if (cfg) { PivotBuilder.setConfig(cfg); refreshPivot(); }
    });
  }

  const saveBtn = document.getElementById('btn-save-view');
  if (saveBtn) saveBtn.addEventListener('click', saveCurrentView);

  const deleteBtn = document.getElementById('btn-delete-view');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      const select = document.getElementById('saved-views-select');
      if (!select.value) return;
      if (!confirm(`Xóa view "${select.value}"?`)) return;
      DataService.deletePivotView(select.value);
      renderSavedViews();
      PivotBuilder.setConfig({ rows: [], cols: [], values: [], filters: [] });
      refreshPivot();
    });
  }

  const downloadBtn = document.getElementById('btn-download-chart');
  if (downloadBtn) downloadBtn.addEventListener('click', () => ChartRenderer.download('chart.png'));
}

// ─── Tab switching ───────────────────────────────────────────────────────────
function setupTabs() {
  const tabPivot         = document.getElementById('tab-pivot');
  const tabDashboard     = document.getElementById('tab-dashboard');
  const tabSaleout       = document.getElementById('tab-saleout');
  const tabSpm2          = document.getElementById('tab-spm2');
  const pivotSection     = document.getElementById('pivot-section');
  const dashSection      = document.getElementById('dashboard-section');
  const saleoutSection   = document.getElementById('saleout-section');
  const sidebarPivot     = document.getElementById('sidebar-pivot');
  const sidebarDashboard = document.getElementById('sidebar-dashboard');
  const sidebarSaleout   = document.getElementById('sidebar-saleout');

  const THEME = {
    spm1: { active: ['border-blue-600',   'text-blue-600',   'bg-blue-100']   },
    spm2: { active: ['border-violet-600', 'text-violet-600', 'bg-violet-100'] },
  };
  const inactiveClass  = ['border-transparent', 'text-gray-500', 'hover:text-gray-700'];
  const ALL_ACTIVE_CLS = [...THEME.spm1.active, ...THEME.spm2.active];
  const MAIN_TABS      = [tabSaleout, tabSpm2, tabPivot, tabDashboard];
  const ALL_SUBTABS    = ['subtab-saleout-rate', 'subtab-saleout-data', 'subtab-pivot', 'subtab-dashboard'];

  function _getActiveClass() { return THEME[_activeDataset]?.active || THEME.spm1.active; }

  function setMainTabActive(tabEl) {
    const active = _getActiveClass();
    MAIN_TABS.forEach(t => {
      if (!t) return;
      t.classList.remove(...ALL_ACTIVE_CLS);
      t.classList.add(...inactiveClass);
    });
    if (tabEl) { tabEl.classList.add(...active); tabEl.classList.remove(...inactiveClass); }
  }

  function setSubTabActive(id) {
    const active = _getActiveClass();
    ALL_SUBTABS.forEach(tid => {
      const el = document.getElementById(tid);
      if (!el) return;
      if (tid === id) { el.classList.remove(...ALL_ACTIVE_CLS); el.classList.add(...active);        el.classList.remove(...inactiveClass); }
      else            { el.classList.remove(...ALL_ACTIVE_CLS); el.classList.add(...inactiveClass); }
    });
  }

  function activate(which) {
    _activeSection = which; // track cho ChatbotService
    pivotSection.style.display   = which === 'pivot'     ? 'flex' : 'none';
    dashSection.style.display    = which === 'dashboard' ? ''     : 'none';
    saleoutSection.style.display = which === 'saleout'   ? 'flex' : 'none';

    sidebarPivot.style.display     = which === 'pivot'     ? '' : 'none';
    sidebarDashboard.style.display = which === 'dashboard' ? '' : 'none';
    sidebarSaleout.style.display   = which === 'saleout'   ? '' : 'none';

    if (which === 'pivot')     setSubTabActive('subtab-pivot');
    if (which === 'dashboard') setSubTabActive('subtab-dashboard');

    if (which === 'dashboard') {
      DashboardRenderer.setData(_allData);
      DashboardRenderer.render();
    }
    if (which === 'saleout') {
      if (_activeDataset === 'spm2' && _isSpm2Loading) {
        SaleOutRenderer.setLoading(true);
      } else {
        // Luôn đọc từ localStorage để có dữ liệu mới nhất (không stale)
        SaleOutRenderer.setExtraFilters(_soFiltersFromLS(_activeDataset));
        SaleOutRenderer.setData(_saleoutData, _allData);
        SaleOutRenderer.render();
      }
    }
    if (which === 'pivot') {
      renderSavedViews();
      refreshPivot();
    }
  }

  function activateDataset(ds, mainTabEl) {
    switchDataset(ds);
    setMainTabActive(mainTabEl);
    updateDataStats();
    // Dataset tab luôn trở về saleout view
    activate('saleout');
  }

  // Expose globals để saleOutRenderer có thể dùng
  window._mainActivateTab = activate;
  window._setSubTabActive = setSubTabActive;

  tabPivot?.addEventListener('click',     () => activate('pivot'));
  tabDashboard?.addEventListener('click', () => activate('dashboard'));
  tabSaleout?.addEventListener('click',   () => activateDataset('spm1', tabSaleout));
  tabSpm2?.addEventListener('click',      () => activateDataset('spm2', tabSpm2));

  // Click handlers cho sub-tab bar cố định
  document.getElementById('subtab-pivot')?.addEventListener('click',     () => activate('pivot'));
  document.getElementById('subtab-dashboard')?.addEventListener('click', () => activate('dashboard'));

  setMainTabActive(tabSaleout);
  activate('saleout');
}

// ─── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  AuthService.applyRoleUI();
  setupAuth();
  setupChartTypeSelector();
  setupTabs();
  DashboardRenderer.init();
  PivotBuilder.init(refreshPivot);
  ImportWizard.init();
  SaleOutImport.init();
  EcnImport.init();
  ChatbotUI.init();
  ChatbotService.loadKey(); // load Groq key từ NocoDB → gọi Groq trực tiếp từ browser
  SaleOutRenderer.init();
  setupSavedViewsControls();
  renderSavedViews();

  // Import button
  const importBtn = document.getElementById('btn-import');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      ImportWizard.open((newData) => {
        // Merge new data into _allData và refresh
        loadData();
      });
    });
  }

  // Sync views button (chỉ hiện khi configTable đã cấu hình)
  const syncBtn = document.getElementById('btn-sync-views');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      // Kiểm tra ít nhất 1 namespace đã cấu hình
      DataService.setNamespace('spm1');
      const spm1Ready = DataService.isConfigStoreReady();
      DataService.setNamespace('spm2');
      const spm2Ready = DataService.isConfigStoreReady();
      DataService.setNamespace(_activeDataset); // restore
      if (!spm1Ready && !spm2Ready) {
        alert('Chưa cấu hình configTableId trong appConfig.js.\nVào appConfig.js → điền configTableId từ bảng crm_config trên NocoDB.');
        return;
      }
      const orig = syncBtn.textContent;
      syncBtn.textContent = '⏳ Đang đồng bộ...';
      syncBtn.disabled = true;
      try {
        let totalV = 0, totalS = 0, totalF = 0;
        // Đồng bộ cả 2 namespace (SPM1 + SPM2)
        for (const ns of ['spm1', 'spm2']) {
          DataService.setNamespace(ns);
          if (!DataService.isConfigStoreReady()) continue; // bỏ qua nếu chưa cấu hình
          totalV += await DataService.pushViewsToCloud();
          totalS += await DataService.pushSlicersToCloud();
          totalF += await DataService.pushSaleoutFiltersToCloud(); // đọc từ localStorage theo namespace
        }
        DataService.setNamespace(_activeDataset); // restore
        syncBtn.textContent = `✓ ${totalV} views, ${totalS} slicers, ${totalF} bộ lọc`;
        setTimeout(() => { syncBtn.textContent = orig; syncBtn.disabled = false; }, 2500);
      } catch (e) {
        DataService.setNamespace(_activeDataset); // restore dù lỗi
        syncBtn.textContent = '✕ Lỗi — xem Console';
        setTimeout(() => { syncBtn.textContent = orig; syncBtn.disabled = false; }, 3000);
        console.error('[SyncBtn]', e.message, e);
        alert('Lỗi đồng bộ: ' + e.message + '\n\nKiểm tra F12 → Console để xem chi tiết.');
      }
    });
  }

  // Export Excel button
  const exportBtn = document.getElementById('btn-export-excel');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const ds = _activeDataset === 'spm2' ? 'SPM2' : 'SPM1';

      // Detect active section by DOM visibility
      const pivotVisible   = document.getElementById('pivot-section')?.style.display !== 'none';
      const dashVisible    = document.getElementById('dashboard-section')?.style.display !== 'none';
      const saleDataVisible = document.getElementById('saleout-data-subsection')?.style.display !== 'none';

      if (pivotVisible) {
        ExportService.exportPivot(_pivotResult, ds);
      } else if (dashVisible) {
        ExportService.exportRawData(_allData, ds);
      } else if (saleDataVisible) {
        ExportService.exportSaleOut(_saleoutData, ds);
      } else {
        // TLL tab (default)
        ExportService.exportTLL(_allData, _saleoutData, SaleOutRenderer.getFilters(), ds);
      }
    });
  }

  // Import ECN button
  const importEcnBtn = document.getElementById('btn-import-ecn');
  if (importEcnBtn) {
    importEcnBtn.addEventListener('click', () => {
      EcnService.setNamespace(_activeDataset);
      EcnImport.open(async () => {
        const updated = await EcnService.fetchAll();
        if (_activeDataset === 'spm2') _spm2Ecn = updated;
        else _spm1Ecn = updated;
        SaleOutRenderer.setEcnMap(EcnService.buildEcnMap(updated));
        SaleOutRenderer.render();
      });
    });
  }

  // Import Sale Out button
  const importSaleoutBtn = document.getElementById('btn-import-saleout');
  if (importSaleoutBtn) {
    importSaleoutBtn.addEventListener('click', () => {
      SaleOutImport.open(async () => {
        await loadSaleOutData();
      });
    });
  }

  // Refresh button
  const refreshBtn = document.getElementById('btn-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', loadData);

  loadData();
});
