declare module 'qrcode/lib/browser.js' {
  interface BrowserQrOptions {
    width: number
    margin: number
    errorCorrectionLevel: 'M'
    color: { dark: string; light: string }
  }

  const QRCode: {
    toDataURL(text: string, options: BrowserQrOptions): Promise<string>
  }
  export default QRCode
}
