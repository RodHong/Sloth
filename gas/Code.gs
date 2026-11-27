/**
 * 金穗鍋貼 訂單系統 — Google Apps Script 後端
 *
 * 功能
 *  - doPost：接收網站結帳資料 → 驗證 → 以「菜單」工作表重新計價 → 寫入「訂單」「訂單明細」→ 寄通知信 → 回傳訂單編號
 *  - 價格以試算表為準，不信任瀏覽器傳來的金額，避免被竄改
 *  - LockService 防止同時下單造成編號重複；CacheService 做簡易頻率限制
 *
 * 部署步驟請見 gas/README.md
 */

// ===== 設定（可依需求修改）=====
var CONFIG = {
  NOTIFY_EMAIL: '',            // 新訂單通知信收件者；留空則不寄信
  SHEET_ORDERS: '訂單',
  SHEET_ITEMS: '訂單明細',
  SHEET_MENU: '菜單',
  STATUSES: ['新訂單', '製作中', '可取餐', '已完成', '已取消'],
  ORDER_TYPES: { dinein: '內用', takeout: '外帶', delivery: '宅配' },
  MAX_LINES: 30,               // 單筆訂單最多品項數
  MAX_QTY: 99,                 // 單品最大數量
  RATE_LIMIT_SECONDS: 20       // 同一手機兩次下單的最短間隔
};

var ORDER_HEADERS = ['訂單編號', '下單時間', '狀態', '姓名', '電話', '取餐方式', '地址', '備註', '總金額'];
var ITEM_HEADERS = ['訂單編號', '品項ID', '品名', '單價', '數量', '小計'];
var MENU_HEADERS = ['ID', '分類', '品名', '單價', '供應中'];

// 初始菜單（與網站 index.html 一致）。之後改價格請直接改「菜單」工作表。
var SEED_MENU = [
  [1, '招牌鍋貼', '招牌豬肉鍋貼', 180, true],
  [2, '招牌鍋貼', '韭菜豬肉鍋貼', 190, true],
  [3, '招牌鍋貼', '麻辣牛肉鍋貼', 210, true],
  [4, '精選水餃', '經典豬肉水餃', 160, true],
  [5, '精選水餃', '高麗菜蝦仁水餃', 220, true],
  [6, '湯品/飲料', '酸辣湯', 70, true],
  [7, '湯品/飲料', '冬瓜茶', 40, true],
  [8, '經典小菜', '涼拌小黃瓜', 60, true],
  [9, '經典小菜', '滷豆干', 50, true],
  [101, '禮盒', '招牌招財鍋貼禮盒 50入', 980, true],
  [102, '禮盒', '團圓水餃家庭組 100入', 1280, true],
  [103, '禮盒', '節慶綜合禮盒', 1580, true]
];

