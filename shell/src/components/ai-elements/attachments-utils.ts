export const ATTACHMENT_COUNT_LIMIT = 8;

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function encodeChatAttachments(files: readonly File[]) {
  return Promise.all(files.map(async file => ({
    name: file.name,
    type: file.type,
    data: await fileToBase64(file),
  })));
}
