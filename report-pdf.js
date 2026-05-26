/**
 * report-pdf.js
 * Defines window.downloadAuditPDF — called by the Download PDF button
 * in landing-page-audit-report.html. Depends on html2pdf.js being
 * loaded before this script.
 */
window.downloadAuditPDF = async function () {
  const el = document.getElementById('pdf-layout');
  if (!el) return;

  // Derive filename from audited URL if available
  var filename = 'landing-page-audit.pdf';
  try {
    var auditUrl = document.querySelector('[data-audit-url]');
    if (auditUrl && auditUrl.dataset.auditUrl) {
      var hostname = new URL(auditUrl.dataset.auditUrl).hostname.replace(/^www\./, '');
      var today = new Date().toISOString().slice(0, 10);
      filename = 'lp-audit-' + hostname + '-' + today + '.pdf';
    }
  } catch (e) {}

  // Show the hidden PDF layout
  el.style.display = 'block';

  var opt = {
    margin:     [8, 8, 8, 8],
    filename:   filename,
    image:      { type: 'jpeg', quality: 0.95 },
    html2canvas: { scale: 2, useCORS: true, logging: false },
    jsPDF:      { unit: 'mm', format: 'a4', orientation: 'portrait' },
    pagebreak:  { mode: ['avoid-all', 'css', 'legacy'] }
  };

  try {
    await html2pdf().set(opt).from(el).save();
  } catch (e) {
    console.error('PDF generation failed:', e);
  } finally {
    el.style.display = 'none';
  }
};
