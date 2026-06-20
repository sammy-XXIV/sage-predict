let puppeteer;
try { puppeteer = (await import('puppeteer')).default; } catch {}

function buildHtml(type, data) {
  const isWin     = type === 'win';
  const color     = isWin ? '#00C48C' : '#FF4D4D';
  const glow      = isWin ? 'rgba(0,196,140,0.4)' : 'rgba(255,77,77,0.35)';
  const lineGlow  = isWin ? 'rgba(59,142,255,0.5)' : 'rgba(255,77,77,0.4)';
  const dotColor  = isWin ? '#3B8EFF' : '#FF4D4D';
  const dotShadow = isWin
    ? '0 0 16px 6px rgba(59,142,255,0.5), 0 0 40px 12px rgba(59,142,255,0.2)'
    : '0 0 16px 6px rgba(255,77,77,0.4), 0 0 40px 12px rgba(255,77,77,0.15)';

  const amountStr = isWin ? `+$${data.payout.toFixed(2)}` : `-$${data.cost.toFixed(2)}`;
  const pctStr    = isWin
    ? `+${(((data.payout - data.cost) / data.cost) * 100).toFixed(0)}%`
    : `-100%`;
  const tagline   = isWin ? '' : `<div class="tagline">Next one's yours.</div>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#080B12; width:380px; height:520px; overflow:hidden; }
  .card {
    width:380px; height:520px; background:#080B12;
    display:flex; flex-direction:column; align-items:center;
    justify-content:space-between; padding:40px 32px;
    position:relative; overflow:hidden;
  }
  .card::before {
    content:''; position:absolute; inset:0;
    background-image:
      repeating-linear-gradient(0deg,rgba(26,37,64,0.3) 0px,transparent 1px,transparent 50px),
      repeating-linear-gradient(90deg,rgba(26,37,64,0.3) 0px,transparent 1px,transparent 50px);
    pointer-events:none;
  }
  .logo-wrap { display:flex; flex-direction:column; align-items:center; gap:8px; z-index:1; }
  .octagon {
    width:56px; height:56px; background:#1E6FD9;
    clip-path:polygon(30% 0%,70% 0%,100% 30%,100% 70%,70% 100%,30% 100%,0% 70%,0% 30%);
    display:flex; align-items:center; justify-content:center;
  }
  .octagon span { font-family:'Bebas Neue',sans-serif; font-size:16px; color:#fff; letter-spacing:2px; }
  .logo-label { font-family:'Inter',sans-serif; font-size:11px; color:#6B7FA3; letter-spacing:3px; text-transform:uppercase; }
  .numbers { display:flex; flex-direction:column; align-items:center; gap:10px; z-index:1; }
  .amount {
    font-family:'Bebas Neue',sans-serif; font-size:72px;
    color:${color}; letter-spacing:2px; line-height:1;
    text-shadow:0 0 40px ${glow};
  }
  .pct { font-family:'Inter',sans-serif; font-size:22px; font-weight:500; color:${color}; opacity:0.85; }
  .position-label { font-family:'Inter',sans-serif; font-size:12px; color:#6B7FA3; text-align:center; letter-spacing:0.3px; margin-top:4px; }
  .tagline { font-family:'Inter',sans-serif; font-size:11px; color:#3A4A6B; text-align:center; letter-spacing:0.5px; margin-top:2px; }
  .glow-wrap { display:flex; flex-direction:column; align-items:center; z-index:1; width:100%; }
  .glow-line { width:100%; height:1px; background:linear-gradient(90deg,transparent,${lineGlow},transparent); }
  .glow-dot {
    width:8px; height:8px; border-radius:50%; background:${dotColor};
    box-shadow:${dotShadow}; margin-top:-4px;
  }
  .footer { font-family:'Inter',sans-serif; font-size:12px; color:#3A4A6B; letter-spacing:1.5px; text-transform:uppercase; z-index:1; }
</style>
</head>
<body>
<div class="card">
  <div class="logo-wrap">
    <div class="octagon"><span>SAGE</span></div>
    <span class="logo-label">Prediction Market</span>
  </div>
  <div class="numbers">
    <div class="amount">${amountStr}</div>
    <div class="pct">${pctStr}</div>
    <div class="position-label">${data.label}</div>
    ${tagline}
  </div>
  <div class="glow-wrap">
    <div class="glow-line"></div>
    <div class="glow-dot"></div>
  </div>
  <div class="footer">Trade on SAGE</div>
</div>
</body>
</html>`;
}

export async function generateCard(type, data) {
  if (!puppeteer) throw new Error('Puppeteer not available');
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page    = await browser.newPage();
  await page.setViewport({ width: 380, height: 520, deviceScaleFactor: 2 });
  await page.setContent(buildHtml(type, data), { waitUntil: 'networkidle0' });
  const buffer = await page.screenshot({ type: 'png' });
  await browser.close();
  return buffer;
}
