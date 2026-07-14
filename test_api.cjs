// 测试天天基金API
const https = require('https');

const testCodes = ['000001', '110011', '001632'];

for (const code of testCodes) {
  const url = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  
  https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      console.log(`\n=== 基金 ${code} ===`);
      console.log('响应:', data.substring(0, 200));
    });
  }).on('error', (err) => {
    console.error(`基金 ${code} 请求失败:`, err.message);
  });
}
