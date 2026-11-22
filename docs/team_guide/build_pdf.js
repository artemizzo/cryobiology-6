// Генерує docs/Mask_Picker_Instrukciya.pdf з guide.html (Chromium через Playwright).
// Запуск з кореня проєкту: node docs/team_guide/build_pdf.js
const path = require("path");
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto("file://" + path.join(__dirname, "guide.html"));
  await p.pdf({
    path: path.join(__dirname, "..", "Mask_Picker_Instrukciya.pdf"),
    format: "A4", printBackground: true, displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate: '<div style="font-size:8px;color:#888;width:100%;text-align:center;font-family:DejaVu Sans">Mask Picker — інструкція для команди · стор. <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    margin: { top: "16mm", bottom: "18mm", left: "15mm", right: "15mm" },
  });
  await b.close();
})();
