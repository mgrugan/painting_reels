const ROOT_FOLDER_ID = '1tiX0WO6Lxq7ifguixI2tLi9YF5-PYcqh';
const SPREADSHEET_ID = '1OBdG1FK9s1ahg83bb_Lq0M33hLIzAv2vMgTPgf9lTi0';
const SECRET = 'PASTE_SECRET_HERE';  // the value Claude gave you in chat — never commit it

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return json({ error: 'bad request' }); }
  if (req.secret !== SECRET) return json({ error: 'unauthorized' });

  if (req.action === 'upload') {
    const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
    const folder = getOrCreateFolder(root, req.post);
    const blob = Utilities.newBlob(Utilities.base64Decode(req.data), req.mime || 'image/jpeg', req.filename);
    folder.createFile(blob);
    return json({ ok: true, folderUrl: folder.getUrl() });
  }
  if (req.action === 'addRow') {
    const sheet = getSheet(req.tab);
    if (!sheet) return json({ error: 'tab not found: ' + req.tab });
    const headers = getHeaders(sheet);
    let capCol = headers.findIndex(function (h) { return h.indexOf('caption') !== -1; });
    let linkCol = headers.findIndex(function (h) {
      return h.indexOf('link') !== -1 || h.indexOf('folder') !== -1 || h.indexOf('drive') !== -1;
    });
    if (capCol === -1) capCol = 0;
    if (linkCol === -1) linkCol = capCol + 1;
    const row = sheet.getLastRow() + 1;
    sheet.getRange(row, capCol + 1).setValue(req.caption);
    sheet.getRange(row, linkCol + 1).setValue(req.folderUrl);
    return json({ ok: true, row: row });
  }
  if (req.action === 'deleteByLink') {
    const sheet = getSheet(req.tab);
    if (!sheet) return json({ error: 'tab not found: ' + req.tab });
    const last = sheet.getLastRow();
    const lastCol = Math.max(sheet.getLastColumn(), 1);
    const data = sheet.getRange(1, 1, last, lastCol).getValues();
    const wanted = {};
    (req.urls || []).forEach(function (u) { wanted[String(u).trim()] = 1; });
    let deleted = 0;
    for (let r = last - 1; r >= 0; r--) {
      for (let c = 0; c < lastCol; c++) {
        if (wanted[String(data[r][c]).trim()] === 1) {
          sheet.deleteRow(r + 1); wanted[String(data[r][c]).trim()] = 0; deleted++; break;
        }
      }
    }
    return json({ ok: true, deleted: deleted });
  }
  return json({ error: 'unknown action' });
}
function getSheet(tab) { return SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(tab); }
function getHeaders(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).toLowerCase().trim(); });
}
function getOrCreateFolder(root, name) {
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}
function json(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
