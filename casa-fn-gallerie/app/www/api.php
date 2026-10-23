<?php
// FN Avanzamento Gallerie – API JSON (richiede login)
declare(strict_types=1);
require __DIR__ . '/lib.php';
boot();

function out($data, int $code = 200): void { http_response_code($code); header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store'); echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); exit; }
function fail(string $msg, int $code = 400): void { out(['ok' => false, 'error' => $msg], $code); }
function body(): array { $j = json_decode(file_get_contents('php://input') ?: '', true); return is_array($j) ? $j : []; }
function need_post(): void {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('metodo non consentito', 405);
    $tok = $_SERVER['HTTP_X_CSRF'] ?? ($_GET['csrf'] ?? '');   // ?csrf= serve solo al salvataggio alla chiusura della pagina (sendBeacon)
    if (!hash_equals($_SESSION['csrf'] ?? '', (string)$tok)) fail('sessione scaduta: ricarica la pagina', 403);
}
function need_role(array $u, string $min): void {
    $rank = ['viewer' => 0, 'editor' => 1, 'admin' => 2];
    if (($rank[$u['role']] ?? -1) < $rank[$min]) fail('permesso negato (' . ROLES[$u['role']] . ')', 403);
}
function meta_all(): array { return jread('files.json', []); }

$u = current_user();
if (!$u) fail('accesso richiesto', 401);
$a = $_GET['a'] ?? '';

switch ($a) {
case 'me':
    out(['ok' => true, 'user' => $u['user'], 'name' => $u['name'] ?? $u['user'], 'role' => $u['role'], 'csrf' => $_SESSION['csrf'],
         'limits' => ['upload_max' => ini_get('upload_max_filesize'), 'post_max' => ini_get('post_max_size')], 'pack' => pack_meta()]);

case 'ver':   // controllo leggero: c'è una versione più nuova?
    $m = jread('state.meta.json', ['version' => 0]); out(['ok' => true] + $m);

case 'state':
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $m = jread('state.meta.json', ['version' => 0, 'savedBy' => '', 'savedAt' => '']);
        $p = DATA_DIR . '/state.json';
        header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store');
        echo '{"ok":true,"version":' . (int)$m['version'] . ',"savedBy":' . json_encode($m['savedBy']) . ',"savedAt":' . json_encode($m['savedAt']) . ',"state":' . (is_file($p) ? file_get_contents($p) : 'null') . '}';
        exit;
    }
    need_post(); need_role($u, 'editor');
    $raw = file_get_contents('php://input') ?: '';
    $j = json_decode($raw, true);
    if (!is_array($j) || !isset($j['state']) || !is_array($j['state'])) fail('dati non validi');
    $res = with_lock(function () use ($j, $u) {
        $m = jread('state.meta.json', ['version' => 0, 'savedBy' => '', 'savedAt' => '']);
        if ((int)($j['version'] ?? -1) !== (int)$m['version']) return ['conflict' => true] + $m;
        // copia di sicurezza della versione precedente (ultime 30)
        $p = DATA_DIR . '/state.json';
        if (is_file($p)) { copy($p, HIST_DIR . '/state-' . date('Ymd-His') . '-v' . $m['version'] . '.json');
            $h = glob(HIST_DIR . '/state-*.json'); sort($h); foreach (array_slice($h, 0, max(0, count($h) - 30)) as $old) @unlink($old); }
        jwrite('state.json', $j['state']);
        $m = ['version' => (int)$m['version'] + 1, 'savedBy' => $u['name'] ?? $u['user'], 'savedAt' => date('c')];
        jwrite('state.meta.json', $m);
        return $m;
    });
    if (!empty($res['conflict'])) { unset($res['conflict']); out(['ok' => false, 'conflict' => true] + $res, 409); }
    out(['ok' => true] + $res);

case 'datapack':   // pacchetto dati privato (mappe, schemi, Excel iniziale, Quadri & Fibra) - solo amministratore
    need_post(); need_role($u, 'admin');
    if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
        $e = $_FILES['file']['error'] ?? -1;
        fail($e === UPLOAD_ERR_INI_SIZE || $e === UPLOAD_ERR_FORM_SIZE ? 'file troppo grande per il server (limite ' . ini_get('upload_max_filesize') . ')' : 'caricamento non riuscito (' . $e . ')');
    }
    $raw = file_get_contents($_FILES['file']['tmp_name']);
    $p = json_decode($raw ?: '', true);
    if (!is_array($p) || ($p['tipo'] ?? '') !== 'fn-gallerie-datapack' || !isset($p['excel'], $p['qf'], $p['pdfpoi'], $p['assets']) || !is_array($p['excel']))
        fail('il file non è un pacchetto dati FN Gallerie (fn_datapack.json)');
    $res = with_lock(function () use ($raw, $p, $u) {
        file_put_contents(DATA_DIR . '/datapack.json.tmp', $raw, LOCK_EX); rename(DATA_DIR . '/datapack.json.tmp', DATA_DIR . '/datapack.json');
        $meta = ['name' => mb_substr((string)($p['nome'] ?? $_FILES['file']['name']), 0, 120), 'created' => (string)($p['creato'] ?? ''), 'at' => date('c'), 'by' => $u['name'] ?? $u['user'], 'size' => strlen($raw)];
        jwrite('datapack.meta.json', $meta);
        $st = DATA_DIR . '/state.json'; $reset = ($_POST['reset'] ?? '0') === '1' || !is_file($st);
        if ($reset && is_file($st)) {   // il progetto riparte dal pacchetto: lo stato attuale resta nelle copie di sicurezza
            $m = jread('state.meta.json', ['version' => 0]);
            copy($st, HIST_DIR . '/state-' . date('Ymd-His') . '-v' . (int)$m['version'] . '-prima-del-pacchetto.json'); unlink($st);
        }
        return ['meta' => $meta, 'reset' => $reset];
    });
    audit('pacchetto dati caricato' . ($res['reset'] ? ' (dati ripartiti dal pacchetto)' : ''));
    out(['ok' => true] + $res);

