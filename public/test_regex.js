const href = "//quote.eastmoney.com/unify/r/116.00700";
const m = href.match(/\/r\/(\d+\.\d+)/);
console.log("匹配结果:", m);
console.log("股票代码:", m ? m[1] : "未匹配");
