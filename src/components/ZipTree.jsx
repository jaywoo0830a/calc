import { useState } from 'react';

/** Builds a nested tree from flat file paths */
function buildTree(files) {
  const root = { name: '📦', children: {}, isDir: true };
  for (const [path, file] of Object.entries(files)) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      if (!node.children[part]) {
        node.children[part] = {
          name: part,
          children: isLast ? null : {},
          isDir: !isLast,
          file: isLast ? file : null,
          path: path,
        };
      }
      node = node.children[part];
    }
  }
  return root;
}

function TreeNode({ node, depth = 0, selectedPath, onSelect }) {
  const [open, setOpen] = useState(depth < 2);
  const isSelected = node.path === selectedPath;
  const isMarkdown = node.name.endsWith('.md');
  const isImage = /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(node.name);

  const icon = node.isDir ? (open ? '📂' : '📁') : isImage ? '🖼️' : '📄';

  return (
    <div>
      <div
        className={`zip-tree-item ${isSelected ? 'selected' : ''} ${isMarkdown || isImage ? 'clickable' : ''}`}
        style={{ paddingLeft: `${depth * 1.2 + 0.5}rem` }}
        onClick={() => {
          if (node.isDir) setOpen(!open);
          else if (isMarkdown || isImage) onSelect(node);
        }}
      >
        <span className="zip-tree-icon">{icon}</span>
        <span className="zip-tree-name">{node.name}</span>
      </div>
      {node.isDir && open && node.children &&
        Object.values(node.children).map((child, i) => (
          <TreeNode key={i} node={child} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
        ))
      }
    </div>
  );
}

export default function ZipTree({ tree, selectedPath, onSelect }) {
  if (!tree) return null;
  return (
    <div className="zip-tree">
      {Object.values(tree.children || {}).map((child, i) => (
        <TreeNode key={i} node={child} depth={0} selectedPath={selectedPath} onSelect={onSelect} />
      ))}
    </div>
  );
}
