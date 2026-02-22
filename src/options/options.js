import { DEFAULT_CONFIG } from '../content/config.js';

const FIELDS = Object.keys(DEFAULT_CONFIG);

function loadConfig() {
  chrome.storage.sync.get('config', result => {
    const cfg = Object.assign({}, DEFAULT_CONFIG, result.config || {});
    FIELDS.forEach(key => {
      const el = document.getElementById(key);
      if (el) el.value = cfg[key];
    });
  });
}

function saveConfig() {
  const cfg = {};
  FIELDS.forEach(key => {
    const el = document.getElementById(key);
    if (el) cfg[key] = parseFloat(el.value);
  });

  chrome.storage.sync.set({ config: cfg }, () => {
    const msg = document.getElementById('save-msg');
    msg.classList.add('visible');
    setTimeout(() => { msg.classList.remove('visible'); }, 1500);
  });
}

function resetDefaults() {
  FIELDS.forEach(key => {
    const el = document.getElementById(key);
    if (el) el.value = DEFAULT_CONFIG[key];
  });
  chrome.storage.sync.set({ config: DEFAULT_CONFIG }, () => {
    const msg = document.getElementById('save-msg');
    msg.textContent = 'Reset to defaults';
    msg.classList.add('visible');
    setTimeout(() => {
      msg.classList.remove('visible');
      msg.textContent = 'Saved';
    }, 1500);
  });
}

document.getElementById('save-btn').addEventListener('click', saveConfig);
document.getElementById('reset-btn').addEventListener('click', resetDefaults);

loadConfig();
