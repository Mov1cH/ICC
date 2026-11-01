<?php
/**
 * ICC Saint-Étienne — vidéos YouTube automatiques pour le site
 * -------------------------------------------------------------
 * À déposer chez l'hébergeur, à côté de index.html. Aucun Google Sheet nécessaire.
 * Le site appelle ce fichier ; il interroge YouTube au plus une fois toutes les 5 minutes
 * (résultat gardé dans cache-videos.json) et renvoie :
 *   direct : live en cours (chaîne ICC ou EJP), sinon null
 *   icc    : live du dernier dimanche de la chaîne ICC
 *   ejp    : live du dernier dimanche de la chaîne EJP
 *   autre  : vidéo la plus vue des 14 derniers jours (sinon le dernier live)
 * Compatible PHP 7.4 et plus.
 */

$CONFIG = [
  // La clé API est rangée dans config-cle.php (fichier exclu de Git, à déposer à la main sur Hostinger)
  'cle_api'       => is_file(__DIR__ . '/config-cle.php') ? trim((string) require __DIR__ . '/config-cle.php') : '',
  // Chaque chaîne : ID "UC…", "@nomdelachaine" ou lien d'une vidéo de cette chaîne
  'icc'           => 'UCAIUeduIUX1E6sTIoW-vbUQ',                      // cultes ICC (ICCTV)
  'ejp'           => 'UCAsWGjsN_0f4T6pbDB6MY5Q',                      // cultes EJP : ÉGLISE JEUNES PRODIGES TV (@eglisejeunesprodiges)
  'autre'         => 'UCAIUeduIUX1E6sTIoW-vbUQ',                      // « Autres messages »
  'jours_autre'   => 14,      // période pour la vidéo la plus vue
  'duree_mini'    => 180,     // ignore les Shorts / extraits de moins de 3 min
  'cache_minutes' => 5,       // fréquence maximale d'interrogation de YouTube
  // Pour imposer une vidéo précise : coller son lien YouTube. Laisser '' = automatique.
  'forcer'        => ['direct' => '', 'icc' => '', 'ejp' => '', 'autre' => ''],
  'api_base'      => 'https://www.googleapis.com/youtube/v3/',
];

/* ======================= Ne rien modifier en dessous ======================= */

date_default_timezone_set('Europe/Paris');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if (getenv('ICC_TEST_API')) $CONFIG['api_base'] = getenv('ICC_TEST_API');
if ($CONFIG['cle_api'] === '' || strpos($CONFIG['cle_api'], 'COLLER_ICI') !== false) {
  http_response_code(503);
  echo json_encode(['erreur' => 'Clé API manquante : créer config-cle.php']);
  exit;
}

$cacheFile = is_writable(__DIR__) ? __DIR__ . '/cache-videos.json' : sys_get_temp_dir() . '/icc-cache-videos.json';
$cache = is_file($cacheFile) ? json_decode((string) @file_get_contents($cacheFile), true) : null;
$CHAINES = ($cache && isset($cache['chaines'])) ? $cache['chaines'] : [];

if ($cache && isset($cache['t']) && time() - $cache['t'] < $CONFIG['cache_minutes'] * 60) {
  echo json_encode($cache['data'], JSON_UNESCAPED_UNICODE);
  exit;
}

