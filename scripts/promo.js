// Управление промокодами из командной строки (локально или в Railway → Console).
//
//   node scripts/promo.js list
//   node scripts/promo.js create WELCOME30 free_days 30 --max 200 --note "Запуск"
//   node scripts/promo.js create FRIENDS   free_forever      --max 20
//   node scripts/promo.js create SALE50    percent 50        --expires 2026-12-31
//   node scripts/promo.js off WELCOME30
//   node scripts/promo.js on  WELCOME30
//   node scripts/promo.js rm  WELCOME30
//   node scripts/promo.js grant user@example.com 90     (выдать Pro на 90 дней вручную)
//   node scripts/promo.js grant user@example.com forever

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const KINDS = ['free_days', 'free_forever', 'percent'];

function opt(args, name) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'list') {
    const { rows } = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
    if (!rows.length) return console.log('(промокодов нет)');
    for (const r of rows) {
      const uses = r.max_uses == null ? `${r.used_count}/∞` : `${r.used_count}/${r.max_uses}`;
      const exp = r.expires_at ? ` до ${r.expires_at.toISOString().slice(0, 10)}` : '';
      console.log(
        `${r.active ? '●' : '○'} ${r.code.padEnd(16)} ${r.kind.padEnd(13)} ${String(r.value ?? '').padStart(4)}  ${uses}${exp}${r.note ? '  — ' + r.note : ''}`
      );
    }
    return;
  }

  if (cmd === 'create') {
    const code = (rest[0] || '').trim().toUpperCase();
    const kind = rest[1];
    if (!code || !KINDS.includes(kind)) {
      throw new Error(`Использование: create <CODE> <${KINDS.join('|')}> [value] [--max N] [--expires YYYY-MM-DD] [--note "..."]`);
    }
    let value = null;
    if (kind === 'free_days' || kind === 'percent') {
      value = parseInt(rest[2], 10);
      if (!Number.isInteger(value) || value <= 0) throw new Error(`Для ${kind} нужно положительное число (дни / проценты)`);
    }
    const maxUses = opt(rest, 'max') ? parseInt(opt(rest, 'max'), 10) : null;
    const expires = opt(rest, 'expires') || null;
    const note = opt(rest, 'note') || null;
    await pool.query(
      `INSERT INTO promo_codes (code, kind, value, max_uses, expires_at, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [code, kind, value, maxUses, expires, note]
    );
    console.log(`✅ Промокод ${code} создан (${kind}${value != null ? ' ' + value : ''}${maxUses ? ', до ' + maxUses + ' активаций' : ''})`);
    return;
  }

  if (cmd === 'on' || cmd === 'off') {
    const code = (rest[0] || '').trim().toUpperCase();
    const { rowCount } = await pool.query('UPDATE promo_codes SET active=$1 WHERE code=$2', [cmd === 'on', code]);
    console.log(rowCount ? `✅ ${code} ${cmd === 'on' ? 'включён' : 'выключен'}` : `❌ ${code} не найден`);
    return;
  }

  if (cmd === 'rm') {
    const code = (rest[0] || '').trim().toUpperCase();
    const { rowCount } = await pool.query('DELETE FROM promo_codes WHERE code=$1', [code]);
    console.log(rowCount ? `🗑 ${code} удалён` : `❌ ${code} не найден`);
    return;
  }

  if (cmd === 'grant') {
    const email = (rest[0] || '').trim().toLowerCase();
    const spec = rest[1];
    if (!email || !spec) throw new Error('Использование: grant <email> <дней|forever>');
    const q = spec === 'forever'
      ? `UPDATE users SET pro_until='2099-12-31T00:00:00Z', pro_source='manual' WHERE email=$1`
      : `UPDATE users SET pro_until = GREATEST(COALESCE(pro_until, now()), now()) + ($2 || ' days')::interval, pro_source='manual' WHERE email=$1`;
    const params = spec === 'forever' ? [email] : [email, String(parseInt(spec, 10))];
    const { rowCount } = await pool.query(q, params);
    console.log(rowCount ? `✅ ${email}: Pro ${spec === 'forever' ? 'навсегда' : 'на ' + parseInt(spec, 10) + ' дн.'}` : `❌ пользователь ${email} не найден`);
    return;
  }

  console.log('Команды: list | create | on | off | rm | grant');
}

main()
  .catch((e) => { console.error('❌', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
