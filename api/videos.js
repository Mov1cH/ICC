// ICC Saint-Étienne — vidéos YouTube automatiques (version Vercel de videos.php)
// La clé API est lue dans la variable d'environnement YOUTUBE_API_KEY (réglages Vercel),
// jamais dans le code. Le résultat est gardé 5 minutes par Vercel.
const CONFIG = {
  icc: 'UCAIUeduIUX1E6sTIoW-vbUQ',     // cultes ICC (ICCTV)
  ejp: 'UCAsWGjsN_0f4T6pbDB6MY5Q',     // cultes EJP (ÉGLISE JEUNES PRODIGES TV)
  autre: 'UCAIUeduIUX1E6sTIoW-vbUQ',   // « Autres messages »
  joursAutre: 14,
  dureeMini: 180,
  forcer: { direct: '', icc: '', ejp: '', autre: '' }   // lien YouTube pour imposer une vidéo
};
const API = process.env.YT_API_BASE || 'https://www.googleapis.com/youtube/v3/';

async function api(endpoint, params) {
  const q = new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY || '' });
  const r = await fetch(API + endpoint + '?' + q);
  const j = await r.json();
  if (j.error) throw new Error('YouTube : ' + (j.error.message || 'erreur'));
  return j;
}
const idVideo = s => { s = String(s || '').trim(); const m = s.match(/(?:v=|youtu\.be\/|embed\/|live\/|shorts\/)([\w-]{11})/) || s.match(/^([\w-]{11})$/); return m ? m[1] : ''; };
const debut = v => v.liveStreamingDetails && v.liveStreamingDetails.actualStartTime;
const estDirect = v => v.snippet.liveBroadcastContent === 'live';
const estLiveTermine = v => !!debut(v) && v.snippet.liveBroadcastContent === 'none';
const estDimanche = d => new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Europe/Paris' }).format(new Date(d)) === 'Sun';
const dureeSec = v => { const m = ((v.contentDetails && v.contentDetails.duration) || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
const parDebut = (a, b) => new Date(debut(b)) - new Date(debut(a));

const memo = {};
async function videosRecentes(chaine) {
  if (memo[chaine]) return memo[chaine];
  const ids = []; let page;
  for (let i = 0; i < 2; i++) {
    const p = { part: 'contentDetails', playlistId: 'UU' + chaine.slice(2), maxResults: '50' };
    if (page) p.pageToken = page;
    const r = await api('playlistItems', p);
    (r.items || []).forEach(it => ids.push(it.contentDetails.videoId));
    page = r.nextPageToken; if (!page) break;
  }
  const vids = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await api('videos', { part: 'snippet,liveStreamingDetails,statistics,contentDetails', id: ids.slice(i, i + 50).join(',') });
    vids.push(...(r.items || []));
  }
  return (memo[chaine] = vids);
}
const dernierCulte = vids => vids.filter(v => estLiveTermine(v) && estDimanche(debut(v))).sort(parDebut)[0];
function autreMessage(vids, exclus) {
  const limite = Date.now() - CONFIG.joursAutre * 864e5;
  const c = vids.filter(v => !exclus.includes(v.id) && v.snippet.liveBroadcastContent === 'none' && dureeSec(v) >= CONFIG.dureeMini && new Date(debut(v) || v.snippet.publishedAt) >= limite);
  if (c.length) return [c.sort((a, b) => (+b.statistics.viewCount || 0) - (+a.statistics.viewCount || 0))[0], 'plus_vu'];
  const l = vids.filter(v => estLiveTermine(v) && !exclus.includes(v.id)).sort(parDebut)[0];
  return l ? [l, 'dernier_live'] : null;
}

module.exports = async (req, res) => {
  try {
    const sur = p => p.catch(e => { console.error(e.message); return []; });
    const [vIcc, vEjp, vAutre] = await Promise.all([sur(videosRecentes(CONFIG.icc)), sur(videosRecentes(CONFIG.ejp)), sur(videosRecentes(CONFIG.autre))]);
    if (!vIcc.length && !vEjp.length && !vAutre.length) throw new Error('Aucune réponse de YouTube');
    const direct = [...vIcc, ...vEjp].find(estDirect);
    const ci = dernierCulte(vIcc), ce = dernierCulte(vEjp);
    const r = {
      direct: direct ? [direct, 'live'] : null, icc: ci ? [ci, 'replay'] : null, ejp: ce ? [ce, 'replay'] : null,
      autre: autreMessage(vAutre, [direct, ci, ce].filter(Boolean).map(v => v.id))
    };
    for (const [slot, lien] of Object.entries(CONFIG.forcer)) {
      const id = idVideo(lien); if (!id) continue;
      const it = (await api('videos', { part: 'snippet,liveStreamingDetails', id })).items;
      if (it && it.length) r[slot] = [it[0], estDirect(it[0]) ? 'live' : 'force'];
    }
    const out = { maj: new Date().toISOString() };
    for (const [slot, val] of Object.entries(r)) {
      if (!val) { out[slot] = null; continue; }
      const [v, statut] = val;
      out[slot] = { id: v.id, titre: v.snippet.title, sous: v.snippet.channelTitle,
        date: new Date(debut(v) || v.snippet.publishedAt).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }), statut };
    }
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(out);
  } catch (e) {
    console.error(e.message);
    res.setHeader('Cache-Control', 's-maxage=60');
    res.status(503).json({ erreur: 'Vidéos momentanément indisponibles' });
  }
};