try {
  $data = construire($CONFIG);
  @file_put_contents($cacheFile, json_encode(['t' => time(), 'data' => $data, 'chaines' => $CHAINES], JSON_UNESCAPED_UNICODE), LOCK_EX);
  echo json_encode($data, JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
  error_log('videos.php : ' . $e->getMessage());
  if ($cache && isset($cache['data'])) {
    // YouTube indisponible : on renvoie la dernière version connue et on réessaie dans 1 minute
    $cache['t'] = time() - ($CONFIG['cache_minutes'] * 60) + 60;
    @file_put_contents($cacheFile, json_encode($cache, JSON_UNESCAPED_UNICODE), LOCK_EX);
    echo json_encode($cache['data'], JSON_UNESCAPED_UNICODE);
  } else {
    http_response_code(503);
    echo json_encode(['erreur' => 'Vidéos momentanément indisponibles']);
  }
}

/* ------------------------------------------------------------------------- */

function construire($C) {
  $vIcc = []; $vEjp = []; $vAutre = [];
  try { $vIcc = videosRecentes(idChaine($C['icc'])); } catch (Throwable $e) { error_log('ICC : ' . $e->getMessage()); }
  try { $vEjp = videosRecentes(idChaine($C['ejp'])); } catch (Throwable $e) { error_log('EJP : ' . $e->getMessage()); }
  try { $vAutre = videosRecentes(idChaine($C['autre'])); } catch (Throwable $e) { error_log('Autre : ' . $e->getMessage()); }
  if (!$vIcc && !$vEjp && !$vAutre) throw new Exception('Aucune réponse de YouTube');

  $direct = null;
  foreach (array_merge($vIcc, $vEjp) as $v) { if (estDirect($v)) { $direct = $v; break; } }
  $ci = dernierCulteDuDimanche($vIcc);
  $ce = dernierCulteDuDimanche($vEjp);
  $exclus = array_map(function ($v) { return $v['id']; }, array_filter([$direct, $ci, $ce]));
  $autre = autreMessage($vAutre, $exclus, $C);

  $res = [
    'direct' => $direct ? [$direct, 'live'] : null,
    'icc'    => $ci ? [$ci, 'replay'] : null,
    'ejp'    => $ce ? [$ce, 'replay'] : null,
    'autre'  => $autre,
  ];

  foreach ($C['forcer'] as $slot => $lien) {
    $id = idVideo($lien);
    if (!$id) continue;
    $r = api('videos', ['part' => 'snippet,liveStreamingDetails', 'id' => $id]);
    if (!empty($r['items'])) $res[$slot] = [$r['items'][0], estDirect($r['items'][0]) ? 'live' : 'force'];
  }

  $out = ['maj' => date('c')];
  foreach ($res as $slot => $r) {
    if (!$r) { $out[$slot] = null; continue; }
    list($v, $statut) = $r;
    $d = debut($v) ?: $v['snippet']['publishedAt'];
    $out[$slot] = [
      'id'     => $v['id'],
      'titre'  => $v['snippet']['title'],
      'sous'   => $v['snippet']['channelTitle'],
      'date'   => date('Y-m-d', strtotime($d)),
      'statut' => $statut,
    ];
  }
  return $out;
}

function api($endpoint, $params) {
  global $CONFIG;
  $url = $CONFIG['api_base'] . $endpoint . '?' . http_build_query($params + ['key' => $CONFIG['cle_api']]);
  if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_FOLLOWLOCATION => true]);
    $body = curl_exec($ch);
    curl_close($ch);
  } else {
    $body = @file_get_contents($url, false, stream_context_create(['http' => ['timeout' => 10, 'ignore_errors' => true]]));
  }
  $json = $body ? json_decode($body, true) : null;
  if (!$json) throw new Exception('Réponse YouTube illisible');
  if (isset($json['error'])) throw new Exception('YouTube : ' . ($json['error']['message'] ?? 'erreur'));
  return $json;
}

function idVideo($s) {
  $s = trim((string) $s);
  if (preg_match('~(?:v=|youtu\.be/|embed/|live/|shorts/)([\w-]{11})~', $s, $m)) return $m[1];
  if (preg_match('~^[\w-]{11}$~', $s)) return $s;
  return '';
}

