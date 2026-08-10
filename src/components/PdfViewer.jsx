import PdfAnnotator from './PdfAnnotator.jsx';

/**
 * PDF 뷰어 — 어노테이션(형광펜, 밑줄, 주석) 지원
 * IndexedDB에 어노테이션 자동 저장/복원
 */
export default function PdfViewer({ url, filePath, initialPage, initialScrollTop }) {
  return (
    <PdfAnnotator
      url={url}
      filePath={filePath}
      initialPage={initialPage}
      initialScrollTop={initialScrollTop}
    />
  );
}
