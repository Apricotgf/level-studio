// 把 index.html + style.css + geometry.js + app.js 打包成一个自包含的 HTML，
// 便于直接发到 iPad / 手机用浏览器打开（无需服务器、无需同级文件）。
// 改动源码后重新执行：node build-standalone.js
const fs = require('fs');
const path = require('path');
const dir = __dirname;

const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
// 防止内联内容里出现结束标签提前闭合
const safe = (s, tag) => s.replace(new RegExp('</' + tag, 'gi'), '<\\/' + tag);

let html = read('index.html');
const css = safe(read('style.css'), 'style');
const js = safe(read('geometry.js') + '\n;\n' + read('app.js'), 'script');
const icon = read('favicon.svg').replace(/\n/g, '').replace(/"/g, '&quot;');
const iconUri = 'data:image/svg+xml,' + encodeURIComponent(read('favicon.svg').replace(/\n/g, ''));

html = html.replace(/<link rel="icon"[^>]*>/, '<link rel="icon" href="' + iconUri + '">');
html = html.replace(/<link rel="stylesheet" href="style\.css">/, '<style>\n' + css + '\n</style>');
html = html.replace(/<script src="geometry\.js"><\/script>\s*<script src="app\.js"><\/script>/, '<script>\n' + js + '\n</script>');

if (html.includes('style.css') || html.includes('app.js')) throw new Error('内联失败：HTML 里仍引用外部文件');
const out = path.join(dir, 'level-studio-standalone.html');
fs.writeFileSync(out, html);
console.log('已生成 ' + path.basename(out) + '（' + (fs.statSync(out).size / 1024).toFixed(0) + ' KB）');
