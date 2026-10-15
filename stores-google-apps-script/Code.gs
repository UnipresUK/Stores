// Stores Management backend.
// Deploy: Extensions > Apps Script > paste this in, then
// Deploy > New deployment > type "Web app" > Execute as "Me" > Who has access "Anyone".
// Copy the resulting /exec URL into the API URL field in the app settings.

var SPREADSHEET_ID      = "1hZaNIzuUfAuqBxcr616QffwvsJkxcfOKzTC7vqPv7Fo";
var NOTIFY_EMAIL        = "sam.pascoe@upuk-unipres.com";
var PRODUCTS_SHEET      = "Products";
var REQUESTS_SHEET      = "Requests";
var STOCK_LOG_SHEET     = "StockTaken";
var USERS_SHEET         = "Users";
var REORDER_QUEUE_SHEET = "ReorderQueue";
var TAKE_EMAIL_PROPERTY = "takeEmailEnabled";
var SETTINGS_PASSCODE   = "3110";

function doGet(e) {
  var action = (e.parameter && e.parameter.action) || "products";

  if (action === "transactions") {
    return jsonResponse(readRecentTransactions());
  }

  if (action === "users") {
    return jsonResponse(readUsers());
  }

  if (action === "settings") {
    if ((e.parameter.passcode || "") !== SETTINGS_PASSCODE) {
      return jsonResponse({ ok: false, error: "Invalid passcode" });
    }
    return jsonResponse({ ok: true, takeEmailEnabled: isTakeEmailEnabled() });
  }

  return jsonResponse(readProducts());
}

function doPost(e) {
  var action = (e.parameter && e.parameter.action) || "reorder";
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: "Invalid JSON body" });
  }

  // action can also be in the body when sent via fetch with text/plain
  if (body.action) action = body.action;

  if (action === "take")           return handleTakeStock(body);
  if (action === "stockTake")      return handleStockTake(body);
  if (action === "manualReorder")  return handleManualReorder(body);
  if (action === "addUser")        return handleAddUser(body);
  if (action === "updateSettings") return handleUpdateSettings(body);
  return handleReorder(body);
}

// ── Users ─────────────────────────────────────────────────────────────────────
function readUsers() {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet) return [];

  var values = sheet.getDataRange().getValues();
  var names  = [];
  for (var i = 1; i < values.length; i++) {
    var name = (values[i][0] || "").toString().trim();
    if (name) names.push(name);
  }
  return names;
}

function handleAddUser(body) {
  var name = (body.name || "").toString().trim();
  if (!name) return jsonResponse({ ok: false, error: "name is required" });

  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(USERS_SHEET);
    sheet.appendRow(["Name"]);
    sheet.getRange(1, 1).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }

  // Check it doesn't already exist (case-insensitive)
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if ((values[i][0] || "").toString().trim().toLowerCase() === name.toLowerCase()) {
      return jsonResponse({ ok: true, added: false });
    }
  }

  sheet.appendRow([name]);
  return jsonResponse({ ok: true, added: true });
}

// ── Settings ──────────────────────────────────────────────────────────────────
function isTakeEmailEnabled() {
  var stored = PropertiesService.getScriptProperties().getProperty(TAKE_EMAIL_PROPERTY);
  return stored === null ? true : stored === "true";
}

function setTakeEmailEnabled(enabled) {
  PropertiesService.getScriptProperties().setProperty(TAKE_EMAIL_PROPERTY, String(enabled));
}

function handleUpdateSettings(body) {
  if ((body.passcode || "") !== SETTINGS_PASSCODE) {
    return jsonResponse({ ok: false, error: "Invalid passcode" });
  }
  setTakeEmailEnabled(!!body.takeEmailEnabled);
  return jsonResponse({ ok: true, takeEmailEnabled: isTakeEmailEnabled() });
}

// ── Reorder request ───────────────────────────────────────────────────────────
function handleReorder(body) {
  var requester = (body.requester || "").toString().trim();
  var items = Array.isArray(body.items) ? body.items : [];

  if (!requester || items.length === 0) {
    return jsonResponse({ ok: false, error: "requester and items are required" });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    appendRequests(requester, items);
  } finally {
    lock.releaseLock();
  }

  sendNotificationEmail(requester, items);
  return jsonResponse({ ok: true });
}

