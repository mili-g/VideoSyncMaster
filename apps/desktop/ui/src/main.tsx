import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { logUiDebug } from './utils/frontendLogger'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

window.api.onMainProcessMessage((message) => {
  logUiDebug('收到主进程消息', {
    domain: 'ui.bootstrap',
    action: 'onMainProcessMessage',
    detail: String(message)
  })
})
