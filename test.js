const fs = require('fs');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;
const html = fs.readFileSync('index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable" });
dom.window.onerror = function (msg, url, lineNo, columnNo, error) {
  console.log("ERROR:", msg, lineNo);
};
setTimeout(() => {
  console.log("Done checking.");
  process.exit(0);
}, 2000);
