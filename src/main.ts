import './style.css'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('#app not found')

const standalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (window.navigator as Navigator & { standalone?: boolean }).standalone === true

const shareIcon = `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1v9M5 4l3-3 3 3M3 7v7h10V7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`

const installGuide = standalone
  ? ''
  : `<section class="guide">
  <h2>在 iPhone 上添加到主屏幕</h2>
  <p class="guide-lead">以下步骤在 <b>iPhone 的 Safari</b> 里操作。iOS 26 默认用「紧凑」布局，<b>分享按钮被收进了 ⋯ 里</b>，底部不再有单独的方框箭头图标。</p>
  <div class="ios-bar" aria-hidden="true">
    <span class="ios-pill">jancy0528.github.io</span>
    <span class="ios-more"><i></i><i></i><i></i></span>
    <span class="ios-tap">点这里</span>
  </div>
  <ol class="steps">
    <li><b>先让工具栏出现</b>：若底部只剩一条小胶囊或干脆不见了，向上滑一点点，或点一下屏幕最顶部的时间。</li>
    <li><b>点地址栏旁的 <span class="kbd">⋯</span></b>（更多）→ 在弹出菜单选 <b>共享 / Share</b> ${shareIcon}。若你的 Safari 是「底部」或「顶部」布局，工具栏上直接就有这个方框箭头图标。</li>
    <li><b>在分享列表里向下滑</b>，找到 <b>添加到主屏幕</b>，保持 <b>作为 Web App 打开</b> 开启，点右上角 <b>添加</b>。</li>
  </ol>
  <p class="guide-tip">列表里没有「添加到主屏幕」：把分享列表拉到底 → <b>编辑操作</b> → 把它加进来。也请确认是在 Safari 里，而不是微信／聊天窗口的内嵌浏览器。</p>
  <p class="guide-tip">想让分享按钮长期常驻底部：设置 → App → Safari → 标签页 → 选 <b>底部</b>。</p>
</section>`

const installedNote = standalone
  ? `<p class="ok">已从主屏图标启动，安装成功。首次联网启动完成后即可离线使用。</p>`
  : ''

app.innerHTML = `
  <main class="boot">
    <h1>K线回放训练</h1>
    <p class="sub">离线单机 · 历史日线逐根回放</p>
    <section class="status">
      <div><span>运行模式</span><b>${standalone ? '主屏应用' : '浏览器'}</b></div>
      <div><span>部署路径</span><b>${import.meta.env.BASE_URL}</b></div>
      <div><span>离线能力</span><b>${'serviceWorker' in navigator ? '可用' : '不可用'}</b></div>
    </section>
    ${installedNote}
    ${installGuide}
    <p class="hint">工程骨架已就绪，回放引擎与图表接入中。</p>
  </main>
`

// 只在生产构建注册，避免开发时被旧缓存挡住热更新
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch((err) => console.warn('[sw] register failed', err))
  })
}
