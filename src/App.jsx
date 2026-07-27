import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Calculator from './pages/Calculator.jsx';
import Viewer from './pages/Viewer.jsx';
import Playground from './pages/Playground.jsx';
import MathSpace from './pages/MathSpace.jsx';
import CustomCursor from './components/CustomCursor.jsx';
import Footer from './components/Footer.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <CustomCursor />
      <div className="app-shell">
        <Routes>
          <Route path="/" element={<Calculator />} />
          <Route path="/viewer" element={<Viewer />} />
          <Route path="/playground" element={<Playground />} />
          <Route path="/math" element={<MathSpace />} />
        </Routes>
        <Footer />
      </div>
    </BrowserRouter>
  );
}
