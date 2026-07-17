import { useState } from 'react';

function TreeNode({ node, depth = 0, selectedPath, onSelect }) {
  const [open, setOpen] = useState(depth < 2);
  const isSelected = node.path === selectedPath;
  const isMarkdown = node.name.endsWith('.md');
  const isImage = /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(node.name);

  let icon = '';
  if (node.isDir) {
    icon = open ? '📂 ' : '📁 ';
  } else if (isImage) {
    icon = '🖼️ ';
  } else if (isMarkdown) {
    icon = '📝 ';
  } else {
    icon = '📄 ';
  }

  const cls = [
    'tree__item',
    isSelected ? 'tree__item--selected' : '',
    'tree__item--clickable',
  ].filter(Boolean).join(' ');

  return (
    <div>
      <div className={cls}
        style={{ paddingLeft: `${depth * 1.2 + 0.5}rem` }}
        onClick={() => { if (node.isDir) setOpen(!open); else onSelect(node); }}>
        <span className="tree__icon">{icon}</span>
        <span className="tree__name">{node.name}</span>
      </div>
      {node.isDir && open && node.children &&
        Object.values(node.children).map((c, i) => (
          <TreeNode key={i} node={c} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
        ))
      }
    </div>
  );
}

export default function ZipTree({ tree, selectedPath, onSelect }) {
  if (!tree) return null;
  return (
    <div className="tree">
      {Object.values(tree.children || {}).map((child, i) => (
        <TreeNode key={i} node={child} depth={0} selectedPath={selectedPath} onSelect={onSelect} />
      ))}
    </div>
  );
}