case 'files':
    out(['ok' => true, 'files' => array_values(meta_all())]);

case 'upload':
    need_post(); need_role($u, 'editor');
    if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
        $e = $_FILES['file']['error'] ?? -1;
        fail($e === UPLOAD_ERR_INI_SIZE || $e === UPLOAD_ERR_FORM_SIZE ? 'file troppo grande per il server (limite ' . ini_get('upload_max_filesize') . ')' : 'caricamento non riuscito (' . $e . ')');
    }
    $id = preg_replace('/[^a-z0-9]/', '', strtolower($_POST['id'] ?? '')) ?: bin2hex(random_bytes(8));
    $name = trim(basename(str_replace('\\', '/', (string)($_FILES['file']['name'] ?? 'file'))));
    $rec = ['id' => $id, 'name' => mb_substr($name, 0, 200), 'type' => mb_substr((string)($_POST['type'] ?? ''), 0, 100), 'size' => (int)$_FILES['file']['size'],
            'added' => (string)($_POST['added'] ?? date('c')), 'trattaId' => (string)($_POST['trattaId'] ?? ''), 'scope' => (string)($_POST['scope'] ?? ''),
            'ref' => (string)($_POST['ref'] ?? ''), 'cat' => (string)($_POST['cat'] ?? ''), 'all' => !empty($_POST['all']) && $_POST['all'] !== '0' && $_POST['all'] !== 'false', 'by' => $u['user']];
    if (!move_uploaded_file($_FILES['file']['tmp_name'], FILES_DIR . '/' . $id . '.bin')) fail('impossibile salvare il file sul server', 500);
    with_lock(function () use ($rec) { $m = meta_all(); $m[$rec['id']] = $rec; jwrite('files.json', $m); });
    audit('upload ' . $rec['name']);
    out(['ok' => true, 'file' => $rec]);

case 'file':
    $id = preg_replace('/[^a-z0-9]/', '', strtolower($_GET['id'] ?? ''));
    $m = meta_all(); if (!$id || !isset($m[$id]) || !is_file(FILES_DIR . '/' . $id . '.bin')) fail('file non trovato', 404);
    $f = $m[$id]; $type = $f['type'] ?: 'application/octet-stream';
    $inline = preg_match('#^(image/(png|jpe?g|gif|webp)|application/pdf)$#', $type);   // gli altri tipi si scaricano soltanto
    header('Content-Type: ' . ($inline ? $type : 'application/octet-stream'));
    header('Content-Length: ' . filesize(FILES_DIR . '/' . $id . '.bin'));
    header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . "; filename*=UTF-8''" . rawurlencode($f['name']));
    header('Cache-Control: private, max-age=3600');
    readfile(FILES_DIR . '/' . $id . '.bin'); exit;

case 'filemeta':   // documento comune a tutti (box / PL / telecamere) oppure solo del suo elemento
    need_post(); need_role($u, 'editor'); $b = body();
    $id = preg_replace('/[^a-z0-9]/', '', strtolower((string)($b['id'] ?? '')));
    $rec = with_lock(function () use ($id, $b) { $m = meta_all(); if (!isset($m[$id])) return null;
        if (array_key_exists('all', $b)) $m[$id]['all'] = (bool)$b['all'];
        if (isset($b['cat'])) $m[$id]['cat'] = mb_substr((string)$b['cat'], 0, 60);
        jwrite('files.json', $m); return $m[$id]; });
    if (!$rec) fail('file non trovato', 404);
    audit('documento ' . $rec['name'] . ($rec['all'] ?? false ? ' comune a tutti' : ' solo del suo elemento'));
    out(['ok' => true, 'file' => $rec]);

case 'delfile':
    need_post(); need_role($u, 'editor');
    $id = preg_replace('/[^a-z0-9]/', '', strtolower((string)(body()['id'] ?? '')));
    with_lock(function () use ($id) { $m = meta_all(); if (isset($m[$id])) { audit('elimina file ' . $m[$id]['name']); unset($m[$id]); jwrite('files.json', $m); } @unlink(FILES_DIR . '/' . $id . '.bin'); });
    out(['ok' => true]);

