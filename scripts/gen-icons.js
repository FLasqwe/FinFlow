// Генерация иконок PWA из одного векторного описания.
// Запуск: node scripts/gen-icons.js  (нужен devDependency sharp)
// Результат кладётся в public/icons/ и коммитится — в рантайме sharp не нужен.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// Фирменный градиент — оттенок ~255 (совпадает с дефолтным акцентом приложения).
const C1 = '#7c5cff';
const C2 = '#5b3fd6';

/**
 * SVG иконки на холсте 100×100.
 * @param {number} inset  отступ марки от краёв в единицах вьюбокса (safe-zone для maskable)
 * @param {boolean} radius скруглять углы подложки (для не-maskable / favicon)
 */
function svg({ inset = 8, radius = false } = {}) {
  const r = radius ? 22 : 0;
  // Линия «рост»: ломаная снизу-слева вверх-направо. Пересчитываем под safe-zone.
  const lo = inset;
  const hi = 100 - inset;
  const x = (t) => lo + (hi - lo) * t;
  const y = (t) => lo + (hi - lo) * t;
  const pts = [
    [x(0.08), y(0.84)],
    [x(0.35), y(0.55)],
    [x(0.53), y(0.65)],
    [x(0.72), y(0.34)],
  ];
  const sw = (hi - lo) * 0.135; // толщина линии пропорционально марке
  const dot = sw * 0.6;
  // Стрелка на конце: равнобедренный треугольник, повёрнутый вдоль последнего сегмента.
  const [p2x, p2y] = pts[2];
  const [ex, ey] = pts[3];
  const ang = (Math.atan2(ey - p2y, ex - p2x) * 180) / Math.PI;
  const ah = sw * 2.15;    // длина стрелки
  const aw = sw * 2.5;     // ширина стрелки
  const tri = `M ${ah} 0 L ${-ah * 0.35} ${-aw / 2} L ${-ah * 0.35} ${aw / 2} Z`;
  // линия чуть не доходит до вершины — стрелка её перекрывает
  const poly = [pts[0], pts[1], pts[2], [ex - Math.cos((ang * Math.PI) / 180) * ah * 0.5, ey - Math.sin((ang * Math.PI) / 180) * ah * 0.5]]
    .map((p) => p.join(',')).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C1}"/>
      <stop offset="1" stop-color="${C2}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="100" height="100" rx="${r}" ry="${r}" fill="url(#g)"/>
  <g fill="none" stroke="#fff" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="${poly}"/>
  </g>
  <g fill="#fff">
    ${pts.slice(0, 3).map(([px, py]) => `<circle cx="${px}" cy="${py}" r="${dot}"/>`).join('\n    ')}
    <path d="${tri}" transform="translate(${ex} ${ey}) rotate(${ang.toFixed(2)})"/>
  </g>
</svg>`;
}

async function png(name, size, opts, { flatten = false } = {}) {
  let img = sharp(Buffer.from(svg(opts))).resize(size, size);
  if (flatten) img = img.flatten({ background: C2 });
  await img.png().toFile(path.join(OUT, name));
  console.log('  ', name, `${size}×${size}`);
}

(async () => {
  console.log('▶ Генерирую иконки в public/icons/');
  // "any" — полноразмерная марка, лёгкий отступ
  await png('icon-192.png', 192, { inset: 10, radius: false });
  await png('icon-512.png', 512, { inset: 10, radius: false });
  // maskable — марка в safe-zone (ОС может обрезать до круга)
  await png('icon-maskable-192.png', 192, { inset: 22, radius: false });
  await png('icon-maskable-512.png', 512, { inset: 22, radius: false });
  // iOS: без альфы, iOS сам скругляет
  await png('apple-touch-icon.png', 180, { inset: 12, radius: false }, { flatten: true });
  // favicon
  await png('favicon-32.png', 32, { inset: 6, radius: true });
  await png('favicon-16.png', 16, { inset: 4, radius: true });
  console.log('✅ Готово');
})().catch((e) => { console.error(e); process.exit(1); });
