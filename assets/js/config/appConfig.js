const APP_CONFIG = {
  // ─── Auth ───────────────────────────────────────────────────────────────
  editorPassword: 'admin2024',   // Đổi password tại đây

  // ─── NocoDB ─────────────────────────────────────────────────────────────
  nocodb: {
    baseUrl: 'https://iatzhxxuk.tino.page/nocodb',
    token: 'G3QREWJrrT_E7QHPfteLJlI90zab7mUW_jNMwZIu',
    tableId: 'mg40qyo3y89upf7',          // bảng crm_data (dữ liệu lỗi - thiết kế mới)
    configTableId: 'mgu91jvt242037c',    // bảng crm_config (lưu views/settings - thiết kế mới)
    saleoutTableId: 'm2nki0bw89rgarw',   // bảng crm_saleout (sale out - thiết kế mới)
  },

  // ─── NocoDB — dataset 2: tất cả lỗi linh kiện ───────────────────────────
  // TODO: Điền Table ID sau khi tạo bảng trên NocoDB
  nocodb2: {
    baseUrl: 'https://iatzhxxuk.tino.page/nocodb',
    token: 'G3QREWJrrT_E7QHPfteLJlI90zab7mUW_jNMwZIu',
    tableId: 'masi6jzm85yarvy',          // TODO: bảng crm2_data (danh sách lỗi - tất cả)
    configTableId: 'mluc1hzp92zfp8m',    // TODO: bảng crm2_config (views/settings)
    saleoutTableId: 'mnq65gc7frjz7tv',   // TODO: bảng crm2_saleout (sale out - tất cả)
  },

  // ─── Row key: tổ hợp fields dùng để identify 1 record (merge logic) ────
  rowKeyFields: ['code'],

  // ─── Tập hợp trường dữ liệu chuẩn ──────────────────────────────────────
  // Chỉnh sửa danh sách này cho phù hợp với dữ liệu thực tế
  fieldDefinitions: [
    { key: 'Time_sudung',       label: 'Mốc sử dụng',          type: 'text',   candidates: ['mốc sử dụng'] },
    { key: 'code',       label: 'Mã yêu cầu',          type: 'text',   candidates: ['mã yêu cầu' ] },
    { key: 'month',      label: 'Tháng',          type: 'text',   candidates: ['tháng', 'month', 'thang'] },
    { key: 'model_code',      label: 'Mã sản phẩm',    type: 'text',   candidates: ['model', 'sku', 'mã sp', 'ma sp', 'product code'] },
    { key: 'product_fullname',    label: 'Tên sản phẩm',   type: 'text',   candidates: ['tên sp', 'sản phẩm', 'product name', 'ten san pham'] },
    { key: 'product_shortname',    label: 'Tên rút gọn',   type: 'text',   candidates: ['tên rút gọn'] },
    { key: 'cause',     label: 'Nguyên nhân lỗi',   type: 'text',   candidates: ['Nguyên nhân lỗi'] },
    { key: 'category',    label: 'Nhóm lỗi',   type: 'text',   candidates: ['nhóm lỗi'] },
    { key: 'err_accessory',     label: 'Linh kiện lỗi',  type: 'text',   candidates: ['linh kiện lỗi'] },
    { key: 'error_desc', label: 'Mô tả tình trạng lỗi',      type: 'text',   candidates: ['mô tả lỗi', 'mo ta loi', 'error description', 'ghi chú lỗi'] },
    { key: 'error_note',    label: 'Lưu ý thông tin lỗi linh kiện',   type: 'text',   candidates: ['Lưu ý thông tin lỗi'] },
    { key: 'method',    label: 'Phương án xử lý',   type: 'text',   candidates: ['XLSC Cách thức xử lý', 'phương án xử lý'] },
    { key: 'err_classify',    label: 'Phân loại ca lỗi',   type: 'text',   candidates: ['phân loại ca lỗi'] },
    { key: 'region',     label: 'Khu vực',        type: 'text',   candidates: ['Tỉnh', 'vùng', 'region', 'area', 'khu vuc'] },
    
    
    
 
  ],

  // ─── Aggregation functions cho Values trong pivot ────────────────────────
  aggregations: [
    { key: 'count',   label: 'Đếm (Count)' },
    { key: 'sum',     label: 'Tổng (Sum)' },
    { key: 'avg',     label: 'Trung bình (Avg)' },
    { key: 'min',     label: 'Nhỏ nhất (Min)' },
    { key: 'max',     label: 'Lớn nhất (Max)' },
    { key: 'pct',     label: 'Phần trăm tổng (%)' },
  ],

  // ─── Chart colors palette ────────────────────────────────────────────────
  chartColors: [
    '#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6',
    '#06B6D4', '#EC4899', '#84CC16', '#F97316', '#6366F1',
  ],
};