case 'users':
    need_role($u, 'admin');
    out(['ok' => true, 'users' => array_map(fn($x) => ['user' => $x['user'], 'name' => $x['name'] ?? '', 'role' => $x['role'], 'created' => $x['created'] ?? ''], users())]);

case 'useradd':
    need_post(); need_role($u, 'admin'); $b = body();
    $nu = trim((string)($b['user'] ?? '')); $pw = (string)($b['pass'] ?? ''); $role = (string)($b['role'] ?? 'viewer');
    if (!valid_username($nu)) fail('nome utente non valido (3-32 caratteri: lettere, numeri, . _ -)');
    if (!valid_password($pw)) fail('la password deve avere almeno 8 caratteri');
    if (!isset(ROLES[$role])) fail('ruolo non valido');
    $r = with_lock(function () use ($nu, $pw, $role, $b) { $all = users();
        foreach ($all as $x) if (strtolower($x['user']) === strtolower($nu)) return false;
        $all[] = ['user' => $nu, 'name' => mb_substr(trim((string)($b['name'] ?? $nu)), 0, 60), 'role' => $role, 'hash' => password_hash($pw, PASSWORD_DEFAULT), 'created' => date('c')];
        save_users($all); return true; });
    if (!$r) fail('utente già esistente'); audit('crea utente ' . $nu . ' (' . $role . ')'); out(['ok' => true]);

case 'userupd':
    need_post(); need_role($u, 'admin'); $b = body(); $nu = (string)($b['user'] ?? '');
    $r = with_lock(function () use ($nu, $b, $u) { $all = users(); $found = false;
        foreach ($all as &$x) if ($x['user'] === $nu) { $found = true;
            if (isset($b['role'])) { if (!isset(ROLES[$b['role']])) return 'ruolo non valido';
                if ($x['role'] === 'admin' && $b['role'] !== 'admin' && count(array_filter($all, fn($y) => $y['role'] === 'admin')) < 2) return 'deve restare almeno un amministratore';
                $x['role'] = $b['role']; }
            if (isset($b['name'])) $x['name'] = mb_substr(trim((string)$b['name']), 0, 60);
            if (!empty($b['pass'])) { if (!valid_password((string)$b['pass'])) return 'la password deve avere almeno 8 caratteri'; $x['hash'] = password_hash((string)$b['pass'], PASSWORD_DEFAULT); } }
        unset($x); if (!$found) return 'utente non trovato'; save_users($all); return ''; });
    if ($r) fail($r); audit('modifica utente ' . $nu); out(['ok' => true]);

case 'userdel':
    need_post(); need_role($u, 'admin'); $nu = (string)(body()['user'] ?? '');
    if ($nu === $u['user']) fail('non puoi eliminare il tuo utente');
    $r = with_lock(function () use ($nu) { $all = users(); $t = array_values(array_filter($all, fn($x) => $x['user'] !== $nu));
        if (!count(array_filter($t, fn($y) => $y['role'] === 'admin'))) return 'deve restare almeno un amministratore'; save_users($t); return ''; });
    if ($r) fail($r); audit('elimina utente ' . $nu); out(['ok' => true]);

case 'passwd':   // cambio della propria password
    need_post(); $b = body();
    if (!password_verify((string)($b['old'] ?? ''), $u['hash'])) fail('password attuale errata');
    if (!valid_password((string)($b['new'] ?? ''))) fail('la nuova password deve avere almeno 8 caratteri');
    with_lock(function () use ($u, $b) { $all = users(); foreach ($all as &$x) if ($x['user'] === $u['user']) $x['hash'] = password_hash((string)$b['new'], PASSWORD_DEFAULT); unset($x); save_users($all); });
    audit('cambio password'); out(['ok' => true]);

case 'history':
    need_role($u, 'admin');
    $h = glob(HIST_DIR . '/state-*.json'); rsort($h);
    out(['ok' => true, 'items' => array_map(fn($p) => ['file' => basename($p), 'size' => filesize($p)], array_slice($h, 0, 30))]);

case 'restore':
    need_post(); need_role($u, 'admin'); $f = basename((string)(body()['file'] ?? ''));
    if (!preg_match('/^state-[0-9-]+-v\d+\.json$/', $f) || !is_file(HIST_DIR . '/' . $f)) fail('copia non trovata');
    $m = with_lock(function () use ($f, $u) { $cur = jread('state.meta.json', ['version' => 0]);
        if (is_file(DATA_DIR . '/state.json')) copy(DATA_DIR . '/state.json', HIST_DIR . '/state-' . date('Ymd-His') . '-v' . $cur['version'] . '.json');
        copy(HIST_DIR . '/' . $f, DATA_DIR . '/state.json'); $m = ['version' => (int)$cur['version'] + 1, 'savedBy' => ($u['name'] ?? $u['user']) . ' (ripristino)', 'savedAt' => date('c')];
        jwrite('state.meta.json', $m); return $m; });
    audit('ripristino ' . $f); out(['ok' => true] + $m);

default:
    fail('azione sconosciuta', 404);
}
