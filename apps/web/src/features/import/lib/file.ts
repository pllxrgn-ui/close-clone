/*
 * Read a File as text. Native `Blob.text()` in the browser; a FileReader fallback
 * for the jsdom test runtime, whose File implementation lacks `.text()`. CSV is
 * text, so a UTF-8 decode is the right read for both the upload body and the
 * client-side preview parse.
 */
export function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('could not read file'));
    reader.readAsText(file);
  });
}
