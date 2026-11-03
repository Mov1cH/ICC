/**
 * ICC Saint-Étienne — statistiques de visite du site (anonymes)
 * Le site envoie un signal à chaque visite / clic important ; ce script l'écrit
 * dans l'onglet « Visites ». L'onglet « Statistiques » fait le résumé.
 * Installation : Extensions → Apps Script → coller ce code → exécuter « installer »
 * → Déployer → Nouveau déploiement → Application Web (Exécuter en tant que : moi,
 *   Accès : Tout le monde) → copier l'URL /exec dans index.html (STATS_URL).
 */
const ONGLET_VISITES = 'Visites';
const ONGLET_STATS = 'Statistiques';

function doPost(e) { enregistrer_(e && e.postData ? e.postData.contents : ''); return ContentService.createTextOutput('ok'); }
function doGet(e) { if (e && e.parameter && e.parameter.type) enregistrer_(JSON.stringify(e.parameter)); return ContentService.createTextOutput('ok'); }

function enregistrer_(txt) {
  let d;
  try { d = JSON.parse(txt || '{}'); } catch (err) { return; }
  const court = v => String(v == null ? '' : v).slice(0, 80);
  const type = court(d.type || 'visite');
  if (!/^(visite|clic)$/.test(type)) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(ONGLET_VISITES) || creerVisites_();
  sh.appendRow([new Date(), type, court(d.page), court(d.detail), court(d.appareil), court(d.provenance)]);
}

function creerVisites_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(ONGLET_VISITES) || ss.insertSheet(ONGLET_VISITES);
  if (sh.getRange('A1').getValue() !== 'Date') {
    sh.getRange('A1:F1').setValues([['Date', 'Type', 'Page', 'Détail', 'Appareil', 'Provenance']])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#173D31');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('dd/MM/yyyy HH:mm');
    sh.setColumnWidths(1, 6, 150);
  }
  return sh;
}

/** À exécuter une fois : crée les onglets Visites et Statistiques avec les graphiques. */
function installer() {
  const ss = SpreadsheetApp.getActive();
  creerVisites_();
  let st = ss.getSheetByName(ONGLET_STATS);
  if (st) { st.getCharts().forEach(c => st.removeChart(c)); st.clear(); } else st = ss.insertSheet(ONGLET_STATS);

  // Tableau en français (ou autre langue à virgule décimale) : séparateur « ; » dans les formules
  const semi = !/^(en|ja|zh|ko|th|he)/.test(ss.getSpreadsheetLocale());
  const F = f => semi ? f.replace(/("[^"]*")|,/g, (x, q) => q ? q : ';') : f;

  const titre = (cell, txt) => st.getRange(cell).setValue(txt).setFontWeight('bold').setFontColor('#173D31');
  st.getRange('A1').setValue('Statistiques de visite du site').setFontSize(16).setFontWeight('bold').setFontColor('#0B132B');
  st.getRange('A2').setValue('Mis à jour automatiquement. Une « visite » = une personne qui ouvre le site (une fois par session).').setFontColor('#64748b');

  titre('A4', 'Visites');
  st.getRange('A5:B9').setValues([
    ["Aujourd'hui", '=COUNTIFS(Visites!A:A,">="&TODAY(),Visites!B:B,"visite")'],
    ['7 derniers jours', '=COUNTIFS(Visites!A:A,">="&(TODAY()-6),Visites!B:B,"visite")'],
    ['30 derniers jours', '=COUNTIFS(Visites!A:A,">="&(TODAY()-29),Visites!B:B,"visite")'],
    ['Depuis le début', '=COUNTIF(Visites!B:B,"visite")'],
    ['Clics importants (30 j)', '=COUNTIFS(Visites!A:A,">="&(TODAY()-29),Visites!B:B,"clic")']
  ].map(r => [r[0], F(r[1])]));
  st.getRange('B5:B9').setFontWeight('bold').setFontSize(13).setHorizontalAlignment('left');

  titre('D4', 'Visites par jour (30 derniers jours)');
  st.getRange('D5:E5').setValues([['Jour', 'Visites']]).setFontWeight('bold');
  st.getRange('D6').setFormula(F('=ARRAYFORMULA(TODAY()-29+SEQUENCE(30,1,0,1))'));
  st.getRange('E6').setFormula(F('=ARRAYFORMULA(COUNTIFS(Visites!A:A,">="&D6:D35,Visites!A:A,"<"&(D6:D35+1),Visites!B:B,"visite"))'));
  st.getRange('D6:D35').setNumberFormat('ddd dd/MM');

  titre('G4', 'Appareils');
  st.getRange('G5').setFormula(F('=IFERROR(QUERY(Visites!B:E,"select E, count(B) where B=\'visite\' group by E order by count(B) desc label E \'Appareil\', count(B) \'Visites\'",1),"Pas encore de visite")'));
  titre('G12', 'Provenance');
  st.getRange('G13').setFormula(F('=IFERROR(QUERY(Visites!B:F,"select F, count(B) where B=\'visite\' group by F order by count(B) desc label F \'Provenance\', count(B) \'Visites\'",1),"Pas encore de visite")'));
  titre('J4', 'Clics importants');
  st.getRange('J5').setFormula(F('=IFERROR(QUERY(Visites!B:D,"select D, count(B) where B=\'clic\' group by D order by count(B) desc label D \'Action\', count(B) \'Clics\'",1),"Pas encore de clic")'));

  st.setColumnWidth(1, 190); st.setColumnWidth(4, 110); st.setColumnWidth(7, 130); st.setColumnWidth(10, 170);

  st.insertChart(st.newChart().asColumnChart().addRange(st.getRange('D5:E35'))
    .setOption('title', 'Visites par jour').setOption('legend', { position: 'none' })
    .setOption('colors', ['#2A6A51']).setPosition(22, 1, 0, 0).setOption('width', 620).setOption('height', 300).build());
  st.insertChart(st.newChart().asPieChart().addRange(st.getRange('G5:H9'))
    .setOption('title', 'Appareils').setOption('pieHole', 0.45)
    .setOption('colors', ['#0B132B', '#2A6A51', '#D4AF37', '#A9C2B3']).setPosition(22, 8, 0, 0).setOption('width', 380).setOption('height', 300).build());
  ss.setActiveSheet(st);
}
