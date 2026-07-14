/**
 * API 测试脚本
 * [WHY] 验证各个基金API接口是否正常工作
 * [HOW] 运行: node scripts/test-api.mjs
 */

const testCode = '004253'  // 测试基金代码

console.log('========== 基金API测试 ==========\n')

// 测试1: 实时估值API
async function testFundEstimate() {
  console.log('1. 测试实时估值API...')
  try {
    const url = `http://fundgz.1234567.com.cn/js/${testCode}.js`
    const response = await fetch(url)
    const text = await response.text()
    
    // 解析 JSONP: jsonpgz({...})
    const match = text.match(/jsonpgz\((.*)\)/)
    if (match) {
      const data = JSON.parse(match[1])
      console.log('   ✅ 成功')
      console.log(`   基金名称: ${data.name}`)
      console.log(`   当前估值: ${data.gsz}`)
      console.log(`   涨跌幅: ${data.gszzl}%`)
      console.log(`   更新时间: ${data.gztime}`)
      return true
    } else {
      console.log('   ❌ 解析失败')
      return false
    }
  } catch (err) {
    console.log(`   ❌ 请求失败: ${err.message}`)
    return false
  }
}

// 测试2: 历史净值API
async function testNetValueHistory() {
  console.log('\n2. 测试历史净值API...')
  try {
    const url = `http://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=${testCode}&page=1&per=10`
    const response = await fetch(url)
    const text = await response.text()
    
    // 检查是否包含表格数据
    if (text.includes('<tr>') && text.includes('净值')) {
      console.log('   ✅ 成功')
      // 提取日期数量
      const dateMatches = text.match(/\d{4}-\d{2}-\d{2}/g)
      console.log(`   获取到 ${dateMatches?.length || 0} 条净值记录`)
      return true
    } else {
      console.log('   ❌ 数据格式错误')
      return false
    }
  } catch (err) {
    console.log(`   ❌ 请求失败: ${err.message}`)
    return false
  }
}

// 测试3: 基金详情API (pingzhongdata)
async function testPingzhongdata() {
  console.log('\n3. 测试基金详情API (pingzhongdata)...')
  try {
    const url = `http://fund.eastmoney.com/pingzhongdata/${testCode}.js`
    const response = await fetch(url)
    const text = await response.text()
    
    // 检查关键变量
    const hasData = text.includes('Data_netWorthTrend') || text.includes('fS_name')
    if (hasData) {
      console.log('   ✅ 成功')
      
      // 提取基金名称
      const nameMatch = text.match(/fS_name\s*=\s*"([^"]+)"/)
      if (nameMatch) {
        console.log(`   基金名称: ${nameMatch[1]}`)
      }
      
      // 提取基金代码
      const codeMatch = text.match(/fS_code\s*=\s*"([^"]+)"/)
      if (codeMatch) {
        console.log(`   基金代码: ${codeMatch[1]}`)
      }
      
      return true
    } else {
      console.log('   ❌ 数据不完整')
      return false
    }
  } catch (err) {
    console.log(`   ❌ 请求失败: ${err.message}`)
    return false
  }
}

// 测试4: 重仓股API
async function testStockHoldings() {
  console.log('\n4. 测试重仓股API...')
  try {
    const url = `http://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${testCode}&topline=10`
    const response = await fetch(url)
    const text = await response.text()
    
    if (text.includes('股票代码') || text.includes('持仓')) {
      console.log('   ✅ 成功')
      const stockMatches = text.match(/\d{6}/g)
      console.log(`   检测到 ${stockMatches?.length || 0} 个股票代码`)
      return true
    } else {
      console.log('   ⚠️ 可能是债券基金，无重仓股数据')
      return true
    }
  } catch (err) {
    console.log(`   ❌ 请求失败: ${err.message}`)
    return false
  }
}

// 测试5: 大盘指数API
async function testMarketIndex() {
  console.log('\n5. 测试大盘指数API...')
  try {
    const url = 'http://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001,0.399006&fields=f2,f3,f4,f12,f14'
    const response = await fetch(url)
    const data = await response.json()
    
    if (data && data.data && data.data.diff) {
      console.log('   ✅ 成功')
      data.data.diff.forEach(item => {
        console.log(`   ${item.f14}: ${item.f2} (${item.f3 >= 0 ? '+' : ''}${item.f3}%)`)
      })
      return true
    } else {
      console.log('   ❌ 数据格式错误')
      return false
    }
  } catch (err) {
    console.log(`   ❌ 请求失败: ${err.message}`)
    return false
  }
}

// 运行所有测试
async function runTests() {
  const results = []
  
  results.push(await testFundEstimate())
  results.push(await testNetValueHistory())
  results.push(await testPingzhongdata())
  results.push(await testStockHoldings())
  results.push(await testMarketIndex())
  
  console.log('\n========== 测试结果汇总 ==========')
  const passed = results.filter(r => r).length
  const total = results.length
  console.log(`通过: ${passed}/${total}`)
  
  if (passed === total) {
    console.log('✅ 所有API测试通过！')
  } else {
    console.log('⚠️ 部分API测试失败，请检查网络连接')
  }
}

runTests()
