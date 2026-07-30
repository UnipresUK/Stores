# Stores Management Dashboard

A QR-code-friendly page for the engineering team to browse stock locations (A1, A2, A3…) and submit reorder requests. Frontend is a static site (this repo, hosted on GitHub Pages); the backend is a Google Sheet + Apps Script.

## 1. Create the Google Sheet

**Use a personal Google account, not a corporate/Workspace one.** Corporate Workspace accounts commonly restrict sharing/publishing outside the organization, which blocks deploying the Apps Script Web App with "Anyone" access (step 2 below). A personal account has no such restriction. Note that email notifications will then show as sent *from* that personal account — the recipient address can still be anything you like (e.g. a work inbox).

Create a new Google Sheet with three tabs:

**`Products`** — one row per SKU. Columns are matched by header name, not position, so you can add them in any order:

| SKU | Description | Category | OEM | Supplier | Supplier Link | Datasheet Link | Location | Current Stock | Min Level | Unit | Image Filename |
|-----|-------------|----------|-----|----------|----------------|-----------------|----------|----------------|-----------|------|-----------------|
| SKU-1001 | M8 Hex Bolt 40mm | Fasteners | ISO 4017 | RS Online | https://... | https://...pdf | A1 | 4 | 5 | box of 100 | sku-1001.jpg |

- Leave `Image Filename` blank for products without a photo yet — the page falls back to a placeholder icon.
- Leave `Min Level` blank for products you don't want flagged automatically. When `Current Stock` drops to or below `Min Level`, the page shows a red "Low stock" badge on that product and it's included when the "Low stock only" filter is ticked — it's just a visual flag to prompt someone to reorder, nothing gets submitted automatically.
- `Category`, `OEM`, and `Supplier` are all optional and searchable on the page (e.g. searching "Reducer" or a supplier name matches). `OEM` is shown on the card as **"Part No:"** — it's the manufacturer/part number field.
- `Supplier Link` (optional) renders as a clickable link on the product card so whoever's ordering can jump straight to the supplier's page.
- `Datasheet Link` (optional) renders as a separate "View datasheet" link, for a technical spec sheet/PDF distinct from the supplier's purchase page.
- `Unit` (optional, e.g. "each", "box of 100") is shown next to the stock count so there's no ambiguity about what a "+1" reorder actually represents.

**`Requests`** — leave empty except for a header row, Apps Script appends to it:

| Timestamp | Requester | SKU | Qty Requested |
|-----------|-----------|-----|-----------------|

**`StockTaken`** (optional but recommended) — an audit log of who took what off the shelf; leave empty except for a header row:

| Timestamp | Requester | SKU | Qty Taken | New Stock |
|-----------|-----------|-----|-----------|-----------|

This tab is optional — if you skip it, taking stock still works and still updates `Current Stock`, it just won't be logged anywhere.

## 2. Deploy the Apps Script backend

1. In the Sheet, go to **Extensions > Apps Script**.
2. Delete the default code and paste in the contents of [`apps-script/Code.gs`](apps-script/Code.gs).
3. Update `NOTIFY_EMAIL` at the top if needed (currently `sam.pascoe@upuk-unipres.com`).
4. Click **Deploy > New deployment**.
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Authorize the requested permissions, then copy the deployment's web app URL (ends in `/exec`).

## 3. Point the frontend at the backend

Open [`app.js`](app.js) and set:

```js
const API_URL = "https://script.google.com/macros/s/XXXXXXXX/exec";
```

Leaving it blank makes the page load `products.sample.json` instead and simulate submissions — useful for testing the UI before the Sheet exists.

## 4. Enable GitHub Pages

In this repo's GitHub settings: **Settings > Pages > Source: Deploy from branch**, pick `main` and `/ (root)`. The page will be live at `https://<username>.github.io/<repo>/`.

## 5. Generate the QR code

Point any QR code generator at the Pages URL above and print it for the stores area. One shared code is enough for now — per-location codes can be added later without changing the backend.

## Adding product photos

Two ways to fill in `Image Filename`:

- **Upload to the repo (recommended for anything you want fast and reliable):** save the file into the `images/` folder and put its filename in the column (e.g. `sku-1001.jpg`). Keep it small — around 400×400px and under 150KB — so the page stays fast on phones. Uploading through GitHub's web UI (`images` folder → **Add file → Upload files**) works fine, no git needed.
- **Paste a direct image URL** (e.g. copied from a supplier's site): put the full `https://...` link in the column instead of a filename — the page detects it and loads it directly. Quicker to set up, but depends on that site keeping the image at that address, and you don't control its size/optimization. Note this must be a link to the image file itself (usually ending in `.jpg`/`.png`), not a product page — right-click the photo on the supplier's site and choose "Copy image address" to get the real link.

## How the reorder flow works

- Team member picks their name (or types a new one) and browses/searches the product list.
- Tapping **+**/**−** on a product only adjusts a local counter — nothing is sent yet.
- Once anything is flagged, a bar appears at the bottom to **Submit Order**.
- Submitting sends one batched request: it logs a row per item in `Requests` and sends a single summary email, rather than emailing on every button tap.
- Flagged quantities are saved to the device's local storage as you go, so closing the tab or reloading the page won't lose them — and the browser will warn before letting anyone navigate away or close the tab while something is still unsubmitted.
- Each device/browser is independent (name, search, and pending quantities aren't shared between devices), so multiple people can use the page from their own phones at the same time without conflicting. Submissions from different devices at the same moment are queued safely on the backend so none get lost.

## How taking stock works

Separate from reordering, each product also has a **Take stock** control so `Current Stock` reflects what's actually on the shelf without anyone having to walk around and count:

- Adjust the quantity, tap **Take**, and it's applied immediately — no confirm step, since this happens far more often than reordering and isn't worth the extra friction of a confirm screen.
- `Current Stock` is updated straight away (never going below 0), which means the "Low stock" badge and filter stay accurate automatically instead of relying on a manual stock check.
- If `StockTaken` exists, every take is logged with who, what, how much, and the resulting stock level, for traceability.
- An email is sent to `NOTIFY_EMAIL` for every single take (not batched), so you'll get one email per Take action. If usage picks up and this becomes too much volume, this is easy to change to a periodic digest instead — just ask.

## Settings and the recent removals log

The gear icon (top right) opens a small **Settings** panel with a single toggle: **"Show recent stock removals"**. It defaults to **on** the first time anyone opens the page on a given device, so you can watch every Take Stock action as it happens while the system is new — turn it off later per-device if you no longer need it.

When on, a panel above the product list shows the most recent 50 entries from `StockTaken` (who, what, how much, resulting stock), newest first, and refreshes automatically right after anyone takes stock. Requires the `StockTaken` tab to exist — without it, the panel just says there's nothing to show.