// ── Take stock ────────────────────────────────────────────────────────────────
function handleTakeStock(body) {
  var requester   = (body.requester   || "").toString().trim();
  var sku         = (body.sku         || "").toString().trim();
  var qty         = Number(body.qty);
  var description = (body.description || sku).toString().trim();

  if (!requester || !sku || !qty || qty <= 0) {
    return jsonResponse({ ok: false, error: "requester, sku, and a positive qty are required" });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var result;
  try {
    result = deductStock(sku, qty);
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }

  var newStock = result.newStock;
  appendStockLog(requester, sku, description, qty, newStock);

  if (result.minLevel > 0 && newStock <= result.minLevel) {
    queueReorder(sku, description, result.location, result.oem, newStock, result.minLevel, result.maxLevel);
  }

  if (isTakeEmailEnabled()) {
    sendTakeNotificationEmail(requester, description, qty, newStock);
  }

  return jsonResponse({ ok: true, sku: sku, currentStock: newStock });
}

// ── Stock take (set absolute quantities) ──────────────────────────────────────
function handleStockTake(body) {
  if ((body.passcode || "") !== SETTINGS_PASSCODE) {
    return jsonResponse({ ok: false, error: "Invalid passcode" });
  }
  var requester = (body.requester || "Anonymous").toString().trim();
  var items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return jsonResponse({ ok: false, error: "No items provided" });

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  var results = [];
  try {
    var sheet   = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PRODUCTS_SHEET);
    var values  = sheet.getDataRange().getValues();
    var headers = values[0].map(function(h) { return h.toString().trim().toLowerCase(); });
    var skuCol  = headers.indexOf("sku");
    var stkCol  = headers.indexOf("current stock");
    var descCol = headers.indexOf("description");
    if (skuCol < 0 || stkCol < 0) throw new Error("Products sheet missing SKU or Current Stock column");

    for (var i = 0; i < items.length; i++) {
      var sku    = (items[i].sku || "").toString().trim();
      var newQty = Math.max(0, Number(items[i].qty) || 0);
      for (var r = 1; r < values.length; r++) {
        if (values[r][skuCol].toString() === sku) {
          var oldQty = Number(values[r][stkCol]) || 0;
          sheet.getRange(r + 1, stkCol + 1).setValue(newQty);
          var desc = descCol >= 0 ? values[r][descCol].toString() : sku;
          results.push({ sku: sku, description: desc, oldQty: oldQty, newQty: newQty });
          break;
        }
      }
    }
  } finally {
    lock.releaseLock();
  }

  appendStockTakeLog(requester, results);
  return jsonResponse({ ok: true, updated: results.length });
}

function appendStockTakeLog(requester, results) {
  var SHEET_NAME = "StockTakeLog";
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(["Timestamp", "Requester", "SKU", "Description", "Old Qty", "New Qty"]);
    sheet.getRange(1, 1, 1, 6).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  var ts = new Date();
  var rows = results.map(function(r) {
    return [ts, requester, r.sku, r.description, r.oldQty, r.newQty];
  });
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
}

// ── Read products ─────────────────────────────────────────────────────────────
function readProducts() {
  var sheet  = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PRODUCTS_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function(h) { return h.toString().trim().toLowerCase(); });

  var col = {
    description:   headers.indexOf("description"),
    sku:           headers.indexOf("sku"),
    location:      headers.indexOf("location"),
    currentStock:  headers.indexOf("current stock"),
    minLevel:      headers.indexOf("min level"),
    maxLevel:      headers.indexOf("max level"),
    oem:           headers.indexOf("oem"),
    partNumber:    headers.indexOf("part number"),
    supplierLink:  headers.indexOf("supplier link"),
    cost:          headers.indexOf("cost"),
    quotation:     headers.indexOf("quotation"),
    category:      headers.indexOf("category"),
    subcategory:   headers.indexOf("subcategory"),
    imageFilename: headers.indexOf("image filename"),
    datasheetLink: headers.indexOf("supplier datasheet"),
  };

  var products = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    // Skip rows with no description (column A)
    if (!row[col.description]) continue;

    products.push({
      description:   row[col.description].toString(),
      sku:           col.sku           >= 0 ? row[col.sku].toString()           : "",
      location:      col.location      >= 0 ? row[col.location].toString()      : "",
      currentStock:  col.currentStock  >= 0 ? row[col.currentStock]             : "",
      minLevel:      col.minLevel      >= 0 ? row[col.minLevel]                 : "",
      maxLevel:      col.maxLevel      >= 0 ? row[col.maxLevel]                 : "",
      oem:           col.oem           >= 0 ? row[col.oem].toString()           : "",
      partNumber:    col.partNumber    >= 0 ? row[col.partNumber].toString()    : "",
      supplierLink:  col.supplierLink  >= 0 ? row[col.supplierLink].toString()  : "",
      cost:          col.cost          >= 0 ? row[col.cost]                     : "",
      quotation:     col.quotation     >= 0 ? row[col.quotation]                : "",
      category:      col.category      >= 0 ? row[col.category].toString()      : "",
      subcategory:   col.subcategory   >= 0 ? row[col.subcategory].toString()   : "",
      imageFilename: col.imageFilename >= 0 ? row[col.imageFilename].toString() : "",
      datasheetLink: col.datasheetLink >= 0 ? row[col.datasheetLink].toString() : "",
    });
  }
  return products;
}

