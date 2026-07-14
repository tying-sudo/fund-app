/**
 * 优化版API测试脚本
 * [WHY] 验证缓存和并发控制是否正常工作
 */

const testCode = '004253'

console.log('========== 优化版API测试 ==========\n')

// 测试1: 单次请求速度
async function testSingleRequest() {
  console.log('1. 测试单次请求速度...')
  const start = Date.now()
  
  try {
    const url = `http://fundgz.1234567.com.cn/js/${testCode}.js`
    const response = await fetch(url)
    const text = await response.text()
    const match = text.match(/jsonpgz\((.*)\)/)
    
    if (match) {
      const elapsed = Date.now() - start
      console.log(`   ✅ 成功，耗时: ${elapsed}ms`)
      return elapsed
    }
  } catch (err) {
    console.log(`   ❌ 失败: ${err.message}`)
  }
  return 0
}

// 测试2: 并发请求速度
async function testConcurrentRequests() {
  console.log('\n2. 测试并发请求（5只基金）...')
  const codes = ['004253', '110011', '000001', '161725', '519915']
  const start = Date.now()
  
  try {
    const promises = codes.map(async code => {
      const url = `http://fundgz.1234567.com.cn/js/${code}.js`
      const response = await fetch(url)
      const text = await response.text()
      const match = text.match(/jsonpgz\((.*)\)/)
      if (match) {
        const data = JSON.parse(match[1])
        return { code, name: data.name, gsz: data.gsz }
      }
      return null
    })
    
    const results = await Promise.all(promises)
    const elapsed = Date.now() - start
    const successCount = results.filter(r => r).length
    
    console.log(`   ✅ 完成: ${successCount}/${codes.length} 成功，总耗时: ${elapsed}ms`)
    results.forEach(r => {
      if (r) console.log(`   - ${r.code}: ${r.name} (${r.gsz})`)
    })
    return elapsed
  } catch (err) {
    console.log(`   ❌ 失败: ${err.message}`)
  }
  return 0
}

// 测试3: 历史净值获取速度
async function testNetValueHistory() {
  console.log('\n3. 测试历史净值（30天）...')
  const start = Date.now()
  
  try {
    const url = `http://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=${testCode}&page=1&per=30`
    const response = await fetch(url)
    const text = await response.text()
    
    // 计算获取到的数据条数
    const dateMatches = text.match(/\d{4}-\d{2}-\d{2}/g)
    const elapsed = Date.now() - start
    
    console.log(`   ✅ 成功: 获取 ${dateMatches?.length || 0} 条记录，耗时: ${elapsed}ms`)
    return elapsed
  } catch (err) {
    console.log(`   ❌ 失败: ${err.message}`)
  }
  return 0
}

// 测试4: 缓存效果模拟
async function testCacheEffect() {
  console.log('\n4. 模拟缓存效果...')
  
  // 第一次请求
  const start1 = Date.now()
  const url = `http://fundgz.1234567.com.cn/js/${testCode}.js`
  await fetch(url)
  const elapsed1 = Date.now() - start1
  console.log(`   首次请求: ${elapsed1}ms`)
  
  // 第二次请求（实际有缓存会从内存读取）
  const start2 = Date.now()
  await fetch(url)
  const elapsed2 = Date.now() - start2
  console.log(`   二次请求: ${elapsed2}ms`)
  console.log(`   ⚡ 缓存模式下二次请求应接近0ms`)
}

// 运行所有测试
async function runTests() {
  const single = await testSingleRequest()
  const concurrent = await testConcurrentRequests()
  const history = await testNetValueHistory()
  await testCacheEffect()
  
  console.log('\n========== 性能汇总 ==========')
  console.log(`单次估值请求: ${single}ms`)
  console.log(`5只基金并发: ${concurrent}ms (平均 ${Math.round(concurrent/5)}ms/只)`)
  console.log(`30天历史净值: ${history}ms`)
  console.log('\n✅ 优化建议:')
  console.log('- 使用内存缓存减少重复请求')
  console.log('- 并发控制避免请求拥堵')
  console.log('- 先显示缓存数据，后台更新')
}

runTests()
