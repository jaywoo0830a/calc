const BUTTONS = [
  ['clear',     '🗑️',  'func'],
  ['negate',    '±',   'func'],
  ['backspace', '\u25C0',  'func'],
  ['operator',  '\u00F7',  'op', 'div'],

  ['digit', '7', 'num', '7'],
  ['digit', '8', 'num', '8'],
  ['digit', '9', 'num', '9'],
  ['operator', '\u00D7', 'op', 'mul'],

  ['digit', '4', 'num', '4'],
  ['digit', '5', 'num', '5'],
  ['digit', '6', 'num', '6'],
  ['operator', '\u2212', 'op', 'sub'],

  ['digit', '1', 'num', '1'],
  ['digit', '2', 'num', '2'],
  ['digit', '3', 'num', '3'],
  ['operator', '+', 'op', 'add'],

  ['digit',   '0', 'num zero', '0'],
  ['decimal', '.', 'num'],
  ['equals',  '=', 'eq'],
];

// ── 공학용 키패드 ─────────────────────────────────────────────
// INV(2nd)를 켜면 sin/cos/tan/log/ln 키가 역함수로 바뀐다.
const ENG_KEYS = [
  ['unary', 'sin'], ['unary', 'cos'], ['unary', 'tan'], ['unary', 'log'],
  ['unary', 'ln'],  ['unary', 'sqrt'], ['unary', 'square'], ['unary', 'cube'],
  ['operator', 'pow'], ['unary', '10x'], ['unary', 'ex'], ['unary', 'factorial'],
  ['unary', 'inv'], ['unary', 'abs'], ['const', 'pi'], ['const', 'e'],
  ['toggleInv', 'inv'], ['mem', 'clear'], ['mem', 'recall'], ['mem', 'add'],
];

const ENG_LABEL = {
  sin: 'sin', cos: 'cos', tan: 'tan', log: 'log', ln: 'ln',
  sqrt: '\u221A', square: 'x\u00B2', cube: 'x\u00B3', pow: 'x\u02B8',
  '10x': '10\u02E3', ex: 'e\u02E3', factorial: 'n!',
  inv: '1/x', abs: '|x|', pi: '\u03C0', e: 'e',
};
const INV_FN = { sin: 'asin', cos: 'acos', tan: 'atan', log: '10x', ln: 'ex' };
const INV_LABEL = { sin: 'sin\u207B\u00B9', cos: 'cos\u207B\u00B9', tan: 'tan\u207B\u00B9', log: '10\u02E3', ln: 'e\u02E3' };

export default function Keypad({ onAction, sciMode, invMode }) {
  return (
    <div className="calculator__keypad-area">
      {sciMode && (
        <div className="calculator__keypad calculator__keypad--eng">
          {ENG_KEYS.map(([action, key], i) => {
            let label, value = key, mod = 'sci';
            if (action === 'toggleInv') {
              label = invMode ? '2nd' : 'INV';
              mod += invMode ? ' sci--active' : '';
            } else if (action === 'mem') {
              label = key === 'clear' ? 'MC' : key === 'recall' ? 'MR' : 'M+';
            } else {
              const inv = invMode && INV_FN[key];
              label = ENG_LABEL[key] || key;
              if (inv) { value = inv; label = INV_LABEL[key] || label; }
            }
            return (
              <div
                key={'eng-' + i}
                className={`calculator__btn calculator__btn--${mod}`}
                role="button"
                tabIndex={0}
                onClick={() => onAction(action, value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onAction(action, value);
                  }
                }}
              >
                {label}
              </div>
            );
          })}
        </div>
      )}
      <div className={'calculator__keypad' + (sciMode ? ' calculator__keypad--basic' : '')}>
        {BUTTONS.map(([action, label, mod, value], i) => (
          <div
            key={i}
            className={`calculator__btn calculator__btn--${mod}`}
            role="button"
            tabIndex={0}
            onClick={() => onAction(action, value ?? label)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onAction(action, value ?? label);
              }
            }}
          >
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}
