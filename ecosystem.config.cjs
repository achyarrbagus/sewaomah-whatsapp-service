// PM2 app for the Omi WhatsApp gateway. Exactly ONE instance: two processes on
// the same WhatsApp session corrupt it (the session lock also enforces this).
//
// Secrets are loaded by Node from an env file at start (not stored in PM2's
// saved process list). Override the path with OMI_GATEWAY_ENV_FILE when running
// `pm2 start ecosystem.config.cjs`.
const envFile = process.env.OMI_GATEWAY_ENV_FILE || '/etc/sewaomah-whatsapp-service/env';

module.exports = {
  apps: [
    {
      name: 'omi-gateway',
      cwd: __dirname,
      script: 'src/index.js',
      node_args: `--env-file=${envFile}`,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // let SIGINT/SIGTERM close Chromium (client.destroy) before SIGKILL
      kill_timeout: 20000,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '1500M',
      merge_logs: true,
      time: true,
    },
  ],
};
