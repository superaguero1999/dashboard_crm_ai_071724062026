// ─── App State ─────────────────────────────────────────────────────────────
let _allData     = [];
let _saleoutData = [];
let _pivotResult = null;

// ─── Load dữ liệu ─────────────────────────────────────────────────────────
async function loadData() {
  const loadingEl = document.getElementById('data-loading');
  if (loadingEl) loadingEl.style.display = '';
  try {
    _allData = await DataService.fetchAll();
  } catch (_) {
    _allData = [];
  }
  if (loadingEl) loadingEl.style.display = 'none';
  await DataService.syncViews();    // kéo views từ NocoDB về (nếu đã cấu hình)
  await DataService.syncSlicers(); // kéo slicers từ NocoDB về (nếu đã cấu hình)
  renderSavedViews();
  updateDataStats();
  refreshPivot();
  DashboardRenderer.setData(_allData);
  const dashSection = document.getElementById('dashboard-section');
  if (dashSection && dashSection.style.display !== 'none') DashboardRenderer.render();
  await loadSaleOutData();
}

async function loadSaleOutData() {
  try {
    _saleoutData = await SaleOutService.fetchAll();
  } catch (_) {
    _saleoutData = [];
  }
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
  const pivotSection     = document.getElementById('pivot-section');
  const dashSection      = document.getElementById('dashboard-section');
  const saleoutSection   = document.getElementById('saleout-section');
  const sidebarPivot     = document.getElementById('sidebar-pivot');
  const sidebarDashboard = document.getElementById('sidebar-dashboard');
  const sidebarSaleout   = document.getElementById('sidebar-saleout');

  const activeClass   = ['border-blue-600', 'text-blue-600'];
  const inactiveClass = ['border-transparent', 'text-gray-500', 'hover:text-gray-700'];

  const ALL_SUBTABS = ['subtab-saleout-rate', 'subtab-saleout-data', 'subtab-pivot', 'subtab-dashboard'];

  function setSubTabActive(id) {
    ALL_SUBTABS.forEach(tid => {
      const el = document.getElementById(tid);
      if (!el) return;
      if (tid === id) {
        el.classList.add(...activeClass);
        el.classList.remove(...inactiveClass);
      } else {
        el.classList.remove(...activeClass);
        el.classList.add(...inactiveClass);
      }
    });
  }

  function activate(which) {
    pivotSection.style.display   = which === 'pivot'     ? 'flex' : 'none';
    dashSection.style.display    = which === 'dashboard' ? ''     : 'none';
    saleoutSection.style.display = which === 'saleout'   ? 'flex' : 'none';

    sidebarPivot.style.display     = which === 'pivot'     ? '' : 'none';
    sidebarDashboard.style.display = which === 'dashboard' ? '' : 'none';
    sidebarSaleout.style.display   = which === 'saleout'   ? '' : 'none';

    [tabPivot, tabDashboard, tabSaleout].forEach(t => {
      if (!t) return;
      t.classList.remove(...activeClass);
      t.classList.add(...inactiveClass);
    });
    const activeTab = { pivot: tabPivot, dashboard: tabDashboard, saleout: tabSaleout }[which];
    if (activeTab) {
      activeTab.classList.add(...activeClass);
      activeTab.classList.remove(...inactiveClass);
    }

    if (which === 'pivot')     setSubTabActive('subtab-pivot');
    if (which === 'dashboard') setSubTabActive('subtab-dashboard');

    if (which === 'dashboard') {
      DashboardRenderer.setData(_allData);
      DashboardRenderer.render();
    }
    if (which === 'saleout') {
      SaleOutRenderer.setData(_saleoutData, _allData);
      SaleOutRenderer.render();
    }
  }

  // Expose globals để saleOutRenderer có thể dùng
  window._mainActivateTab = activate;
  window._setSubTabActive = setSubTabActive;

  tabPivot?.addEventListener('click',     () => activate('pivot'));
  tabDashboard?.addEventListener('click', () => activate('dashboard'));
  tabSaleout?.addEventListener('click',   () => activate('saleout'));

  // Click handlers cho sub-tab bar cố định
  document.getElementById('subtab-pivot')?.addEventListener('click',     () => activate('pivot'));
  document.getElementById('subtab-dashboard')?.addEventListener('click', () => activate('dashboard'));

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
      if (!DataService.isConfigStoreReady()) {
        alert('Chưa cấu hình configTableId trong appConfig.js.\nVào appConfig.js → điền configTableId từ bảng crm_config trên NocoDB.');
        return;
      }
      const orig = syncBtn.textContent;
      syncBtn.textContent = '⏳ Đang đồng bộ...';
      syncBtn.disabled = true;
      try {
        const vCount = await DataService.pushViewsToCloud();
        const sCount = await DataService.pushSlicersToCloud();
        syncBtn.textContent = `✓ ${vCount} views, ${sCount} slicers`;
        setTimeout(() => { syncBtn.textContent = orig; syncBtn.disabled = false; }, 2500);
      } catch (e) {
        syncBtn.textContent = '✕ Lỗi — xem Console';
        setTimeout(() => { syncBtn.textContent = orig; syncBtn.disabled = false; }, 3000);
        console.error('[SyncBtn]', e.message, e);
        alert('Lỗi đồng bộ: ' + e.message + '\n\nKiểm tra F12 → Console để xem chi tiết.');
      }
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