// ── Read transactions ─────────────────────────────────────────────────────────
function readRecentTransactions() {
  var LIMIT = 50;
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(STOCK_LOG_SHEET);
  if (!sheet) return [];

  var values  = sheet.getDataRange().getValues();
  var headers = values[0].map(function(h) { return h.toString().trim().toLowerCase(); });
  var col = {
    timestamp:   headers.indexOf("timestamp"),
    requester:   headers.indexOf("requester"),
    sku:         headers.indexOf("sku"),
    description: headers.indexOf("description"),
    qty:         headers.indexOf("qty taken"),
    newStock:    headers.indexOf("new stock"),
  };

  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[col.sku]) continue;
    var ts = col.timestamp >= 0 ? row[col.timestamp] : "";
    rows.push({
      timestamp:   ts instanceof Date ? ts.toISOString() : ts.toString(),
      requester:   col.requester   >= 0 ? row[col.requester].toString()   : "",
      sku:         row[col.sku].toString(),
      description: col.description >= 0 ? row[col.description].toString() : "",
      qty:         col.qty         >= 0 ? row[col.qty]                    : "",
      newStock:    col.newStock    >= 0 ? row[col.newStock]               : "",
    });
  }

  rows.reverse();
  return rows.slice(0, LIMIT);
}

// ── Sheet helpers ─────────────────────────────────────────────────────────────
function appendRequests(requester, items) {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(REQUESTS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(REQUESTS_SHEET);
    sheet.appendRow(["Timestamp", "Requester", "SKU", "Qty", "Description"]);
    sheet.getRange(1,1,1,5).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  var timestamp = new Date();
  var rows = items.map(function(item) {
    return [timestamp, requester, item.sku, item.qty, item.description || ""];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
}

function deductStock(sku, qty) {
  var sheet   = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(PRODUCTS_SHEET);
  var values  = sheet.getDataRange().getValues();
  var headers = values[0].map(function(h) { return h.toString().trim().toLowerCase(); });
  var skuCol  = headers.indexOf("sku");
  var stkCol  = headers.indexOf("current stock");
  var minCol  = headers.indexOf("min level");
  var maxCol  = headers.indexOf("max level");
  var locCol  = headers.indexOf("location");
  var oemCol  = headers.indexOf("oem");

  if (skuCol < 0 || stkCol < 0) {
    throw new Error("Products sheet is missing a SKU or Current Stock column");
  }

  for (var i = 1; i < values.length; i++) {
    if (values[i][skuCol].toString() === sku) {
      var current  = Number(values[i][stkCol]) || 0;
      var updated  = Math.max(0, current - qty);
      sheet.getRange(i + 1, stkCol + 1).setValue(updated);
      return {
        newStock:  updated,
        minLevel:  minCol >= 0 ? Number(values[i][minCol]) || 0 : 0,
        maxLevel:  maxCol >= 0 ? Number(values[i][maxCol]) || 0 : 0,
        location:  locCol >= 0 ? values[i][locCol].toString() : "",
        oem:       oemCol >= 0 ? values[i][oemCol].toString() : ""
      };
    }
  }

  throw new Error("SKU not found: " + sku);
}

function appendStockLog(requester, sku, description, qty, newStock) {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(STOCK_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(STOCK_LOG_SHEET);
    sheet.appendRow(["Timestamp", "Requester", "SKU", "Qty Taken", "New Stock", "Description"]);
    sheet.getRange(1,1,1,6).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([new Date(), requester, sku, qty, newStock, description]);
}

// ── Shared email HTML builder ─────────────────────────────────────────────────
function buildOrderEmailHtml(groups, oemOrder, showStock) {
  var TH = "padding:8px 14px;text-align:left;background:#4f7ef8;color:#fff;font-family:sans-serif;font-size:13px;white-space:nowrap";
  var TD = "padding:8px 14px;border-bottom:1px solid #e5e7eb;font-family:sans-serif;font-size:13px;vertical-align:middle";
  var TDc = TD + ";text-align:center;font-weight:700";

  var sections = oemOrder.map(function(oem) {
    var rows = groups[oem].map(function(item, idx) {
      var qty = item.qty !== undefined ? item.qty : (item.maxLevel > 0 ? item.maxLevel : 1);
      var partNo = item.partNumber || item.sku || "-";
      var stockCells = showStock
        ? "<td style='" + TD + "'>" + (item.location || "") + "</td>" +
          "<td style='" + TDc + "'>" + item.currentStock + "</td>"
        : "";
      var bg = idx % 2 === 0 ? "#ffffff" : "#f9fafb";
      return "<tr style='background:" + bg + "'>" +
        "<td style='" + TD + "'>" + (idx + 1) + "</td>" +
        "<td style='" + TD + ";font-family:monospace'>" + partNo + "</td>" +
        "<td style='" + TD + "'>" + item.description + "</td>" +
        stockCells +
        "<td style='" + TDc + "'>" + qty + "</td>" +
        "</tr>";
    }).join("");

    var extraHeaders = showStock
      ? "<th style='" + TH + "'>Location</th><th style='" + TH + "'>In Stock</th>"
      : "";

    return "<h3 style='font-family:sans-serif;font-size:15px;color:#1a2035;margin:24px 0 8px'>" + oem + "</h3>" +
      "<table style='border-collapse:collapse;width:100%;border-radius:6px;overflow:hidden'>" +
      "<thead><tr>" +
        "<th style='" + TH + "'>#</th>" +
        "<th style='" + TH + "'>Part Number</th>" +
        "<th style='" + TH + "'>Description</th>" +
        extraHeaders +
        "<th style='" + TH + ";text-align:center'>Qty</th>" +
      "</tr></thead>" +
      "<tbody>" + rows + "</tbody></table>";
  }).join("");

  return "<p style='font-family:sans-serif;font-size:14px'>Hello,</p>" +
    "<p style='font-family:sans-serif;font-size:14px'>Can you please order:</p>" +
    sections +
    "<p style='font-family:sans-serif;font-size:14px;margin-top:24px'>Thank you</p>";
}

// ── Manual reorder ────────────────────────────────────────────────────────────
function handleManualReorder(body) {
  var requester = (body.requester || "").toString().trim();
  var items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return jsonResponse({ ok: false, error: "No items provided" });

  var groups = {};
  var oemOrder = [];
  items.forEach(function(item) {
    var oem = (item.oem || "Other").toString().trim() || "Other";
    if (!groups[oem]) { groups[oem] = []; oemOrder.push(oem); }
    groups[oem].push(item);
  });
  oemOrder.sort();

  var note = requester ? " (requested by " + requester + ")" : "";
  var subject = "Stock order request" + note;

  MailApp.sendEmail(NOTIFY_EMAIL, subject, "", { htmlBody: buildOrderEmailHtml(groups, oemOrder, false) });
  return jsonResponse({ ok: true });
}

// ── Reorder queue ─────────────────────────────────────────────────────────────
function queueReorder(sku, description, location, oem, currentStock, minLevel, maxLevel) {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(REORDER_QUEUE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(REORDER_QUEUE_SHEET);
    sheet.appendRow(["Timestamp", "SKU", "Description", "Location", "OEM", "Current Stock", "Min Level", "Max Level", "Suggested Qty", "Sent"]);
    sheet.getRange(1, 1, 1, 10).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }

  var suggestedQty = Math.max(0, (Number(maxLevel) || 0) - (Number(currentStock) || 0));
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function(h) { return h.toString().trim().toLowerCase(); });
  var sentCol = headers.indexOf("sent");

  // Update existing unsent row for this SKU rather than duplicating
  for (var i = 1; i < values.length; i++) {
    if (values[i][1].toString() === sku && !values[i][sentCol >= 0 ? sentCol : 9]) {
      sheet.getRange(i + 1, headers.indexOf("current stock") + 1).setValue(currentStock);
      sheet.getRange(i + 1, headers.indexOf("suggested qty") + 1).setValue(suggestedQty);
      return;
    }
  }

  sheet.appendRow([new Date(), sku, description, location, oem || "", currentStock, minLevel, maxLevel, suggestedQty, false]);
}

// Called by the 4:30 PM time-based trigger.
function sendDailyReorderEmail() {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(REORDER_QUEUE_SHEET);
  if (!sheet) return;

  var values  = sheet.getDataRange().getValues();
  var headers = values[0].map(function(h) { return h.toString().trim().toLowerCase(); });
  var col = {
    sku:          headers.indexOf("sku"),
    description:  headers.indexOf("description"),
    location:     headers.indexOf("location"),
    oem:          headers.indexOf("oem"),
    currentStock: headers.indexOf("current stock"),
    minLevel:     headers.indexOf("min level"),
    maxLevel:     headers.indexOf("max level"),
    suggestedQty: headers.indexOf("suggested qty"),
    sent:         headers.indexOf("sent")
  };

  var pending = [];
  var rows    = [];

  for (var i = 1; i < values.length; i++) {
    if (!values[i][col.sent]) {
      pending.push({
        sku:          values[i][col.sku].toString(),
        description:  values[i][col.description].toString(),
        location:     values[i][col.location].toString(),
        oem:          col.oem >= 0 ? values[i][col.oem].toString() : "",
        currentStock: values[i][col.currentStock],
        minLevel:     values[i][col.minLevel],
        maxLevel:     values[i][col.maxLevel],
        suggestedQty: values[i][col.suggestedQty]
      });
      rows.push(i + 1);
    }
  }

  if (!pending.length) return;

  // Mark all as sent before emailing (avoids duplicate sends on retry)
  for (var j = 0; j < rows.length; j++) {
    sheet.getRange(rows[j], col.sent + 1).setValue(true);
  }

  // Group by OEM
  var groups = {};
  var oemOrder = [];
  pending.forEach(function(item) {
    var oem = item.oem || "Other";
    if (!groups[oem]) { groups[oem] = []; oemOrder.push(oem); }
    groups[oem].push(item);
  });
  oemOrder.sort();

  // Add qty field (max level) for the email builder
  oemOrder.forEach(function(oem) {
    groups[oem].forEach(function(item) {
      item.qty = item.maxLevel > 0 ? item.maxLevel : 1;
      item.partNumber = item.sku;
    });
  });

  var subject = "Stock reorder request";
  MailApp.sendEmail(NOTIFY_EMAIL, subject, "", { htmlBody: buildOrderEmailHtml(groups, oemOrder, true) });
}

// Run this function ONCE from the Apps Script editor to install the 4:30 PM trigger.
// Extensions > Apps Script > select installDailyReorderTrigger > Run
function installDailyReorderTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "sendDailyReorderEmail") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("sendDailyReorderEmail")
    .timeBased()
    .atHour(16)
    .nearMinute(30)
    .everyDays(1)
    .create();
  Logger.log("Reorder trigger installed: daily at 4:30 PM");
}

// ── Emails ────────────────────────────────────────────────────────────────────
function sendNotificationEmail(requester, items) {
  var lines = items.map(function(item) {
    return "  - " + item.description + "  x" + item.qty;
  });
  var subject = "Stock request from " + requester;
  var body =
    requester + " submitted a stock request:\n\n" +
    lines.join("\n") +
    "\n\nSubmitted: " + new Date().toLocaleString();
  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function sendTakeNotificationEmail(requester, description, qty, newStock) {
  var subject = requester + " took stock: " + description;
  var body =
    requester + " took " + qty + " x " + description + ".\n" +
    "New stock level: " + newStock + "\n\n" +
    "Taken: " + new Date().toLocaleString();
  MailApp.sendEmail(NOTIFY_EMAIL, subject, body);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
