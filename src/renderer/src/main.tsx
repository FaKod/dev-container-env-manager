import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { DetachedTerminalApp } from './components/DetachedTerminalApp'
import { ErrorBoundary } from './ErrorBoundary'
import './styles/global.css'

const detachedTerminalId = new URLSearchParams(window.location.search).get('detached')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {detachedTerminalId
        ? <DetachedTerminalApp terminalId={detachedTerminalId} />
        : <App />}
    </ErrorBoundary>
  </React.StrictMode>
)
