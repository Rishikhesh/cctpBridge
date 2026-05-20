import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Apply persisted theme before React renders
const storedTheme = localStorage.getItem('cctp:theme') ?? 'dark'
document.documentElement.setAttribute('data-theme', storedTheme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
