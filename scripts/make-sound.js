/**
 * 生成提醒提示音 assets/notify.wav
 * 两段式清脆提示：A5(880Hz) → E6(1320Hz)，指数衰减，不带任何依赖。
 * 用法：node scripts/make-sound.js
 */
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const DURATION = 0.55;
const total = Math.floor(SAMPLE_RATE * DURATION);
const pcm = Buffer.alloc(total * 2);

function env(t) {
  // 快起 8ms，之后指数衰减
  const attack = Math.min(1, t / 0.008);
  return attack * Math.exp(-t * 6.5);
}

for (let i = 0; i < total; i++) {
  const t = i / SAMPLE_RATE;

  // 第一个音 880Hz，第二个音 1320Hz 从 0.13s 开始
  let v = 0;
  v += 0.55 * Math.sin(2 * Math.PI * 880 * t) * env(t);
  if (t > 0.13) {
    const t2 = t - 0.13;
    v += 0.6 * Math.sin(2 * Math.PI * 1320 * t2) * env(t2);
    // 加一点二次谐波，听起来更「叮」
    v += 0.18 * Math.sin(2 * Math.PI * 2640 * t2) * env(t2) * 0.5;
  }

  v = Math.max(-1, Math.min(1, v * 0.45));
  pcm.writeInt16LE(Math.round(v * 32767), i * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16); // fmt chunk size
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

const out = path.join(__dirname, '..', 'assets', 'notify.wav');
fs.writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`wrote ${out} (${(Buffer.concat([header, pcm]).length / 1024).toFixed(1)} KB)`);
