'use strict';
/**
 * Create or reset a loam shop administrator.
 *
 * Interactive only: the password is read with echo disabled and is never written
 * to source, logs, shell history, or reports. Only the Argon2id hash is stored.
 *
 * Run it inside a real interactive SSH session:
 *   ssh -i <key> -p <23456> ubuntu@<host>
 *   /srv/loam-shared/bin/init-admin.sh
 *
 * Input is read in raw mode instead of readline: readline's hidden-input mode
 * repaints the line and erases the prompt text on real terminals, which makes the
 * password prompts invisible. Raw mode keeps every prompt on screen.
 */
const argon2 = require('argon2');
const { db, close } = require('./database');

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,64}$/;
const MIN_PASSWORD = 14;
const MAX_PASSWORD = 256;

function stdinEofError() {
  const err = new Error(
    'No input available: stdin closed before an answer arrived.\n' +
    '\n' +
    'Run the initializer inside a real interactive SSH session:\n' +
    '  1) ssh -i <key> -p 23456 ubuntu@49.235.181.203\n' +
    '  2) /srv/loam-shared/bin/init-admin.sh\n' +
    '\n' +
    'Do not use `ssh -t host "command"` from PowerShell/CMD: it cannot deliver keystrokes.'
  );
  err.code = 'STDIN_EOF';
  return err;
}

/**
 * Ask one question. When `echo` is false the typed characters are never written.
 * Backspace edits, Enter submits, Ctrl-C cancels, Ctrl-D on an empty line means EOF.
 */
function ask(promptText, { echo = true, stdin = process.stdin } = {}) {
  return new Promise((resolve, reject) => {
    process.stderr.write(promptText);
    const wasRaw = Boolean(stdin.isRaw);
    let value = '';
    let done = false;

    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(wasRaw); } catch (_) {}
      if (!wasRaw) stdin.pause();
      fn(arg);
    };

    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          process.stderr.write('\n');
          return finish(resolve, value);
        }
        if (ch === '\u0003') {
          process.stderr.write('\n');
          return finish(reject, new Error('Cancelled.'));
        }
        if (ch === '\u0004') {
          if (value.length === 0) {
            process.stderr.write('\n');
            return finish(reject, stdinEofError());
          }
          continue;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            if (echo) process.stderr.write('\b \b');
          }
          continue;
        }
        value += ch;
        if (echo) process.stderr.write(ch);
      }
    };

    try {
      stdin.setRawMode(true);
    } catch (_) {
      return finish(reject, stdinEofError());
    }
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

(async () => {
  if (!process.stdin.isTTY) {
    console.error(
      'This initializer needs an interactive terminal.\n' +
      'Log in with plain ssh (no remote command), then run /srv/loam-shared/bin/init-admin.sh'
    );
    process.exitCode = 1;
    return;
  }

  const username = (await ask('Admin username: ')).trim();
  if (!USERNAME_RE.test(username)) {
    throw new Error('Username must be 3-64 characters: letters, digits, dot, underscore or hyphen.');
  }

  process.stderr.write('(password is not displayed while you type; ' + MIN_PASSWORD + '+ characters)\n');
  const password = await ask('Password (hidden): ', { echo: false });
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new Error('Password must be ' + MIN_PASSWORD + '-' + MAX_PASSWORD + ' characters.');
  }
  const again = await ask('Repeat password: ', { echo: false });
  if (password !== again) throw new Error('Passwords do not match. Nothing was changed.');

  const role = process.env.LOAM_ADMIN_ROLE || db.prepare('SELECT role FROM admins WHERE username=?').get(username)?.role || 'owner';
  if (!['owner','ops','viewer'].includes(role)) throw new Error('LOAM_ADMIN_ROLE must be owner, ops or viewer.');
  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 3,
    parallelism: 1
  });

  db.prepare(
    'INSERT INTO admins(username,password_hash,created_at,role) VALUES(?,?,?,?) ' +
    'ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,disabled=0,role=excluded.role'
  ).run(username, hash, new Date().toISOString(), role);
  db.prepare('DELETE FROM sessions WHERE admin_id=(SELECT id FROM admins WHERE username=?)').run(username);

  console.log('');
  console.log('Administrator "' + username + '" saved (Argon2id, ' + role + '). Existing sessions revoked.');
  console.log('Sign in at: https://shop.getgozai.com/admin/login');
})()
  .then(() => { close(); })
  .catch((err) => {
    console.error(err && err.message ? err.message : String(err));
    try { close(); } catch (_) {}
    process.exitCode = 1;
  });
