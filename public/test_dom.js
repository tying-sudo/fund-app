const { JSDOM } = require('jsdom');

const content = `<div class='box'><div class='boxitem w790'><h4 class='t'><label class='left'><a  title='华泰紫金恒生互联网科技业指数型发起基金(QDII)C' href='http://fund.eastmoney.com/018524.html'>华泰紫金恒生互联网科技业指数型发起基金...</a>&nbsp;&nbsp;2026年1季度股票投资明细</label><label class='right lab2 xq505'>&nbsp;&nbsp;&nbsp;&nbsp;来源：天天基金&nbsp;&nbsp;&nbsp;&nbsp;截止至：<font class='px12'>2026-03-31</font></label></h4><div class='space0'></div><table class='w782 comm tzxq'><thead><tr><th class='first' style='width:34px'>序号</th><th>股票代码</th><th>股票名称</th><th style='width:75px'>最新价</th><th style='width:75px'>涨跌幅</th><th style='width: 110px;'>相关资讯</th><th>占净值比例</th><th class='cgs'>持股数<br />（万股）</th><th class='last ccs'>持仓市值<br />（万元人民币）</th></tr></thead><tbody><tr><td>1</td><td class='toc'><a href='//quote.eastmoney.com/unify/r/116.00700' >00700</a></td><td class='toc' style='line-height:18px'><a href='//quote.eastmoney.com/unify/r/116.00700'>腾讯控股</a></td><td class='toc' ><span data-id='dq00700'>--</span></td><td class='toc' ><span data-id='zd00700'>--</span></td><td class='xglj'><a href='//guba.eastmoney.com/interface/GetList.aspx?code=116.00700' >股吧</a><a href='//quote.eastmoney.com/unify/r/116.00700' >行情</a></td><td class='toc'>14.48%</td><td class='toc'>9.03</td><td class='toc'>3,858.95</td></tr></tbody></table></div></div>`;

const dom = new JSDOM(content);
const doc = dom.window.document;

doc.querySelectorAll('tbody tr').forEach((row, i) => {
  const c = row.querySelectorAll('td');
  console.log(`行 ${i}: 列数=${c.length}`);
  c.forEach((td, j) => {
    console.log(`  列 ${j}: ${td.textContent.trim().substring(0, 50)}`);
  });
  
  if (c.length >= 7) {
    const name = c[2]?.textContent?.trim();
    const pct = parseFloat(c[6]?.textContent?.trim());
    const link = c[1]?.querySelector('a');
    const href = link?.getAttribute('href') || '';
    const m = href.match(/\/r\/(\d+\.\d+)/);
    const stockCode = m ? m[1] : '';
    
    console.log(`解析结果: name=${name}, pct=${pct}, stockCode=${stockCode}`);
  }
});
