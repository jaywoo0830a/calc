export default function Display({ expression, result }) {
  return (
    <div className="calculator__display">
      <div className="calculator__expression">{expression || '\u00A0'}</div>
      <div className="calculator__result">{result}</div>
    </div>
  );
}
