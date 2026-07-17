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

export default function Keypad({ onAction }) {
  return (
    <div className="calculator__keypad">
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
  );
}
