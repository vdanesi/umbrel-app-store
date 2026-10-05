/* Rapportini — compilazione dei moduli PDF originali (campi AcroForm) con pdf-lib.
 *   0319  Domanda di congedo (domanda + esito + ricevuta: parti del richiedente)
 *   0692  Lettera di incarico trasferta
 *   0693  Giustificativo trasferta (rimborso indennità e km)
 * I nomi dei campi sono quelli dei PDF aziendali (alcuni sono scritti al contrario o con legature). */
(function (root) {
  'use strict';

  const MODELLI = {
    '0319': { titolo: 'Domanda di congedo', file: 'Mod. 0319' },
    '0692': { titolo: 'Lettera di incarico trasferta', file: 'Mod. 0692' },
    '0693': { titolo: 'Giustificativo trasferta', file: 'Mod. 0693' }
  };

  // ---------- utilità ----------
  const pad = n => String(n).padStart(2, '0');
  function parts(iso) {
    const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(iso || '');
    return m ? { y: m[1], m: m[2], d: m[3], yy: m[1].slice(2) } : null;
  }
  const dmy = iso => { const p = parts(iso); return p ? `${p.d}/${p.m}/${p.y}` : ''; };
  const dmyShort = iso => { const p = parts(iso); return p ? `${p.d}/${p.m}/${p.yy}` : ''; };
  const euro = n => (Number.isFinite(n) && n ? n.toFixed(2).replace('.', ',') : '');
  const numIt = v => { const n = parseFloat(String(v ?? '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

  // Helvetica dei PDF usa la codifica WinAnsi: tolgo i caratteri che non può scrivere.
  const WIN_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
  const safe = s => String(s ?? '').replace(/[\r\n\t]+/g, ' ').split('').filter(c => c.charCodeAt(0) < 256 || WIN_EXTRA.includes(c)).join('');

  async function fill(code, templateBytes, data) {
    const { PDFDocument, StandardFonts, rgb } = root.PDFLib;
    const doc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
    const form = doc.getForm();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.getPages()[0];
    const ink = rgb(0, 0, 0);

    // i modelli arrivano con qualche valore di prova ("11", "aaa"): parto da campi vuoti
    for (const f of form.getFields()) {
      if (f.constructor.name === 'PDFTextField' || typeof f.setText === 'function') { try { f.setText(''); } catch { /* campo bloccato */ } }
    }
    const set = (name, value, size = 9) => {
      let f;
      try { f = form.getTextField(name); } catch { console.warn('Campo mancante nel modulo:', name); return; }
      f.setText(safe(value));
      try { f.setFontSize(size); } catch { /* ignoro */ }
    };
    const text = (s, x, y, size = 9, f = font) => { if (s) page.drawText(safe(s), { x, y, size, font: f, color: ink }); };

    const D = data || {};
    if (code === '0319') {
      const anno = D.anno || (parts(D.dal) || parts(D.dataDomanda) || {}).y || '';
      const dd = parts(D.dataDomanda);
      // ---- domanda ----
      text(anno, 349, 750.5, 10, bold);                       // casella "concessione ANNO"
      set('SERVIZIO_1', D.servizio);
      set('UNITÀ ORGANIZZATIVA', D.unita, 8);
      set('Cognome e nome_1', D.nome);
      set('qualiﬁca', D.qualifica);
      set('aznediser', D.residenza);                          // residenza
      set('lioizivresniotnussa', dmy(D.assunto), 8.5);        // assunto in servizio il
      set('D', D.cid);                                        // C.I.D.
      set('Giornate N', D.motivo);                            // riga libera sotto la residenza
      set('lad_3', D.giornate);                               // Giornate N.
      set('lad_4', dmy(D.dal));
      set('la_2', dmy(D.al));
      set('ìl,_4', D.luogo, 8.5);                             // luogo, lì
      if (dd) {                                               // ", lì gg/mm/ 20aa": il "20" è già stampato
        set('ìl,_5', `${dd.d}/${dd.m}/`);
        try { form.getTextField('ìl,_5').setAlignment(root.PDFLib.TextAlignment.Right); } catch { /* ignoro */ }
        text(dd.yy, 223, 644.6, 9);
      }
      set('Campo di testo0', D.recapito, 8.5);               // recapito durante l'assenza
      // ---- esito: parte del richiedente ----
      set('SERVIZIO_2', D.servizio);
      set('Cognome e nome', D.nome);
      set('qualifica', D.qualifica);
      set('residenza', D.residenza);
      set('lad', D.giornate);
      set('lad_1', dmy(D.dal));
      set('la', dmy(D.al));
      // ---- ricevuta (la firma il capo diretto, i dati sono del richiedente) ----
      set('SERVIZIO', D.servizio);
      set('L’agente', D.nome);
      set('qualiﬁca_1', D.qualifica);
      set('atadniotatneserpah', dmy(D.dataDomanda));          // ha presentato in data
      set('domanda per la concessione', D.giornate);          // ... di giorni
    }

    if (code === '0692') {
      const p = parts(D.data);
      text(D.numero, 128, 698.5, 10, bold);                   // TRASFERTA N°
      if (p) { set('Campo di testo3', p.d, 10); set('Campo di testo4', p.m, 10); set('Campo di testo5', p.y, 10); }
      set('Il richiedente', D.richiedente);
      set('CID N', D.cid);
      set('Struttura Organizzativa', D.qualifica);            // il campo della riga "Qualifica"
      set('Struttura Organizzativa_1', D.struttura);
      set('viene incaricato a recarsi a', D.destinazione);
      set('Motivazione della Trasferta', D.motivazione, 8);
      const p2 = parts(D.dataFirma || D.data);
      if (p2) { set('Campo di testo0', p2.d, 9); set('Campo di testo1', p2.m, 9); set('Campo di testo2', p2.y, 9); }
    }

    if (code === '0693') {
      set('Text Field2', D.numero, 9);                        // lettera di incarico trasferta N°
      set('Text Field0', dmy(D.dataGiustificativo || D.data), 9);
      set('Text Field1', D.richiedente, 9);
      set('Text Field3', D.cid, 9);
      set('Text Field4', D.struttura, 9);
      const sfx = i => (i ? '_' + i : '');
      (D.giornate || []).slice(0, 10).forEach((g, i) => {
        set('Data' + sfx(i), dmyShort(g.data), 7);
        set('Tipo giornata (SC, R,FI, FN, FU)' + sfx(i), g.tipo, 7);
        set('Dalle ore' + sfx(i), g.dalle, 7);
        set('Alle ore' + sfx(i), g.alle, 7);
        set('Totale Straord/Flex' + sfx(i), g.totale, 7);
      });
      (D.omesse || []).slice(0, 10).forEach((g, i) => {
        const k = sfx(i + 10);
        set('Data' + k, dmyShort(g.data), 7);
        set('Tipo giornata (SC, R,FI, FN, FU)' + k, g.tipo, 7);
        set('Dalle ore' + k, g.dalle, 7);
        set('Alle ore' + k, g.alle, 7);
        set('Totale Straord/Flex' + k, g.totale, 7);
        set('Motivazione omessa timbratura' + sfx(i), g.motivo, 7);
      });
      const viaggi = (D.viaggi || []).slice(0, 5);
      if (viaggi.some(v => v.itinerario || v.km)) {
        const ekm = numIt(D.euroKm);
        set('€/km', D.tipoAuto, 9);                           // casella TIPO DI AUTO
        set('Coefficiente medio calcolato su tabelle', ekm ? String(D.euroKm).replace('.', ',') : '', 9);
        let tot = 0;
        viaggi.forEach((v, i) => {
          const km = numIt(v.km), imp = Math.round(km * ekm * 100) / 100;
          tot += imp;
          set('Nel casverifich e o' + sfx(i), dmyShort(v.data), 7);   // DATA
          set('TOTALE' + sfx(i), v.itinerario, 7);                     // ITINERARIO
          set('€_' + (i + 1), km ? String(v.km).replace('.', ',') : '', 7);   // Km
          set('Text Field' + (5 + i), euro(imp), 7);                    // RICHIESTA €
        });
        set('Text Field10', euro(tot), 6.5);
      }
    }

    form.updateFieldAppearances(font);
    return doc.save();
  }

  root.ModuliPdf = { MODELLI, fill, dmy };
})(typeof window !== 'undefined' ? window : globalThis);