/** 第一次使用請在編輯器手動執行一次：建立工作表、表頭、菜單與狀態下拉選單 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var orders = getOrCreateSheet_(ss, CONFIG.SHEET_ORDERS, ORDER_HEADERS);
  getOrCreateSheet_(ss, CONFIG.SHEET_ITEMS, ITEM_HEADERS);
  var menu = getOrCreateSheet_(ss, CONFIG.SHEET_MENU, MENU_HEADERS);
  if (menu.getLastRow() < 2) {
    menu.getRange(2, 1, SEED_MENU.length, MENU_HEADERS.length).setValues(SEED_MENU);
  }
  // 電話欄位一律存成純文字，避免開頭 0 被吃掉
  orders.getRange('E:E').setNumberFormat('@');
  // 「狀態」欄下拉選單
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(CONFIG.STATUSES, true).build();
  orders.getRange(2, 3, 1000, 1).setDataValidation(rule);
  menu.getRange(2, 5, 500, 1).insertCheckboxes();
  SpreadsheetApp.flush();
}

function getOrCreateSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#f3e6d6');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 健康檢查：瀏覽器直接開網址會看到 ok */
function doGet() {
  return json_({ ok: true, service: 'jinsui-orders' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var data = parseBody_(e);
    if (data.website) return json_({ ok: true, orderNumber: 'JS000000', total: 0 }); // 蜜罐欄位：機器人填了就假裝成功

    var err = validate_(data);
    if (err) return json_({ ok: false, error: err });

    var cache = CacheService.getScriptCache();
    var rlKey = 'rl_' + data.phone;
    if (cache.get(rlKey)) return json_({ ok: false, error: '操作太頻繁，請稍後再試' });

    var priced = price_(data.items);
    if (priced.error) return json_({ ok: false, error: priced.error });

    lock.waitLock(20000);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var orderNo = nextOrderNumber_();
    var now = new Date();
    var orders = ss.getSheetByName(CONFIG.SHEET_ORDERS);
    var items = ss.getSheetByName(CONFIG.SHEET_ITEMS);

    orders.appendRow([
      orderNo, now, CONFIG.STATUSES[0], data.name, data.phone,
      CONFIG.ORDER_TYPES[data.orderType], data.orderType === 'delivery' ? data.address : '',
      data.note || '', priced.total
    ]);
    var rows = priced.lines.map(function (l) { return [orderNo, l.id, l.name, l.price, l.qty, l.price * l.qty]; });
    items.getRange(items.getLastRow() + 1, 1, rows.length, ITEM_HEADERS.length).setValues(rows);
    SpreadsheetApp.flush();
    cache.put(rlKey, '1', CONFIG.RATE_LIMIT_SECONDS);
    lock.releaseLock();

    notify_(orderNo, data, priced);
    return json_({ ok: true, orderNumber: orderNo, total: priced.total });
  } catch (ex) {
    try { lock.releaseLock(); } catch (_) {}
    console.error(ex);
    return json_({ ok: false, error: '系統忙碌中，請稍後再試' });
  }
}

// ===== 內部函式 =====

function parseBody_(e) {
  var raw = (e && e.postData && e.postData.contents) || '{}';
  return JSON.parse(raw);
}

function validate_(d) {
  if (!d || typeof d !== 'object') return '資料格式錯誤';
  d.name = String(d.name || '').trim();
  d.phone = String(d.phone || '').replace(/[\s-]/g, '');
  d.address = String(d.address || '').trim();
  d.note = String(d.note || '').trim().slice(0, 200);
  if (!d.name || d.name.length > 30) return '請輸入姓名（30 字內）';
  if (!/^(09\d{8}|0\d{1,2}\d{6,8})$/.test(d.phone)) return '電話格式不正確';
  if (!CONFIG.ORDER_TYPES[d.orderType]) return '取餐方式不正確';
  if (d.orderType === 'delivery' && !d.address) return '宅配請填寫地址';
  if (d.address.length > 100) return '地址過長';
  if (!Array.isArray(d.items) || d.items.length === 0) return '購物車是空的';
  if (d.items.length > CONFIG.MAX_LINES) return '品項過多';
  for (var i = 0; i < d.items.length; i++) {
    var q = Number(d.items[i].qty);
    if (!(q >= 1 && q <= CONFIG.MAX_QTY) || q % 1 !== 0) return '數量不正確';
  }
  return '';
}

/** 以「菜單」工作表重新計價（不使用瀏覽器傳來的價格） */
function price_(items) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_MENU);
  var vals = sh.getDataRange().getValues();
  var menu = {};
  for (var r = 1; r < vals.length; r++) {
    menu[String(vals[r][0])] = { name: vals[r][2], price: Number(vals[r][3]), on: vals[r][4] === true };
  }
  var merged = {}, order = [];
  items.forEach(function (it) {
    var id = String(it.id);
    if (!(id in merged)) { merged[id] = 0; order.push(id); }
    merged[id] += Number(it.qty);
  });
  var lines = [], total = 0;
  for (var k = 0; k < order.length; k++) {
    var m = menu[order[k]];
    if (!m) return { error: '找不到品項（ID ' + order[k] + '），請重新整理後再試' };
    if (!m.on) return { error: '「' + m.name + '」目前暫停供應' };
    var qty = merged[order[k]];
    if (qty > CONFIG.MAX_QTY) return { error: '數量不正確' };
    lines.push({ id: order[k], name: m.name, price: m.price, qty: qty });
    total += m.price * qty;
  }
  return { lines: lines, total: total };
}

/** 訂單編號：JS + yyyyMMdd + 當日流水號（需在 lock 內呼叫） */
function nextOrderNumber_() {
  var props = PropertiesService.getScriptProperties();
  var day = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd');
  var last = props.getProperty('seq_day');
  var seq = last === day ? Number(props.getProperty('seq') || 0) + 1 : 1;
  props.setProperties({ seq_day: day, seq: String(seq) });
  return 'JS' + day + ('000' + seq).slice(-3);
}

function notify_(orderNo, d, p) {
  if (!CONFIG.NOTIFY_EMAIL) return;
  try {
    var lines = p.lines.map(function (l) { return l.name + ' x' + l.qty + '  NT$' + l.price * l.qty; }).join('\n');
    var body = '訂單 ' + orderNo + '\n' + CONFIG.ORDER_TYPES[d.orderType] + '\n姓名：' + d.name + '\n電話：' + d.phone +
      (d.orderType === 'delivery' ? '\n地址：' + d.address : '') + (d.note ? '\n備註：' + d.note : '') +
      '\n\n' + lines + '\n\n總計 NT$' + p.total;
    MailApp.sendEmail(CONFIG.NOTIFY_EMAIL, '【新訂單】' + orderNo + ' NT$' + p.total, body);
  } catch (ex) { console.error('通知信失敗', ex); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