function idChaine($ref) {
  global $CHAINES;
  $ref = trim((string) $ref);
  if (preg_match('~^UC[\w-]{22}$~', $ref)) return $ref;
  if (isset($CHAINES[$ref])) return $CHAINES[$ref];
  $id = '';
  if ($vid = idVideo($ref)) {
    $r = api('videos', ['part' => 'snippet', 'id' => $vid]);
    if (!empty($r['items'])) $id = $r['items'][0]['snippet']['channelId'];
  } else {
    $handle = preg_replace(['~^https?://(www\.)?youtube\.com/~', '~/.*$~'], '', $ref);
    if ($handle !== '' && $handle[0] === '@') {
      $r = api('channels', ['part' => 'id', 'forHandle' => $handle]);
      if (!empty($r['items'])) $id = $r['items'][0]['id'];
    }
  }
  if (!$id) throw new Exception('Chaîne introuvable : ' . $ref);
  return $CHAINES[$ref] = $id;
}

function videosRecentes($chaine) {
  static $memo = [];
  if (isset($memo[$chaine])) return $memo[$chaine];
  $ids = []; $page = null;
  for ($i = 0; $i < 2; $i++) { // 100 dernières vidéos (lives compris)
    $p = ['part' => 'contentDetails', 'playlistId' => 'UU' . substr($chaine, 2), 'maxResults' => 50];
    if ($page) $p['pageToken'] = $page;
    $r = api('playlistItems', $p);
    foreach (($r['items'] ?? []) as $it) $ids[] = $it['contentDetails']['videoId'];
    $page = $r['nextPageToken'] ?? null;
    if (!$page) break;
  }
  $vids = [];
  foreach (array_chunk($ids, 50) as $lot) {
    $r = api('videos', ['part' => 'snippet,liveStreamingDetails,statistics,contentDetails', 'id' => implode(',', $lot)]);
    $vids = array_merge($vids, $r['items'] ?? []);
  }
  return $memo[$chaine] = $vids;
}

function debut($v) { return $v['liveStreamingDetails']['actualStartTime'] ?? null; }
function estDirect($v) { return ($v['snippet']['liveBroadcastContent'] ?? '') === 'live'; }
function estLiveTermine($v) { return debut($v) && ($v['snippet']['liveBroadcastContent'] ?? '') === 'none'; }
function estDimanche($iso) { return date('N', strtotime($iso)) === '7'; }

function dureeSec($v) {
  if (!preg_match('~PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?~', $v['contentDetails']['duration'] ?? '', $m)) return 0;
  return ((int) ($m[1] ?? 0)) * 3600 + ((int) ($m[2] ?? 0)) * 60 + ((int) ($m[3] ?? 0));
}

function parDebutDecroissant($a, $b) { return strtotime(debut($b)) <=> strtotime(debut($a)); }

function dernierCulteDuDimanche($vids) {
  $l = array_values(array_filter($vids, function ($v) { return estLiveTermine($v) && estDimanche(debut($v)); }));
  usort($l, 'parDebutDecroissant');
  return $l[0] ?? null;
}

function autreMessage($vids, $exclus, $C) {
  $limite = time() - $C['jours_autre'] * 86400;
  $cand = array_values(array_filter($vids, function ($v) use ($exclus, $limite, $C) {
    return !in_array($v['id'], $exclus, true)
      && ($v['snippet']['liveBroadcastContent'] ?? '') === 'none'
      && dureeSec($v) >= $C['duree_mini']
      && strtotime(debut($v) ?: $v['snippet']['publishedAt']) >= $limite;
  }));
  if ($cand) {
    usort($cand, function ($a, $b) { return ((int) ($b['statistics']['viewCount'] ?? 0)) <=> ((int) ($a['statistics']['viewCount'] ?? 0)); });
    return [$cand[0], 'plus_vu'];
  }
  $lives = array_values(array_filter($vids, function ($v) use ($exclus) { return estLiveTermine($v) && !in_array($v['id'], $exclus, true); }));
  usort($lives, 'parDebutDecroissant');
  return $lives ? [$lives[0], 'dernier_live'] : null;
}
