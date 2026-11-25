/**
 * 解码 Windows 原生命令输出；UTF-8 是现代 Node/WSL 的默认值，GBK 是传统 Windows 控制台的常见输出编码。
 * 只有 UTF-8 已出现替换字符时才切换到 GBK，避免把正常 UTF-8 文本误解码。
 */
export function decodeProcessOutput(buffer) {
  if (buffer.includes(0)) return buffer.toString('utf16le').replaceAll(String.fromCharCode(0), '')
  const utf8 = buffer.toString('utf8')
  if (process.platform !== 'win32' || !utf8.includes(String.fromCharCode(0xfffd))) return utf8
  return new TextDecoder('gbk').decode(buffer)
}
