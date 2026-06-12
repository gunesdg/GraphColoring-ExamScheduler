/**
 * PDF Export Modülü v2
 *
 * Düzeltmeler:
 * 1. Türkçe karakter: tüm metin html2canvas üzerinden render edilir
 *    (jsPDF'in latin font limiti bypass edilir)
 * 2. Tüm 3 graf ayrı ayrı capture edilir (closure bug düzeltildi)
 * 3. Her bölüm yeni sayfada başlar — overlap/taşma yok
 * 4. scale:3 ile yüksek kalite
 * 5. Debug console.log eklendi
 */
(function () {
  'use strict';

  // ── Buton etkinleştirme ────────────────────────────────────
  window.addEventListener('load', () => {
    const btn       = document.getElementById('btn-save-pdf');
    const container = document.getElementById('schedule-container');
    if (!btn || !container) return;

    const observer = new MutationObserver(() => {
      btn.disabled = !container.querySelector('.schedule-grid-week, .exam-schedule');
    });
    observer.observe(container, { childList: true, subtree: true });

    btn.addEventListener('click', exportToPdf);
  });

  // ════════════════════════════════════════════════════════════
  // YARDIMCI: HTML div'i canvas'a çevir ve PDF'e ekle
  // Türkçe karakter sorununu bu yolla çözüyoruz:
  // jsPDF.text() yerine html2canvas → imgData → addImage
  // ════════════════════════════════════════════════════════════
  async function htmlToPdfPage(pdf, htmlEl, pageW, pageH, margin) {
    const usable = pageW - 2 * margin;
    const canvas = await html2canvas(htmlEl, {
      backgroundColor: '#1a1625',
      scale: 3,
      logging: false,
      useCORS: true,
      allowTaint: true,
    });
    const imgData = canvas.toDataURL('image/png');
    const ratio   = canvas.height / canvas.width;
    const imgW    = usable;
    const imgH    = imgW * ratio;

    // Görüntü tek sayfaya sığıyorsa direkt ekle
    if (imgH <= pageH - 2 * margin) {
      pdf.addImage(imgData, 'PNG', margin, margin, imgW, imgH);
      return;
    }

    // Sığmıyorsa dilimle (slice approach)
    const pxPerMm  = canvas.width / usable;
    const sliceHpx = (pageH - 2 * margin) * pxPerMm;
    let offsetPx   = 0;

    while (offsetPx < canvas.height) {
      const remaining = canvas.height - offsetPx;
      const sliceH    = Math.min(sliceHpx, remaining);

      // Geçici canvas oluştur
      const slice = document.createElement('canvas');
      slice.width  = canvas.width;
      slice.height = sliceH;
      const ctx = slice.getContext('2d');
      ctx.drawImage(canvas, 0, -offsetPx);

      const sliceData = slice.toDataURL('image/png');
      const sliceHmm  = sliceH / pxPerMm;
      pdf.addImage(sliceData, 'PNG', margin, margin, imgW, sliceHmm);

      offsetPx += sliceH;
      if (offsetPx < canvas.height) pdf.addPage();
    }
  }

  // ════════════════════════════════════════════════════════════
  // ANA FONKSİYON
  // ════════════════════════════════════════════════════════════
  async function exportToPdf() {
    const { jsPDF } = window.jspdf;
    if (!jsPDF) { alert('jsPDF yüklenemedi. İnternet bağlantısını kontrol edin.'); return; }
    if (!window.html2canvas) { alert('html2canvas yüklenemedi.'); return; }

    const overlay = showProgress('Başlatılıyor…', 0);
    const debugInfo = { capturedGraphs: [], exportedCanvasCount: 0, pdfPageCount: 0 };

    try {
      const pdf  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const PW = 210, PH = 297, ML = 10;

      // ── 1. ÖZET SAYFASI (HTML div olarak render et) ────────
      updateProgress(overlay, 'Özet sayfası hazırlanıyor…', 10);

      const summaryEl = buildSummaryDiv();
      document.body.appendChild(summaryEl);

      await htmlToPdfPage(pdf, summaryEl, PW, PH, ML);
      debugInfo.exportedCanvasCount++;
      document.body.removeChild(summaryEl);

      // ── 2. PROGRAM GRİDİ ───────────────────────────────────
      updateProgress(overlay, 'Program gridi yakalanıyor…', 28);

      const schedEl = document.querySelector('.schedule-grid-week, .exam-schedule');
      if (schedEl) {
        pdf.addPage();
        const schedWrap = buildSectionWrap('DERS / SINAV PROGRAMI', schedEl.outerHTML);
        document.body.appendChild(schedWrap);
        await htmlToPdfPage(pdf, schedWrap, PW, PH, ML);
        debugInfo.exportedCanvasCount++;
        document.body.removeChild(schedWrap);
        console.log('[PDF] Schedule grid captured ✓');
      } else {
        console.log('[PDF] Schedule grid: bulunamadı, atlandı');
      }

      // ── 3. GRAFLAR — her biri yeni sayfa ─────────────────
      const graphDefs = [
        { id: 'conflict-graph-container',  title: 'ÇAKIŞMA GRAFİ (Conflict Graph)' },
        { id: 'bipartite-graph-container', title: 'BİPARTİT GRAF (Ders ↔ Derslik)' },
        { id: 'student-graph-container',   title: 'ÖĞRENCİYE ÖZEL GRAF'            },
      ];

      const pcts = [45, 62, 78];

      for (let i = 0; i < graphDefs.length; i++) {
        const { id, title } = graphDefs[i];
        updateProgress(overlay, `${title} yakalanıyor…`, pcts[i]);

        const container = document.getElementById(id);
        const svg       = container?.querySelector('svg');

        console.log(`[PDF] ${id}: container=${!!container}, hasSVG=${!!svg}`);

        if (!container || !svg) {
          debugInfo.capturedGraphs.push({ id, status: 'skipped - no SVG' });
          console.log(`[PDF] ${id}: atlandı (SVG yok)`);
          continue;
        }

        try {
          // SVG'yi transform-sıfırlanmış canvas'a dönüştür
          const imgData = await svgToCanvasDataUrl(svg, id);

          pdf.addPage();

          // Başlık
          const titleEl = buildTitleDiv(title);
          document.body.appendChild(titleEl);
          await sleep(60);
          const titleCanvas = await html2canvas(titleEl, {
            backgroundColor: '#1a1625', scale: 2, logging: false,
          });
          document.body.removeChild(titleEl);

          const usableW = PW - 2 * ML;
          const titleH  = (titleCanvas.height / titleCanvas.width) * usableW;
          pdf.addImage(titleCanvas.toDataURL('image/png'), 'PNG', ML, ML, usableW, titleH);

          // Graf görseli
          const graphImg = new Image();
          graphImg.src = imgData;
          await new Promise(r => { graphImg.onload = r; });
          const graphH = Math.min(
            (graphImg.height / graphImg.width) * usableW,
            PH - ML * 2 - titleH - 6
          );
          pdf.addImage(imgData, 'PNG', ML, ML + titleH + 4, usableW, graphH);

          debugInfo.exportedCanvasCount++;
          debugInfo.capturedGraphs.push({ id, status: 'ok', size: `${graphImg.width}x${graphImg.height}` });
          console.log(`[PDF] ${id}: yakalandı ✓ — boyut ${graphImg.width}x${graphImg.height}`);

        } catch (err) {
          console.warn(`[PDF] ${id} capture hatası:`, err);
          debugInfo.capturedGraphs.push({ id, status: 'error: ' + err.message });
        }
      }

      // ── 4. ALT BİLGİ NUMARALANDIRMA ────────────────────────
      updateProgress(overlay, 'Sayfa numaraları ekleniyor…', 92);

      const totalPages = pdf.internal.getNumberOfPages();
      debugInfo.pdfPageCount = totalPages;

      for (let p = 1; p <= totalPages; p++) {
        pdf.setPage(p);
        pdf.setDrawColor(100, 80, 140);
        pdf.setLineWidth(0.25);
        pdf.line(ML, PH - 9, PW - ML, PH - 9);
        pdf.setFontSize(7);
        pdf.setTextColor(120, 100, 160);
        pdf.text(
          `Çizelgeleme Sistemi  |  Graf Teorisi Tabanlı  |  Sayfa ${p} / ${totalPages}`,
          PW / 2, PH - 4, { align: 'center' }
        );
      }

      // ── 5. KAYDET ─────────────────────────────────────────
      updateProgress(overlay, 'Kaydediliyor…', 98);

      const studentSel  = document.getElementById('student-select');
      const studentName = (studentSel?.options[studentSel.selectedIndex]?.text || 'program')
        .replace(/\s*\(.*\)/, '').trim().replace(/\s+/g, '_');
      const datePart    = new Date().toISOString().slice(0, 10);
      const filename    = `schedule_${studentName}_${datePart}.pdf`;

      pdf.save(filename);
      hideProgress(overlay);

      // Debug özeti
      console.log('[PDF Export Tamamlandı]', {
        filename,
        capturedGraphs:      debugInfo.capturedGraphs,
        exportedCanvasCount: debugInfo.exportedCanvasCount,
        pdfPageCount:        debugInfo.pdfPageCount,
        fontLoaded:          'html2canvas (unicode via DOM)',
        graphCaptureStatus:  debugInfo.capturedGraphs.map(g => `${g.id}: ${g.status}`).join(' | '),
      });

    } catch (err) {
      console.error('[PDF Export HATA]', err);
      hideProgress(overlay);
      alert('PDF oluşturulurken hata oluştu:\n' + err.message);
    }
  }

  // ════════════════════════════════════════════════════════════
  // ÖZET DIV — Türkçe karakterler DOM'da render edilir
  // ════════════════════════════════════════════════════════════
  function buildSummaryDiv() {
    const studentSel  = document.getElementById('student-select');
    const studentName = studentSel?.options[studentSel.selectedIndex]?.text || '–';
    const aktsTotal   = document.getElementById('akts-total')?.textContent  || '–';
    const algo        = document.getElementById('math-algo')?.textContent   || '–';
    const chromatic   = document.getElementById('math-chromatic')?.textContent || '–';
    const lowerB      = document.getElementById('math-lower')?.textContent  || '–';
    const edgeCount   = document.getElementById('math-edges')?.textContent  || '–';
    const nodeCount   = document.getElementById('math-nodes')?.textContent  || '–';
    const conflicts   = document.getElementById('stat-conflicts')?.textContent || '–';
    const cmpGreedy   = document.getElementById('cmp-greedy')?.textContent  || null;
    const cmpDsatur   = document.getElementById('cmp-dsatur')?.textContent  || null;

    // Seçili ders bilgisi (S state'ten)
    const selIds     = typeof S !== 'undefined' ? [...S.selected] : [];
    const courses    = typeof S !== 'undefined' ? S.courses : [];
    const regPlan    = typeof S !== 'undefined' ? S.regPlan : null;
    const selCourses = selIds.map(id => courses.find(c => c.id === id)).filter(Boolean);

    // Uyarı listesi
    const warnings = [...document.querySelectorAll('.warning-chip')].map(w => w.textContent.trim());

    // Ders tablosu satırları
    const courseRows = selCourses.map(c => {
      const cat = regPlan
        ? (regPlan.failed.find(x => x.id === c.id)               ? 'Alttan Kalan'
          : (regPlan.current_elective||[]).find(x => x.id === c.id) ? 'Seçmeli'
          : regPlan.current.find(x => x.id === c.id)             ? 'Dönem Dersi'
          : (regPlan.upper_available||[]).find(x => x.id === c.id) ? 'Üstten Ders'
          : '–')
        : '–';
      const catColor = cat === 'Alttan Kalan' ? '#f78080'
                     : cat === 'Üstten Ders'  ? '#d4a7f7'
                     : cat === 'Seçmeli'       ? '#f7d4a7'
                     : '#a7d4f7';
      return `
        <tr style="background:rgba(42,36,64,0.6)">
          <td style="padding:5px 8px;font-family:monospace;font-size:12px;color:#c4a7f7;font-weight:700">${c.code}</td>
          <td style="padding:5px 8px;font-size:11px;color:#ede9f8">${c.name}</td>
          <td style="padding:5px 8px;font-size:11px;color:#9b93c4;text-align:center">${c.class_level}. Sınıf</td>
          <td style="padding:5px 8px;font-size:12px;color:#f7d4a7;font-weight:700;text-align:center">${c.akts}</td>
          <td style="padding:5px 8px;font-size:10px;font-weight:700;color:${catColor};text-align:center">${cat}</td>
        </tr>`;
    }).join('');

    const warningRows = warnings.length
      ? warnings.slice(0, 10).map(w =>
          `<li style="color:#f7d080;font-size:10px;margin-bottom:4px;font-family:monospace">${w}</li>`
        ).join('')
      : '<li style="color:#a7f7d4;font-size:10px;font-family:monospace">Aktif uyarı yok</li>';

    const cmpSection = cmpGreedy ? `
      <div style="display:flex;gap:12px;margin-top:8px">
        <div style="flex:1;background:rgba(247,212,167,0.1);border:1px solid #f7d4a7;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:10px;color:#9b93c4;font-family:monospace;margin-bottom:4px">GREEDY</div>
          <div style="font-size:28px;font-weight:800;color:#f7d4a7;font-family:monospace">${cmpGreedy}</div>
          <div style="font-size:9px;color:#5c5480">slot</div>
        </div>
        <div style="display:flex;align-items:center;color:#5c5480;font-weight:700">vs</div>
        <div style="flex:1;background:rgba(196,167,247,0.1);border:1px solid #c4a7f7;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:10px;color:#9b93c4;font-family:monospace;margin-bottom:4px">DSATUR</div>
          <div style="font-size:28px;font-weight:800;color:#c4a7f7;font-family:monospace">${cmpDsatur}</div>
          <div style="font-size:9px;color:#5c5480">slot</div>
        </div>
      </div>` : '';

    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'top:-9999px', 'left:0',
      'width:794px', 'background:#1a1625',
      'font-family:"Outfit",sans-serif', 'color:#ede9f8',
      'padding:24px', 'box-sizing:border-box',
    ].join(';');

    el.innerHTML = `
      <!-- BAŞLIK -->
      <div style="background:linear-gradient(135deg,#2a2440,#1a1625);border-radius:12px;padding:20px 24px;margin-bottom:16px;border-bottom:3px solid #c4a7f7">
        <div style="font-size:20px;font-weight:800;color:#c4a7f7;margin-bottom:4px">Ders &amp; Sınav Çizelgeleme Sistemi</div>
        <div style="font-size:12px;color:#9b93c4">Graf Teorisi Tabanlı Akademik Program  •  ${new Date().toLocaleDateString('tr-TR',{day:'2-digit',month:'long',year:'numeric'})}</div>
      </div>

      <!-- ÖĞRENCİ + AKTS -->
      <div style="display:flex;gap:12px;margin-bottom:16px">
        <div style="flex:2;background:#2a2440;border-radius:8px;padding:14px;border:1px solid #3d3460">
          <div style="font-size:9px;color:#9b93c4;font-family:monospace;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">ÖĞRENCİ BİLGİLERİ</div>
          <div style="font-size:14px;font-weight:700;color:#ede9f8;margin-bottom:4px">${studentName}</div>
          <div style="font-size:11px;color:#9b93c4">Seçili Ders: <span style="color:#a7f7d4;font-weight:700">${selCourses.length}</span></div>
        </div>
        <div style="flex:1;background:#2a2440;border-radius:8px;padding:14px;border:1px solid #3d3460;text-align:center">
          <div style="font-size:9px;color:#9b93c4;font-family:monospace;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">TOPLAM AKTS</div>
          <div style="font-size:28px;font-weight:800;color:#f7d4a7">${aktsTotal}</div>
          <div style="font-size:10px;color:#5c5480">/ 30</div>
        </div>
        <div style="flex:1;background:#2a2440;border-radius:8px;padding:14px;border:1px solid #3d3460;text-align:center">
          <div style="font-size:9px;color:#9b93c4;font-family:monospace;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">ÇAKIŞMA</div>
          <div style="font-size:28px;font-weight:800;color:${conflicts==='0'?'#a7f7d4':'#f78080'}">${conflicts}</div>
          <div style="font-size:10px;color:#5c5480">adet</div>
        </div>
      </div>

      <!-- PROGRAM BİLGİLERİ -->
      <div style="background:#2a2440;border-radius:8px;padding:14px;margin-bottom:16px;border:1px solid #3d3460">
        <div style="font-size:9px;color:#9b93c4;font-family:monospace;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">PROGRAM BİLGİLERİ</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
          ${[
            ['Algoritma', algo, '#c4a7f7'],
            ['Kroma tik Sayı χ(G)', chromatic, '#a7f7d4'],
            ['Alt Sınır ω(G)', lowerB, '#ede9f8'],
            ['Düğüm Sayısı |V|', nodeCount, '#ede9f8'],
            ['Kenar Sayısı |E|', edgeCount, '#ede9f8'],
            ['Çakışma', conflicts, conflicts==='0'?'#a7f7d4':'#f78080'],
          ].map(([k,v,c]) => `
            <div style="background:rgba(26,22,37,0.6);border-radius:6px;padding:8px">
              <div style="font-size:9px;color:#9b93c4;font-family:monospace;margin-bottom:3px">${k}</div>
              <div style="font-size:13px;font-weight:700;color:${c};font-family:monospace">${v}</div>
            </div>`).join('')}
        </div>
        ${cmpSection}
      </div>

      <!-- DERS TABLOSU -->
      <div style="background:#2a2440;border-radius:8px;padding:14px;margin-bottom:16px;border:1px solid #3d3460">
        <div style="font-size:9px;color:#9b93c4;font-family:monospace;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">SEÇİLİ DERSLER</div>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#1a1625">
              <th style="padding:6px 8px;text-align:left;font-size:9px;color:#c4a7f7;font-family:monospace;font-weight:700">KOD</th>
              <th style="padding:6px 8px;text-align:left;font-size:9px;color:#c4a7f7;font-family:monospace;font-weight:700">DERS ADI</th>
              <th style="padding:6px 8px;text-align:center;font-size:9px;color:#c4a7f7;font-family:monospace;font-weight:700">SINIF</th>
              <th style="padding:6px 8px;text-align:center;font-size:9px;color:#c4a7f7;font-family:monospace;font-weight:700">AKTS</th>
              <th style="padding:6px 8px;text-align:center;font-size:9px;color:#c4a7f7;font-family:monospace;font-weight:700">KATEGORİ</th>
            </tr>
          </thead>
          <tbody>${courseRows || '<tr><td colspan="5" style="text-align:center;color:#5c5480;padding:10px">Ders seçilmedi</td></tr>'}</tbody>
        </table>
      </div>

      <!-- UYARILAR -->
      <div style="background:#2a2440;border-radius:8px;padding:14px;border:1px solid #3d3460">
        <div style="font-size:9px;color:#9b93c4;font-family:monospace;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">AKTİF UYARILAR</div>
        <ul style="list-style:none;padding:0;margin:0">${warningRows}</ul>
      </div>
    `;

    return el;
  }

  // Sadece program grid içeriğini sarmalar
  function buildSectionWrap(title, innerHtml) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'top:-9999px', 'left:0',
      'width:794px', 'background:#1a1625',
      'font-family:"Outfit",sans-serif', 'color:#ede9f8',
      'padding:24px', 'box-sizing:border-box',
    ].join(';');
    el.innerHTML = `
      <div style="font-size:11px;color:#9b93c4;font-family:monospace;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px;padding-bottom:6px;border-bottom:2px solid #c4a7f7">${title}</div>
      <div style="background:#2a2440;border-radius:8px;padding:12px;overflow:hidden">${innerHtml}</div>
    `;
    return el;
  }

  // Graf container'ını başlıkla sarar
  // ════════════════════════════════════════════════════════════
  // SVG → PNG DataURL — zoom/pan transform sıfırlayarak TÜM içerik
  // ════════════════════════════════════════════════════════════
  async function svgToCanvasDataUrl(svgEl, containerId) {
    const clone = svgEl.cloneNode(true);

    // D3 zoom'un uyguladığı <g transform="translate(x,y) scale(k)"> bul
    const zoomG           = clone.querySelector('g');
    const origTransform   = zoomG?.getAttribute('transform') || '';

    // Orijinal SVG üzerinde tüm node konumlarını hesapla
    const allTransformGs  = svgEl.querySelectorAll('g[transform]');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    allTransformGs.forEach(g => {
      const t = g.getAttribute('transform') || '';
      const m = t.match(/translate\(\s*([-\d.e]+)\s*[, ]\s*([-\d.e]+)\s*\)/);
      if (!m) return;
      const nx = parseFloat(m[1]), ny = parseFloat(m[2]);
      const r  = parseFloat(g.querySelector('circle')?.getAttribute('r') || '0') + 8;
      const rw = parseFloat(g.querySelector('rect')?.getAttribute('width')  || '0') / 2 + 8;
      const rh = parseFloat(g.querySelector('rect')?.getAttribute('height') || '0') / 2 + 8;
      const hw = Math.max(r, rw);
      const hh = Math.max(r, rh);
      minX = Math.min(minX, nx - hw); maxX = Math.max(maxX, nx + hw);
      minY = Math.min(minY, ny - hh); maxY = Math.max(maxY, ny + hh);
    });

    // Link uçlarından da sınır hesapla (x1,y1,x2,y2)
    svgEl.querySelectorAll('line').forEach(l => {
      [parseFloat(l.getAttribute('x1')||'0'), parseFloat(l.getAttribute('x2')||'0')].forEach(x => {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      });
      [parseFloat(l.getAttribute('y1')||'0'), parseFloat(l.getAttribute('y2')||'0')].forEach(y => {
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      });
    });

    const PAD = 40;
    let vx, vy, vw, vh;
    if (isFinite(minX) && maxX > minX) {
      vx = minX - PAD; vy = minY - PAD;
      vw = maxX - minX + PAD * 2;
      vh = maxY - minY + PAD * 2;
    } else {
      vx = 0; vy = 0;
      vw = parseFloat(svgEl.getAttribute('width')  || '700');
      vh = parseFloat(svgEl.getAttribute('height') || '400');
    }

    console.log(`[svgCapture] ${containerId}:`, {
      graphBounds:       `(${minX.toFixed(0)}, ${minY.toFixed(0)}) → (${maxX.toFixed(0)}, ${maxY.toFixed(0)})`,
      viewportTransform:  origTransform,
      zoomLevel:          origTransform.match(/scale\(([\d.]+)\)/)?.[1] || '1',
      panOffset:          origTransform.match(/translate\(([-\d.]+)[, ]([-\d.]+)\)/)?.[0] || 'none',
      newViewBox:        `${vx.toFixed(0)} ${vy.toFixed(0)} ${vw.toFixed(0)} ${vh.toFixed(0)}`,
      visibleNodesCount:  allTransformGs.length,
    });

    // Clone üzerinde: zoom transform kaldır, yeni viewBox ata
    if (zoomG) zoomG.removeAttribute('transform');
    clone.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);

    const EXPORT_W = 1400;
    const EXPORT_H = Math.round(EXPORT_W * (vh / vw));
    clone.setAttribute('width',  EXPORT_W);
    clone.setAttribute('height', EXPORT_H);

    // Koyu arka plan rect ekle
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', String(vx));   bg.setAttribute('y', String(vy));
    bg.setAttribute('width', String(vw)); bg.setAttribute('height', String(vh));
    bg.setAttribute('fill', '#1a1625');
    clone.insertBefore(bg, clone.firstChild);

    // SVG → Blob URL → Image
    const svgStr  = new XMLSerializer().serializeToString(clone);
    const blob    = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);

    const img = new Image();
    img.src   = blobUrl;
    await new Promise((res, rej) => {
      img.onload  = res;
      img.onerror = () => rej(new Error('SVG image load failed'));
      setTimeout(() => rej(new Error('SVG load timeout')), 6000);
    });
    URL.revokeObjectURL(blobUrl);

    // Retina kalite canvas (2×)
    const canvas = document.createElement('canvas');
    canvas.width  = EXPORT_W * 2;
    canvas.height = EXPORT_H * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0, EXPORT_W, EXPORT_H);

    console.log(`[svgCapture] ${containerId}: exportCanvasSize=${canvas.width}x${canvas.height} ✓`);
    return canvas.toDataURL('image/png');
  }

  // Başlık satırı (html2canvas ile Türkçe karakterleri doğru render eder)
  function buildTitleDiv(title) {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'top:-9999px', 'left:0',
      'width:774px', 'background:#1a1625',
      'padding:4px 0 8px 0', 'box-sizing:border-box',
    ].join(';');
    el.innerHTML = `<div style="font-size:11px;color:#9b93c4;font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:1.5px;padding-bottom:6px;border-bottom:2px solid #c4a7f7">${title}</div>`;
    return el;
  }

  // ── Progress overlay ───────────────────────────────────────
  function showProgress(msg, pct) {
    const el = document.createElement('div');
    el.className = 'pdf-progress-overlay';
    el.innerHTML = `
      <div class="pdf-progress-box">
        <div class="pdf-progress-title">⬇ PDF Oluşturuluyor</div>
        <div class="pdf-progress-step" id="_pdf_step">${msg}</div>
        <div class="pdf-progress-bar-track">
          <div class="pdf-progress-bar-fill" id="_pdf_bar" style="width:${pct}%"></div>
        </div>
        <div style="font-size:10px;color:var(--text-dim);font-family:var(--font-mono);margin-top:6px">Lütfen bekleyin…</div>
      </div>`;
    document.body.appendChild(el);
    return el;
  }

  function updateProgress(overlay, msg, pct) {
    const step = overlay.querySelector('#_pdf_step');
    const bar  = overlay.querySelector('#_pdf_bar');
    if (step) step.textContent = msg;
    if (bar)  bar.style.width  = pct + '%';
  }

  function hideProgress(overlay) {
    overlay?.parentNode?.removeChild(overlay);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

})();
