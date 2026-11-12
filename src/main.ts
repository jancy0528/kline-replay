import './style.css'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('#app not found')

const standalone =
  window.matchMedia('(display-mode: standalone)').matches ||
  (window.navigator as Navigator & { standalone?: boolean }).standalone === true

app.innerHTML = `
  <main class="boot">
    <h1>K线回放训练</h1>
    <p class="sub">离线单机 · 历史日线逐根回放</p>
    <section class="status">
      <div><span>运行模式</span><b>${standalone ? '主屏应用' : '浏览器'}</b></div>
      <div><span>部署路径</span><b>${import.meta.env.BASE_URL}</b></div>
      <div><span>离线能力</span><b>${'serviceWorker' in navigator ? '可用' : '不可用'}</b></div>
    </section>
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
