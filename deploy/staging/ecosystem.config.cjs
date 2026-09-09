module.exports = {
  apps: [
    {
      name: "ai-research-staging",
      cwd: "/var/www/ai-research-assistant-staging",
      script: "node_modules/next/dist/bin/next",
      args: "start --hostname 127.0.0.1 --port 3001",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: "3001",
        HOSTNAME: "127.0.0.1",
      },
    },
  ],
};
