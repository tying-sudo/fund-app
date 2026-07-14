// [WHY] 预生成基金列表 JSON 文件，提升应用加载速度
// [WHAT] 从东方财富获取全量基金列表，保存到 public 目录
// [HOW] 使用 Node.js fetch API 获取数据并解析

import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function fetchFundList() {
  console.log('正在获取基金列表...')
  
  const url = 'http://fund.eastmoney.com/js/fundcode_search.js'
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    
    let text = await response.text()
    
    // [WHAT] 去掉 JS 变量声明，提取 JSON 数组
    // 原始格式：var r = [["000001","HXCZHH","华夏成长混合","混合型-偏股","HUAXIACHENGZHANGHUNHE"],...]
    text = text.replace(/^var\s+r\s*=\s*/, '').replace(/;?\s*$/, '')
    
    const rawList = JSON.parse(text)
    
    // [WHAT] 转换为结构化对象数组
    const fundList = rawList.map(item => ({
      code: item[0],        // 基金代码
      pinyin: item[1],      // 拼音简称
      name: item[2],        // 基金名称
      type: item[3],        // 基金类型
      fullPinyin: item[4]   // 拼音全称
    }))
    
    // [WHAT] 保存到 public 目录
    const outputPath = join(__dirname, '..', 'public', 'fund-list.json')
    writeFileSync(outputPath, JSON.stringify(fundList), 'utf-8')
    
    console.log(`成功获取 ${fundList.length} 只基金`)
    console.log(`已保存到: ${outputPath}`)
    
  } catch (error) {
    console.error('获取失败:', error.message)
    process.exit(1)
  }
}

fetchFundList()
