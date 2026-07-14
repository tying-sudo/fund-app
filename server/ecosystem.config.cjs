/**
 * PM2 进程管理配置
 * [WHY] 生产环境需要进程守护、自动重启、日志管理
 * [HOW] pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [{
    name: 'fund-proxy',
    script: 'server.mjs',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    // 自动重启
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    // 内存限制
    max_memory_restart: '256M',
    // 日志
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    // 优雅关闭
    kill_timeout: 5000,
    listen_timeout: 10000
  }]
}
