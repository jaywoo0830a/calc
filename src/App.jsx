import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Calculator from './pages/Calculator.jsx';
import Viewer from './pages/Viewer.jsx';
import Playground from './pages/Playground.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Calculator />} />
        <Route path="/viewer" element={<Viewer />} />
        <Route path="/playground" element={<Playground />} />
      </Routes>
    </BrowserRouter>
  );
}
