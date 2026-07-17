import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.scss';

// Register service worker (PWA)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js');
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
