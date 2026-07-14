// 调试解析逻辑
const testCode = '004253';

async function test() {
  const url = `http://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=${testCode}&page=1&per=10`;
  const response = await fetch(url);
  const text = await response.text();
  
  console.log('原始数据长度:', text.length);
  
  // 方法1: 使用原来的正则
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  
  let matchCount = 0;
  let match;
  while ((match = rowRegex.exec(text)) !== null) {
    const row = match[1];
    const cells = [];
    let cellMatch;
    
    // 关键：每次循环需要重置lastIndex
    cellRegex.lastIndex = 0;
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    
    if (cells.length >= 4 && /^\d{4}-\d{2}-\d{2}$/.test(cells[0])) {
      matchCount++;
      if (matchCount <= 3) {
        console.log(`记录${matchCount}:`, cells.slice(0, 4));
      }
    }
  }
  
  console.log('总共解析到:', matchCount, '条记录');
}

test();
