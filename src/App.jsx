import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Calculator from './pages/Calculator.jsx';
import Viewer from './pages/Viewer.jsx';
import Playground from './pages/Playground.jsx';
import MathSpace from './pages/MathSpace.jsx';
import CustomCursor from './components/CustomCursor.jsx';
import WordLookup from './components/WordLookup.jsx';
import RangeSelect from './components/RangeSelect.jsx';
import RecentNav from './components/RecentNav.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <CustomCursor />
      <WordLookup />
      <RangeSelect />
      <RecentNav />
      <Routes>
        <Route path="/" element={<Calculator />} />
        <Route path="/viewer" element={<Viewer />} />
        <Route path="/playground" element={<Playground />} />
        <Route path="/math" element={<MathSpace />} />
      </Routes>
    </BrowserRouter>
  );
}
