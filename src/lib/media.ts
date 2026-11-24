// 客户端媒体处理：图片压缩、录音、格式工具

export async function compressImage(file: File, maxSide = 1600, quality = 0.82): Promise<{ blob: Blob; width: number; height: number; ext: string }> {
  const bitmapUrl = URL.createObjectURL(file)
  try {
    const img = await loadImage(bitmapUrl)
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('画布不可用')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('压缩失败'))), 'image/jpeg', quality)
    })
    return { blob, width: w, height: h, ext: 'jpg' }
  } finally {
    URL.revokeObjectURL(bitmapUrl)
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片读取失败'))
    img.src = src
  })
}

export function pickAudioMime(): { mime: string; ext: string } {
  const candidates: Array<{ mime: string; ext: string }> = [
    { mime: 'audio/webm;codecs=opus', ext: 'webm' },
    { mime: 'audio/webm', ext: 'webm' },
    { mime: 'audio/mp4', ext: 'm4a' },
    { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
  ]
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c.mime)) return c
  }
  return { mime: '', ext: 'webm' }
}

export function extFromName(name: string, fallback = 'bin'): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(name)
  return m ? m[1].toLowerCase() : fallback
}

export function isImageMime(mime: string | null | undefined): boolean {
  return !!mime && mime.startsWith('image/')
}

export function fileIcon(name: string, mime: string | null | undefined): string {
  if (isImageMime(mime)) return '🖼️'
  const ext = extFromName(name)
  if (['pdf'].includes(ext)) return '📕'
  if (['doc', 'docx'].includes(ext)) return '📄'
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊'
  if (['ppt', 'pptx'].includes(ext)) return '📽️'
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️'
  if (['mp4', 'mov', 'mkv', 'avi'].includes(ext)) return '🎬'
  if (['mp3', 'wav', 'm4a', 'aac'].includes(ext)) return '🎵'
  return '📎'
}