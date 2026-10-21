// Central configuration. Overrides are honoured only on localhost (for the mock server).
export const CONFIG = {
  OWNER: 'micknotthemouse',
  REPO: 'popur-control',
  API: 'https://cloud.popur.com.cn',
  WSS: 'wss://cloud.popur.com.cn/mqtt',
  DATA: 'https://raw.githubusercontent.com/micknotthemouse/popur-control/data/',
  REPO_URL: 'https://github.com/micknotthemouse/popur-control',
  ACTIONS_URL: 'https://github.com/micknotthemouse/popur-control/actions/workflows/collect.yml',
  SECRETS_URL: 'https://github.com/micknotthemouse/popur-control/settings/secrets/actions',
  PAGES_URL: 'https://micknotthemouse.github.io/popur-control/',
  LW_MODE: null,
  RESET_UTC_MIN: 960,
  HANDOFF_SPKI: 'MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAnUDnhmG+5C5gljBqn4C9/C4cWKGUAujpLYa3PpBp14PoZv4JIsQdiNv+cFL7oYM0+cDt0RzWhI/ZvMwg4a3XhotsvCUAoQPqOo3/45AtMUbYYsUHtLW6h3H5/lN4BH8X9tvcRF2KnnuYJK3YNXqs0x4Tcu6RXPI0iggru+V5yY3MoDKhQH8x3EwtqFhdxX0B+7VNsQfHnzpNDQMM61kYkWjJQECDr7eojIMSRFpYGJcF8FfvVTy/T+ata6MsfuGuZJsSJ6ds4/Sv0qcHV75fbjH/mpvED8ASri+XaZfnB/x8yFGyQVpMjSmX/Tq3wVfA6t0uzBKddErZOx9A9za1v2KtuENF3AISw7GGewkWZuAquDWhzWZNcOpciMRhQtUQ7h1I9eTzBiGIIaIstUevXl5JH27RpTaGSM0XmMCHfoXrVlUS+vIvtQfI84p6jZjGOthtc+hDEhyKRgtp865+CxmORFXy0R+wwsamkWshi7eIWgmjLm2bXZ112Jz3aeOlAgMBAAE=',
  POLL_MS: 30000,
  PROGRESS_POLL_MS: 5000,
  PROGRESS_MAX_MS: 150000,
};

// loc: a Location-like object ({hostname, search}). Returns the effective config.
export function applyOverrides(loc) {
  const host = loc && loc.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') return CONFIG;
  const q = new URLSearchParams(loc.search || '');
  const out = { ...CONFIG };
  if (q.get('api')) out.API = q.get('api');
  if (q.get('wss')) out.WSS = q.get('wss');
  if (q.get('data')) out.DATA = q.get('data');
  return out;
}
