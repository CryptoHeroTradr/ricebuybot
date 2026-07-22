module.exports = {
  apps: [
    {
      name: 'ricebuybot',
      script: 'dist/src/index.js',
      cwd: __dirname,
      // Node 22 loads .env natively — no dotenv dependency. Secrets stay in the file,
      // out of the PM2 process list and out of `pm2 describe` output.
      node_args: ['--env-file-if-exists=.env'],
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',

      // The WS ingestor holds one connection and the SQLite writer is single-threaded.
      // A second instance would double-post and fight over the WAL. Never scale this out.
      watch: false,

      // Give SIGTERM time to drain in-flight Telegram sends before PM2 escalates to SIGKILL.
      kill_timeout: 20000,
      listen_timeout: 10000,
      wait_ready: false,

      env: {
        NODE_ENV: 'production',
      },

      error_file: 'logs/err.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      time: false, // pino already timestamps; PM2 prefixing would double it
    },
  ],
};
