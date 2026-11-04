/**
 * Multi-page vector PDF from SVG sheets (jsPDF + svg2pdf.js, loaded on demand so the first page load stays small).
 * Each page is `{ svg, w, h }` with the size in millimetres.
 */
export interface PdfPage {
  svg: string;
  w: number;
  h: number;
}

export async function svgsToPdf(pages: PdfPage[]): Promise<Blob> {
  const [{ jsPDF }, { svg2pdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const first = pages[0];
  const doc = new jsPDF({ unit: 'mm', format: [first.w, first.h], orientation: first.w >= first.h ? 'landscape' : 'portrait', compress: true });
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden';
  document.body.appendChild(host);
  try {
    for (let i = 0; i < pages.length; i++) {
      const pg = pages[i];
      if (i) doc.addPage([pg.w, pg.h], pg.w >= pg.h ? 'landscape' : 'portrait');
      host.innerHTML = pg.svg;
      const el = host.querySelector('svg')!;
      await svg2pdf(el, doc, { x: 0, y: 0, width: pg.w, height: pg.h });
    }
  } finally {
    host.remove();
  }
  return doc.output('blob');
}
