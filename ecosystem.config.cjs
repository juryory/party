module.exports = {
  apps: [
    {
      name: 'party-share',
      script: 'server.js',
      cwd: '/www/wwwroot/party',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
