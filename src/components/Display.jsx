export default function Display({ expression, result, temp }) {
  return (
    <div className="calculator__display">
      {temp != null && (
        <span className="calculator__display-temp" title={`Temporary variable — T = ${temp}`}>T = {temp}</span>
      )}
      <div className="calculator__expression">{expression || '\u00A0'}</div>
      <div className="calculator__result">{result}</div>
    </div>
  );
}
