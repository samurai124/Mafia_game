// sounds.js — Web Audio API sound effects (no external files needed)
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let ctx = null;

function getCtx() {
  if (!ctx) ctx = new AudioCtx();
  return ctx;
}

function playTone(freq, duration, type = 'sine', volume = 0.3) {
  try {
    const c = getCtx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.connect(gain);
    gain.connect(c.destination);
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
    osc.start(c.currentTime);
    osc.stop(c.currentTime + duration);
  } catch (e) {}
}

window.playSound = function(type) {
  switch (type) {
    case 'gamestart':
      playTone(440, 0.15); setTimeout(() => playTone(550, 0.15), 150); setTimeout(() => playTone(660, 0.3), 300); break;
    case 'night':
      playTone(200, 0.5, 'sine', 0.2); setTimeout(() => playTone(150, 0.8, 'sine', 0.15), 400); break;
    case 'day':
      playTone(523, 0.2); setTimeout(() => playTone(659, 0.2), 200); setTimeout(() => playTone(784, 0.4), 400); break;
    case 'vote':
      playTone(330, 0.1); setTimeout(() => playTone(330, 0.1), 150); break;
    case 'defense':
      playTone(440, 0.2, 'triangle'); setTimeout(() => playTone(350, 0.4, 'triangle'), 200); break;
    case 'eliminate':
      playTone(220, 0.2); setTimeout(() => playTone(180, 0.2), 200); setTimeout(() => playTone(140, 0.5), 400); break;
    case 'gameover':
      playTone(523, 0.3); setTimeout(() => playTone(440, 0.3), 300); setTimeout(() => playTone(349, 0.6), 600); break;
    case 'notification':
      playTone(660, 0.1); setTimeout(() => playTone(880, 0.15), 120); break;
  }
};
