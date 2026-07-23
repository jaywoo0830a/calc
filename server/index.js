import express from 'express';
import multer from 'multer';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB

app.post('/pdf', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file' });

  const id = randomUUID();
  const tmpDir = join(tmpdir(), 'calc-pdf-' + id);
  const pdfPath = join(tmpDir, 'input.pdf');

  try {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(pdfPath, req.file.buffer);

    // Step 1: pdftotext → HTML (물리적 레이아웃 + 메타데이터 추출)
    const rawHtml = await new Promise((resolve, reject) => {
      execFile('pdftotext', ['-layout', '-htmlmeta', pdfPath, '-'], {
        timeout: 30000,
        maxBuffer: 50 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });

    // Step 2: pandoc → 고품질 GFM Markdown
    const md = await new Promise((resolve, reject) => {
      const child = execFile('pandoc', [
        '-f', 'html+tex_math_dollars',
        '-t', 'gfm+tex_math_dollars',
        '--wrap=none',                    // 줄바꿈 없음 (컬럼 제한 무시)
        '--standalone=false',
        '--markdown-headings=atx',
        '--eol=lf',
      ], {
        timeout: 30000,
        maxBuffer: 50 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
      child.stdin.write(rawHtml);
      child.stdin.end();
    });

    res.type('text').send(md);
  } catch (e) {
    console.error('pdftotext error:', e.message);
    res.status(500).json({ error: 'PDF conversion failed: ' + e.message });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// health check
app.get('/api/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`calc-api running on :${PORT}`));
