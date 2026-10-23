<?php
// FN Avanzamento Gallerie – libreria comune (sessioni, utenti, file dati)
declare(strict_types=1);

const APP_DIR  = __DIR__;
const DATA_DIR = __DIR__ . '/data';
const FILES_DIR = DATA_DIR . '/files';
const HIST_DIR = DATA_DIR . '/history';
const ROLES = ['admin' => 'amministratore', 'editor' => 'modifica', 'viewer' => 'sola lettura'];
const MAX_LOGIN_FAILS = 6;          // tentativi errati consentiti...
const LOGIN_LOCK_SECONDS = 900;     // ...poi blocco di 15 minuti per utente/IP
const SESSION_IDLE = 8 * 3600;      // sessione scade dopo 8 ore di inattività

function boot(): void {
    date_default_timezone_set('Europe/Rome');
    foreach ([DATA_DIR, FILES_DIR, HIST_DIR] as $d) if (!is_dir($d)) @mkdir($d, 0750, true);
    $deny = "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n";
    if (!is_file(DATA_DIR . '/.htaccess')) @file_put_contents(DATA_DIR . '/.htaccess', $deny);
    if (!is_file(DATA_DIR . '/index.html')) @file_put_contents(DATA_DIR . '/index.html', '');
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    session_name('FNGALLSESS');
    // path '/': il cookie funziona anche dietro un proxy che pubblica la cartella sulla radice di un altro dominio
    session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Lax']);
    session_start();
    if (isset($_SESSION['u'], $_SESSION['t']) && time() - $_SESSION['t'] > SESSION_IDLE) { $_SESSION = []; session_destroy(); session_start(); }
    if (isset($_SESSION['u'])) $_SESSION['t'] = time();
    if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(16));
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
}

/* ---------- lettura/scrittura JSON con blocco ---------- */
function jread(string $file, $default) {
    $p = DATA_DIR . '/' . $file; if (!is_file($p)) return $default;
    $fh = fopen($p, 'r'); if (!$fh) return $default; flock($fh, LOCK_SH); $s = stream_get_contents($fh); flock($fh, LOCK_UN); fclose($fh);
    $v = json_decode($s, true); return $v === null ? $default : $v;
}
function jwrite(string $file, $value): void {
    $p = DATA_DIR . '/' . $file; $tmp = $p . '.' . bin2hex(random_bytes(4)) . '.tmp';
    file_put_contents($tmp, json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
    rename($tmp, $p);
}
// esegue $fn con un blocco esclusivo globale (evita scritture contemporanee)
function with_lock(callable $fn) {
    $fh = fopen(DATA_DIR . '/.lock', 'c'); flock($fh, LOCK_EX);
    try { return $fn(); } finally { flock($fh, LOCK_UN); fclose($fh); }
}

/* ---------- utenti ---------- */
function users(): array { return jread('users.json', []); }
function save_users(array $u): void { jwrite('users.json', $u); }
function current_user(): ?array {
    if (empty($_SESSION['u'])) return null;
    foreach (users() as $u) if ($u['user'] === $_SESSION['u']) return $u;
    return null;
}
function valid_username(string $u): bool { return (bool)preg_match('/^[a-zA-Z0-9._-]{3,32}$/', $u); }
function valid_password(string $p): bool { return strlen($p) >= 8; }

/* ---------- protezione accessi ---------- */
function client_ip(): string { return $_SERVER['REMOTE_ADDR'] ?? '0'; }
function login_blocked(string $user): bool {
    $f = jread('loginfails.json', []); $k = strtolower($user) . '|' . client_ip();
    return isset($f[$k]) && $f[$k]['n'] >= MAX_LOGIN_FAILS && time() - $f[$k]['t'] < LOGIN_LOCK_SECONDS;
}
function login_fail(string $user): void {
    with_lock(function () use ($user) { $f = jread('loginfails.json', []); $k = strtolower($user) . '|' . client_ip();
        if (!isset($f[$k]) || time() - $f[$k]['t'] > LOGIN_LOCK_SECONDS) $f[$k] = ['n' => 0, 't' => time()];
        $f[$k]['n']++; $f[$k]['t'] = time(); jwrite('loginfails.json', $f); });
}
function login_ok(string $user): void {
    with_lock(function () use ($user) { $f = jread('loginfails.json', []); unset($f[strtolower($user) . '|' . client_ip()]); jwrite('loginfails.json', $f); });
}
function audit(string $what): void {
    $u = $_SESSION['u'] ?? '-';
    @file_put_contents(DATA_DIR . '/accessi.log', date('c') . "\t" . client_ip() . "\t" . $u . "\t" . str_replace(["\n", "\t"], ' ', $what) . "\n", FILE_APPEND | LOCK_EX);
}
function pack_meta(): ?array { return is_file(DATA_DIR . '/datapack.json') ? jread('datapack.meta.json', ['name' => 'pacchetto', 'at' => '', 'by' => '', 'size' => filesize(DATA_DIR . '/datapack.json')]) : null; }
function h(string $s): string { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); }
