export default function Display({ expression, result }) {
  return (
    <div className="display">
      <div className="expression">{expression || '\u00A0'}</div>
      <div className="result">{result}</div>
    </div>
  );
}
