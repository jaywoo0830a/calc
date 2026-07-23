import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Calculator from './pages/Calculator.jsx';
import Viewer from './pages/Viewer.jsx';
import Proxy from './pages/Proxy.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Calculator />} />
        <Route path="/viewer" element={<Viewer />} />
        <Route path="/proxy" element={<Proxy />} />
      </Routes>
    </BrowserRouter>
  );
}
